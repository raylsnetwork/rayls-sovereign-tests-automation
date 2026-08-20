import { LOGGER } from '../../src/config/env-config';
import { delay } from '../../src/utils/common';
import { compose } from '../../src/utils/docker-compose';
import { FaultInjector } from '../../src/utils/fault-injector';

export interface CrashObservation {
  crashCount: number; // distinct times the service went down (a SIGSEGV freezes it under dlv)
  restarts: number; // restarts we issued to recover it (cloud-orchestrator sim)
  delivered: boolean; // did the delivery predicate ever become true?
  firstCrashAtS: number | null;
  deliveredAtS: number | null;
}

export interface ObserveCrashLoopOptions {
  service: string; // compose service to watch and restart, e.g. 'relayer-b'
  checkDelivered: () => Promise<boolean>; // non-throwing: has the awaited side effect landed?
  deadlineMs: number; // total observation window
  pollMs?: number; // gap between observation iterations (default 4000)
  confirmProbes?: number; // consecutive failed liveness probes to count one crash (default 2)
  confirmGapMs?: number; // gap between the confirmation probes (default 1000)
  crashLoopConfirm?: number; // stop early once this many distinct crashes prove a loop (default 3)
  recoveryWaitMs?: number; // per-restart wait for the FI API to answer again (default 60000)
}

// Watches a relayer's fault-injection liveness endpoint over a window: counts
// each confirmed crash (the FI API goes unreachable when a SIGSEGV freezes the
// process under dlv), restarts the container on each crash (mirroring a cloud
// orchestrator's auto-restart), and records whether `checkDelivered` ever
// becomes true. Stops early once the outcome is decided — no crash + delivered
// (healthy), or `crashLoopConfirm` crashes reached (crash-loop demonstrated).
//
// This is a stateful, side-effecting observation (probe + restart + delivery
// check with two distinct early-exits) that the eventually/never primitives
// cannot express, so it lives here as a shared, named helper rather than as a
// bespoke loop inlined in a test file.
export async function observeRelayerCrashLoop(
  fi: FaultInjector,
  opts: ObserveCrashLoopOptions,
): Promise<CrashObservation> {
  const pollMs = opts.pollMs ?? 4_000;
  const confirmProbes = opts.confirmProbes ?? 2;
  const confirmGapMs = opts.confirmGapMs ?? 1_000;
  const crashLoopConfirm = opts.crashLoopConfirm ?? 3;
  const recoveryWaitMs = opts.recoveryWaitMs ?? 60_000;

  const start = Date.now();
  const end = start + opts.deadlineMs;
  const elapsedS = (): number => Number(((Date.now() - start) / 1000).toFixed(1));

  let prevAlive = true;
  let crashCount = 0;
  let restarts = 0;
  let delivered = false;
  let firstCrashAtS: number | null = null;
  let deliveredAtS: number | null = null;

  // Treat the service as DOWN only after `confirmProbes` consecutive failed
  // probes, so a single slow/timed-out isAlive() under CI load does not
  // false-count a crash. A live process answers the first probe and returns
  // early; a frozen (SIGSEGV-under-dlv) process fails every probe.
  const confirmedDown = async (): Promise<boolean> => {
    for (let i = 0; i < confirmProbes; i++) {
      if (await fi.isAlive()) return false;
      if (i < confirmProbes - 1) await delay(confirmGapMs);
    }
    return true;
  };

  while (Date.now() < end) {
    const down = await confirmedDown();
    const alive = !down;
    if (prevAlive && down) {
      crashCount++;
      if (firstCrashAtS === null) firstCrashAtS = elapsedS();
      LOGGER.log(`      >>> ${opts.service} crash #${crashCount} observed after ${elapsedS()}s <<<`);
    }
    prevAlive = alive;

    if (down) {
      try {
        compose.restart(opts.service);
        restarts++;
        LOGGER.log(`      restart #${restarts} of ${opts.service} (orchestrator auto-restart sim); waiting for it to come up...`);
        await fi.waitUntilAlive(recoveryWaitMs);
        prevAlive = true;
      } catch {
        // May re-crash before/at waitUntilAlive on the buggy code; keep looping.
      }
    }

    if (!delivered && (await opts.checkDelivered())) {
      delivered = true;
      deliveredAtS = elapsedS();
      LOGGER.log(`      delivery predicate satisfied after ${deliveredAtS}s`);
    }

    if (delivered && crashCount === 0) break; // healthy outcome decided
    if (crashCount >= crashLoopConfirm) break; // crash-loop demonstrated

    await delay(pollMs);
  }

  return { crashCount, restarts, delivered, firstCrashAtS, deliveredAtS };
}
