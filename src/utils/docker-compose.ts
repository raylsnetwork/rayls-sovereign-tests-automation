/**
 * @title docker-compose helpers for resilience / chaos tests
 *
 * Used by tests under `test/e2e/security/resilience/` to start, stop, restart, and kill
 * the relayer (or other compose services) at controlled points in a flow. Always pair with
 * the relayer's fault-injection HTTP API (`src/utils/fault-injector.ts`) when the goal is
 * to exercise an internal code path — direct container control is for the cases where the
 * fault must be observable from outside (e.g., NATS redelivery on container exit).
 *
 * The relayer repo is resolved via the `DOCKER_COMPOSE_DIR` env var, falling back to
 * `../rayls-privacy-relayer-api` (the layout assumed by `start_dev.sh`). When a test runs
 * via `npm run test:resilience` the working directory is the tests-automation repo root,
 * so the default works.
 */

import { execFileSync, spawnSync } from 'child_process';
import path from 'path';
import { LOGGER } from '../config/env-config';

const DEFAULT_RELAYER_REPO = '../rayls-privacy-relayer-api';
const DEFAULT_COMPOSE_FILE = 'docker-compose.dev-local.yml';

export type ComposeAction = 'stop' | 'start' | 'restart' | 'kill';

function relayerRepo(): string {
  const fromEnv = process.env['DOCKER_COMPOSE_DIR'];
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), DEFAULT_RELAYER_REPO);
}

/**
 * Run `docker compose <action> <service>` against the dev-local compose file.
 *
 * `action: 'kill'` sends SIGKILL — use this for unrecoverable-crash tests. `'stop'`
 * sends SIGTERM and waits; `'restart'` is `stop` then `start`. `'start'` brings a
 * stopped container back up.
 *
 * `'start'` (and the `start` half of `'restart'`) does NOT run `docker compose start` —
 * that walks the service's `depends_on` graph. The AXYL topology gives `relayer-b` a chain
 * (`relayer-b → cts-b → pn-b → pn-b-genesis → pn-b-setup1..4 → axyl-base`) whose AXYL half
 * runs remotely in a hybrid stack (or is a pruned one-shot builder locally), so no
 * container exists for it and `start` aborts with `pn-b-setup4 is missing dependency
 * axyl-base`. Instead `start` resolves the already-created container id via
 * `docker compose ps -aq <service>` and runs `docker start <id>` — this resumes the exact
 * container `start_dev.sh` created (same config, networks, and `config_files` label) with
 * no graph walk and no recreation. Using `docker compose up` here would recreate the
 * container against this file set only, diverging its `config_files` label from the
 * `dev-local.yml + remote.override.yml` the remote stack was brought up with and splitting
 * it into a second Docker Desktop stack — hence `docker start`, not `up`. Only when no
 * container exists yet (fresh local env) does it fall back to `up -d --no-deps`.
 * `stop`/`kill` target only the named container and don't walk the graph, so they stay
 * plain `docker compose <action>`.
 *
 * Throws on non-zero exit; tests should wrap in try/finally and `start` the service
 * back in a cleanup hook so a failed assertion doesn't leave the env wedged.
 */
export function composeAction(
  action: ComposeAction,
  service: string,
  opts: { timeoutMs?: number; composeFile?: string } = {},
): void {
  const cwd = relayerRepo();
  const composeFile = opts.composeFile ?? DEFAULT_COMPOSE_FILE;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  if (action === 'start') return startService(service, { cwd, composeFile, timeoutMs });

  const args = ['compose', '-f', composeFile, action, service];
  LOGGER.log(`   compose: docker ${args.join(' ')}  (cwd=${cwd})`);
  try {
    execFileSync('docker', args, {
      cwd,
      timeout: timeoutMs,
      stdio: 'pipe',
    });
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.() ?? '';
    LOGGER.error(`   compose ${action} ${service} failed: ${err?.message ?? err} ${stderr}`);
    throw err;
  }
}

/**
 * Resume an already-created (stopped) service container in place via `docker start`,
 * falling back to `up -d --no-deps` only when the container doesn't exist yet. See the
 * `composeAction` doc for why this avoids the `missing dependency axyl-base` abort and the
 * `config_files`-label stack split. `docker compose ps -aq` resolves the id by project
 * name (dir-derived), so it finds the container regardless of which override files the
 * stack was composed with.
 */
function startService(
  service: string,
  ctx: { cwd: string; composeFile: string; timeoutMs: number },
): void {
  const { cwd, composeFile, timeoutMs } = ctx;
  const run = (bin: string, args: string[]): string => {
    LOGGER.log(`   compose: ${bin} ${args.join(' ')}  (cwd=${cwd})`);
    try {
      return (
        execFileSync(bin, args, { cwd, timeout: timeoutMs, stdio: 'pipe' })?.toString?.() ?? ''
      );
    } catch (err: any) {
      const stderr = err?.stderr?.toString?.() ?? '';
      LOGGER.error(`   start ${service} failed: ${err?.message ?? err} ${stderr}`);
      throw err;
    }
  };

  const ids = execFileSync('docker', ['compose', '-f', composeFile, 'ps', '-aq', service], {
    cwd,
    timeout: timeoutMs,
    stdio: 'pipe',
  })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean);

  if (ids.length) run('docker', ['start', ...ids]);
  else run('docker', ['compose', '-f', composeFile, 'up', '-d', '--no-deps', service]);
}

/**
 * Convenience wrappers — `compose.restart('relayer-b')` reads more cleanly in tests
 * than `composeAction('restart', 'relayer-b')`.
 */
export const compose = {
  stop: (service: string) => composeAction('stop', service),
  start: (service: string) => composeAction('start', service),
  // `restart` is stop + the `--no-deps` start (not `docker compose restart`, which walks
  // the dependency graph and hits the same "missing dependency axyl-base" abort as `start`).
  restart: (service: string) => {
    composeAction('stop', service);
    composeAction('start', service);
  },
  kill: (service: string) => composeAction('kill', service),
};

/**
 * Poll a readiness probe until it returns true. Use after a `restart` or `start` to
 * block the test until the relayer is reachable again.
 *
 * For the relayer's fault-injection HTTP API specifically, prefer
 * `FaultInjector.waitUntilAlive()` from fault-injector.ts — it knows the per-relayer
 * FI port mapping.
 */
export async function waitForCompose(
  ready: () => Promise<boolean>,
  timeoutMs: number = 120_000,
  pollMs: number = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await ready()) return;
    } catch {
      // ignore — container may be mid-restart
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitForCompose: readiness check did not pass within ${timeoutMs}ms`);
}

/**
 * Best-effort cleanup helper: ensure the named services are running. Intended for
 * `after()` hooks so a crashed/stopped service is restored before the next test runs.
 */
export function ensureRunning(services: string[]): void {
  for (const svc of services) {
    try {
      compose.start(svc);
    } catch {
      // already running, or compose returned non-zero — log and move on
    }
  }
}

/**
 * Read raw `docker compose ps` output. Useful for assertions like "relayer-b is Up".
 */
export function composePs(): string {
  const cwd = relayerRepo();
  const r = spawnSync(
    'docker',
    ['compose', '-f', DEFAULT_COMPOSE_FILE, 'ps', '--format', '{{.Name}} {{.Status}}'],
    {
      cwd,
      encoding: 'utf-8',
      timeout: 30_000,
    },
  );
  return r.stdout ?? '';
}
