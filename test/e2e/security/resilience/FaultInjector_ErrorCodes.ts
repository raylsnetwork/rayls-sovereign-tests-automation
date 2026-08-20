/**
 * @title E2E TOOLING: Fault-injection framework — `error_code` discriminator
 *
 * Tests the typed-error / `error_code` feature end-to-end against a real
 * relayer's HTTP API. The unit tests in
 * `rayls-sovereign-relayer/faultinjector/faultinjector_test.go` cover the
 * Go semantics in isolation; this file proves the JSON-over-HTTP round-trip:
 *
 *   - the TS client's `arm({ error_code })` serialises the field;
 *   - the relayer's HTTP handler accepts it;
 *   - `status()` echoes the stored rule with the field intact;
 *   - multiple arms with distinct `error_code` values form distinct rules in
 *     the (multi-session) view, ready to fire as separate equivalence
 *     classes when the cutpoint is hit by a real flow.
 *
 * This file does NOT trigger a production cutpoint — that's the job of the
 * per-feature resilience tests (Enygma_*, etc.). Triggering would couple
 * this framework-self-test to a specific business path; the framework's
 * round-trip contract is verifiable without firing.
 *
 * REQUIRES:
 *   - ./start_dev.sh --clean 6 (or equivalent) running
 *   - relayer-a healthy and FI API reachable at http://127.0.0.1:6660/sessions
 */

import { expect } from 'chai';
import { DEFAULT_TIMEOUT } from '../../../../src/config/env-config';
import { FaultInjector, FaultSession, FAULT_POINTS } from '../../../../src/utils/fault-injector';

describe('E2E TOOLING: FaultInjector framework — error_code discriminator', function () {
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

  it('round-trips error_code through POST /faults and GET /sessions/<id>', async function () {
    const s = await fi.newSession();
    trash.push(s);

    await s.arm({
      point: FAULT_POINTS.AFTER_INSERT_HISTORY,
      action: 'error',
      message: 'simulated db timeout',
      error_code: 'db_timeout',
      one_shot: true,
    });

    const snap = await s.status();
    const stored = snap.rules[FAULT_POINTS.AFTER_INSERT_HISTORY];
    expect(stored, 'rule should be present after arm').to.not.be.undefined;
    expect(stored.error_code).to.equal('db_timeout',
      'error_code must survive the JSON round-trip end-to-end');
    expect(stored.message).to.equal('simulated db timeout');
    expect(stored.action).to.equal('error');
  });

  it('omits error_code from the stored rule when not supplied (backward compat)', async function () {
    const s = await fi.newSession();
    trash.push(s);

    await s.arm({
      point: FAULT_POINTS.AFTER_MINT_BATCH,
      action: 'error',
      message: 'legacy-style arm',
      one_shot: true,
    });

    const snap = await s.status();
    const stored = snap.rules[FAULT_POINTS.AFTER_MINT_BATCH];
    expect(stored, 'rule should be present after arm').to.not.be.undefined;
    // Go side serialises empty string as `omitempty` — readback returns undefined
    // (or empty string). Either is acceptable; the assertion is "no code attached".
    expect(stored.error_code ?? '').to.equal('',
      'omitted error_code must not synthesise a value on the way back');
    expect(stored.message).to.equal('legacy-style arm');
  });

  it('arms three rules with distinct codes at the same point across sessions', async function () {
    // Each session can hold at most one rule per point — within a session,
    // SetRuleInSession replaces by point. Distinct codes therefore require
    // distinct sessions. This mirrors the Go-side TestCheck_MultiCodeFIFO.
    const a = await fi.newSession(); trash.push(a);
    const b = await fi.newSession(); trash.push(b);
    const c = await fi.newSession(); trash.push(c);

    const point = FAULT_POINTS.EXECUTOR_BEFORE_EXECUTE;
    await a.arm({ point, action: 'error', error_code: 'timeout',    one_shot: true });
    await b.arm({ point, action: 'error', error_code: 'db_locked',  one_shot: true });
    await c.arm({ point, action: 'error', error_code: 'rate_limit', one_shot: true });

    const codes = [
      (await a.status()).rules[point]?.error_code,
      (await b.status()).rules[point]?.error_code,
      (await c.status()).rules[point]?.error_code,
    ];
    expect(codes).to.deep.equal(['timeout', 'db_locked', 'rate_limit'],
      'each session should retain its distinct error_code');
  });

  it('clearPoint disarms a code-bearing rule cleanly', async function () {
    const s = await fi.newSession();
    trash.push(s);

    await s.arm({
      point: FAULT_POINTS.AFTER_REVERT_BATCH,
      action: 'error',
      error_code: 'transient',
      one_shot: true,
    });
    expect((await s.status()).rules[FAULT_POINTS.AFTER_REVERT_BATCH]).to.not.be.undefined;

    await s.clearPoint(FAULT_POINTS.AFTER_REVERT_BATCH);
    expect((await s.status()).rules[FAULT_POINTS.AFTER_REVERT_BATCH]).to.be.undefined;
  });
});
