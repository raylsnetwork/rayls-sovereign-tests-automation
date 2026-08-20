/**
 * @title E2E TOOLING: Fault-injection framework — `panic` action
 *
 * Tests the `action: 'panic'` rule end-to-end against a real relayer's HTTP
 * API. The Go-side unit tests in
 * `rayls-sovereign-relayer/faultinjector/faultinjector_test.go` already
 * cover the panic action's firing semantics in isolation (panic propagation,
 * multi-arm FIFO across sessions, equivalence-class keying, crash-dominates-
 * panic priority, persistence). This file proves the JSON-over-HTTP round-
 * trip from the TypeScript client's perspective:
 *
 *   - the TS client's `arm({ action: 'panic' })` serialises correctly;
 *   - the relayer's HTTP handler accepts the action;
 *   - `status()` echoes the stored rule with action='panic' intact;
 *   - `error_code` discriminator works for panic (just like for error);
 *   - `clearPoint()` disarms a panic rule cleanly;
 *   - multi-session panic isolation: rules in one session don't leak.
 *
 * This file does NOT actually fire a panic against a live cutpoint. Firing a
 * panic-action rule at a real cutpoint will either crash the relayer (if the
 * goroutine's call stack has no recover()) or surface as an upstream error
 * (if a recover() catches it). Which one happens is service-implementation-
 * specific to the chosen cutpoint and is not part of the framework contract.
 * Per-feature resilience tests can exercise panic-firing scenarios once the
 * recovery behaviour at a specific cutpoint is established and documented.
 *
 * REQUIRES:
 *   - ./start_dev.sh --clean 6 (or equivalent) running
 *   - relayer-a healthy and FI API reachable at http://127.0.0.1:6660/sessions
 */

import { expect } from 'chai';
import { DEFAULT_TIMEOUT } from '../../../../src/config/env-config';
import { FaultInjector, FaultSession, FAULT_POINTS } from '../../../../src/utils/fault-injector';

describe('E2E TOOLING: FaultInjector framework — panic action', function () {
  this.timeout(DEFAULT_TIMEOUT * 2);

  let fi: FaultInjector;
  const trash: FaultSession[] = [];

  before(async function () {
    fi = FaultInjector.forRelayer('A', '127.0.0.1');
    expect(await fi.isAlive()).to.equal(true,
      'FI API on relayer-a must be reachable. Ensure FAULT_INJECTION_ENABLED=true ' +
      'and port 6660 is exposed.',
    );
  });

  after(async function () {
    for (const s of trash) {
      try { await s.clear(); } catch { /* best-effort */ }
    }
  });

  it('round-trips action=panic through POST /faults and GET /sessions/<id>', async function () {
    const s = await fi.newSession();
    trash.push(s);

    await s.arm({
      point: FAULT_POINTS.AFTER_INSERT_HISTORY,
      action: 'panic',
      message: 'simulated unrecoverable goroutine panic',
      one_shot: true,
    });

    const snap = await s.status();
    const stored = snap.rules[FAULT_POINTS.AFTER_INSERT_HISTORY];
    expect(stored, 'panic rule should be present after arm').to.not.be.undefined;
    expect(stored.action).to.equal('panic',
      'action must round-trip as "panic" — wire format mismatch breaks every panic test');
    expect(stored.message).to.equal('simulated unrecoverable goroutine panic');
    expect(stored.one_shot).to.equal(true);
  });

  it('round-trips panic + error_code together (typed-panic discriminator)', async function () {
    const s = await fi.newSession();
    trash.push(s);

    // error_code is the equivalence-class key for both `error` and `panic`
    // actions. Confirm it survives the round-trip on a panic rule.
    await s.arm({
      point: FAULT_POINTS.AFTER_CROSS_TRANSFER,
      action: 'panic',
      error_code: 'unrecoverable_state',
      message: 'state corruption detected — refusing to continue',
      one_shot: true,
    });

    const snap = await s.status();
    const stored = snap.rules[FAULT_POINTS.AFTER_CROSS_TRANSFER];
    expect(stored, 'panic rule should be present after arm').to.not.be.undefined;
    expect(stored.action).to.equal('panic');
    expect(stored.error_code).to.equal('unrecoverable_state',
      'error_code must survive the round-trip on panic actions, not just on error');
    expect(stored.message).to.equal('state corruption detected — refusing to continue');
  });

  it('clearPoint disarms a panic rule cleanly', async function () {
    const s = await fi.newSession();
    trash.push(s);

    await s.arm({
      point: FAULT_POINTS.AFTER_REVERT_BATCH,
      action: 'panic',
      message: 'transient',
      one_shot: true,
    });
    expect((await s.status()).rules[FAULT_POINTS.AFTER_REVERT_BATCH]).to.not.be.undefined;

    await s.clearPoint(FAULT_POINTS.AFTER_REVERT_BATCH);
    expect((await s.status()).rules[FAULT_POINTS.AFTER_REVERT_BATCH]).to.be.undefined;
  });

  it('does not leak panic rules between sessions on the same relayer', async function () {
    // Two sessions arm a panic rule at the same point with distinct messages.
    // Each session's view of the rule must reflect its own arm, never the
    // neighbour's — the multi-session isolation invariant.
    const a = await fi.newSession(); trash.push(a);
    const b = await fi.newSession(); trash.push(b);

    const point = FAULT_POINTS.AFTER_MINT_BATCH;
    await a.arm({ point, action: 'panic', message: 'from-a', one_shot: true });
    await b.arm({ point, action: 'panic', message: 'from-b', one_shot: true });

    const aSnap = await a.status();
    const bSnap = await b.status();

    expect(aSnap.rules[point].message).to.equal('from-a',
      'session A must see its own message, not B\'s');
    expect(bSnap.rules[point].message).to.equal('from-b',
      'session B must see its own message, not A\'s');
    expect(aSnap.rules[point].action).to.equal('panic');
    expect(bSnap.rules[point].action).to.equal('panic');
  });

  it('arms three panic rules with distinct codes across sessions (multi-class setup)', async function () {
    // Mirrors the FaultInjector_ErrorCodes "three classes" test but for panic.
    // This is the precondition shape for a panic-fire test that wants to
    // verify FIFO-oldest selection across distinct error_code classes.
    // We don't fire here (see file-level docstring).
    const a = await fi.newSession(); trash.push(a);
    const b = await fi.newSession(); trash.push(b);
    const c = await fi.newSession(); trash.push(c);

    const point = FAULT_POINTS.EXECUTOR_BEFORE_EXECUTE;
    await a.arm({ point, action: 'panic', error_code: 'invariant_violated', one_shot: true });
    await b.arm({ point, action: 'panic', error_code: 'state_corruption',   one_shot: true });
    await c.arm({ point, action: 'panic', error_code: 'unknown_failure',    one_shot: true });

    const codes = [
      (await a.status()).rules[point]?.error_code,
      (await b.status()).rules[point]?.error_code,
      (await c.status()).rules[point]?.error_code,
    ];
    expect(codes).to.deep.equal(
      ['invariant_violated', 'state_corruption', 'unknown_failure'],
      'each session should retain its distinct panic error_code',
    );
  });
});
