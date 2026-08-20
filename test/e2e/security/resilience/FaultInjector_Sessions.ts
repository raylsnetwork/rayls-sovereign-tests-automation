/**
 * @title E2E TOOLING: Fault-injection framework — session API behaviour
 *
 * Tests the FI framework itself against a real running relayer's HTTP API.
 * This does NOT test the relayer's business behaviour under faults — that's
 * what the Enygma_* resilience tests do. This file verifies the FI tool's
 * own contract:
 *
 *   - session lifecycle (create → status → clear),
 *   - multi-session isolation of rules and logs on the same relayer,
 *   - clearLog vs clearAllRules vs clear semantics,
 *   - persistence of sessions across a relayer restart,
 *   - removal of legacy /faults routes,
 *   - error paths (404 on missing session, 400 on bad input).
 *
 * Why this lives in resilience/: the tests require a live relayer with FI
 * enabled (port 6660, FAULT_INJECTION_ENABLED=true), exactly the same env
 * as the bug-finding resilience tests. They never actually fire fault rules,
 * so they're fast — typically a few seconds — except the persistence test
 * which restarts a container.
 *
 * REQUIRES:
 *   - ./start_dev.sh --clean 6 (or equivalent) running
 *   - relayer-a healthy and FI API reachable at http://127.0.0.1:6660/sessions
 */

import axios from 'axios';
import { expect } from 'chai';
import { DEFAULT_TIMEOUT, LOGGER } from '../../../../src/config/env-config';
import { compose } from '../../../../src/utils/docker-compose';
import { FaultInjector, FaultSession, FAULT_POINTS } from '../../../../src/utils/fault-injector';

describe('E2E TOOLING: FaultInjector framework — sessions', function () {
  this.timeout(DEFAULT_TIMEOUT * 5);

  let fi: FaultInjector;
  const trash: FaultSession[] = [];

  before(async function () {
    fi = FaultInjector.forRelayer('A', '127.0.0.1');
    expect(await fi.isAlive()).to.equal(true,
      'FI API on relayer-a must be reachable. Ensure FAULT_INJECTION_ENABLED=true ' +
      'and port 6660 is exposed in the dev environment.',
    );
  });

  after(async function () {
    for (const s of trash) {
      try { await s.clear(); } catch { /* best-effort */ }
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // Session lifecycle
  // ───────────────────────────────────────────────────────────────────────

  it('creates a session with a server-assigned UUID', async function () {
    const s = await fi.newSession();
    trash.push(s);
    expect(s.id).to.be.a('string');
    // UUIDv4 is 36 chars with 4 dashes.
    expect(s.id).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('returns status with empty rules and log for a fresh session', async function () {
    const s = await fi.newSession();
    trash.push(s);
    const snap = await s.status();
    expect(snap.id).to.equal(s.id);
    expect(snap.rules).to.deep.equal({});
    expect(snap.log).to.deep.equal([]);
  });

  it('drops a session via clear() and subsequent status returns 404', async function () {
    const s = await fi.newSession();
    await s.clear();
    let threw = false;
    try {
      await s.status();
    } catch (err: any) {
      threw = true;
      expect(String(err.message)).to.match(/404/);
    }
    expect(threw).to.equal(true);
  });

  it('clear() on an already-cleared session is idempotent (no throw)', async function () {
    const s = await fi.newSession();
    await s.clear();
    // Should NOT throw — clear() swallows 404 as per the TS client contract.
    await s.clear();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Multi-session isolation
  // ───────────────────────────────────────────────────────────────────────

  it('does not leak rules between two sessions on the same relayer', async function () {
    const a = await fi.newSession();
    const b = await fi.newSession();
    trash.push(a, b);

    await a.arm({ point: FAULT_POINTS.AFTER_MINT_BATCH, action: 'error', message: 'from-a' });
    await b.arm({ point: FAULT_POINTS.AFTER_MINT_BATCH, action: 'error', message: 'from-b' });

    const aSnap = await a.status();
    const bSnap = await b.status();
    expect(aSnap.rules[FAULT_POINTS.AFTER_MINT_BATCH].message).to.equal('from-a');
    expect(bSnap.rules[FAULT_POINTS.AFTER_MINT_BATCH].message).to.equal('from-b');
  });

  it('clearAllRules on one session does not affect the other', async function () {
    const a = await fi.newSession();
    const b = await fi.newSession();
    trash.push(a, b);

    await a.arm({ point: FAULT_POINTS.AFTER_MINT_BATCH, action: 'error', message: 'a' });
    await b.arm({ point: FAULT_POINTS.AFTER_MINT_BATCH, action: 'error', message: 'b' });

    await a.clearAllRules();

    const aSnap = await a.status();
    const bSnap = await b.status();
    expect(Object.keys(aSnap.rules)).to.have.length(0);
    expect(bSnap.rules[FAULT_POINTS.AFTER_MINT_BATCH].message).to.equal('b');
  });

  it('clear() on one session does not affect the other', async function () {
    const a = await fi.newSession();
    const b = await fi.newSession();
    trash.push(b);

    await a.arm({ point: FAULT_POINTS.AFTER_MINT_BATCH, action: 'error', message: 'a' });
    await b.arm({ point: FAULT_POINTS.AFTER_MINT_BATCH, action: 'error', message: 'b' });

    await a.clear();

    // a is gone; b still has its rule.
    let aGone = false;
    try { await a.status(); } catch { aGone = true; }
    expect(aGone).to.equal(true);

    const bSnap = await b.status();
    expect(bSnap.rules[FAULT_POINTS.AFTER_MINT_BATCH].message).to.equal('b');
  });

  it('listSessions returns all current sessions on the relayer', async function () {
    const a = await fi.newSession();
    const b = await fi.newSession();
    const c = await fi.newSession();
    trash.push(a, b, c);

    const listing = await fi.listSessions();
    expect(listing.enabled).to.equal(true);
    const ids = listing.sessions.map((s) => s.id);
    expect(ids).to.include(a.id);
    expect(ids).to.include(b.id);
    expect(ids).to.include(c.id);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Per-rule manipulation
  // ───────────────────────────────────────────────────────────────────────

  it('clearPoint removes one rule and leaves siblings intact', async function () {
    const s = await fi.newSession();
    trash.push(s);

    await s.arm({ point: FAULT_POINTS.AFTER_MINT_BATCH, action: 'error', message: 'a' });
    await s.arm({ point: FAULT_POINTS.AFTER_REVERT_BATCH, action: 'error', message: 'b' });

    await s.clearPoint(FAULT_POINTS.AFTER_MINT_BATCH);

    const snap = await s.status();
    expect(snap.rules[FAULT_POINTS.AFTER_MINT_BATCH]).to.equal(undefined);
    expect(snap.rules[FAULT_POINTS.AFTER_REVERT_BATCH].message).to.equal('b');
  });

  it('arming the same point twice overwrites within a single session', async function () {
    const s = await fi.newSession();
    trash.push(s);

    await s.arm({ point: FAULT_POINTS.AFTER_MINT_BATCH, action: 'error', message: 'first' });
    await s.arm({ point: FAULT_POINTS.AFTER_MINT_BATCH, action: 'error', message: 'second' });

    const snap = await s.status();
    expect(snap.rules[FAULT_POINTS.AFTER_MINT_BATCH].message).to.equal('second');
  });

  // ───────────────────────────────────────────────────────────────────────
  // Persistence across container restart
  // ───────────────────────────────────────────────────────────────────────

  it('persists sessions and rules across a container restart', async function () {
    const s = await fi.newSession();
    await s.arm({
      point: FAULT_POINTS.AFTER_MINT_BATCH,
      action: 'error',
      message: 'persisted',
      max_count: 5,
    });

    LOGGER.log(`   Session ${s.id} armed; restarting relayer-a`);
    compose.restart('relayer-a');
    await fi.waitUntilAlive(180_000);
    LOGGER.log('   Relayer-a back online; checking persisted session');

    const snap = await s.status();
    expect(snap.id).to.equal(s.id);
    const rule = snap.rules[FAULT_POINTS.AFTER_MINT_BATCH];
    expect(rule).to.exist;
    expect(rule.action).to.equal('error');
    expect(rule.message).to.equal('persisted');
    expect(rule.max_count).to.equal(5);

    await s.clear();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Removed legacy routes return 404
  // ───────────────────────────────────────────────────────────────────────

  it('removed POST /faults returns 404', async function () {
    let status = 0;
    try {
      await axios.post(`${fi.baseUrl}/faults`, { point: 'x', action: 'error' });
    } catch (err: any) {
      status = err.response?.status ?? 0;
    }
    expect(status).to.equal(404);
  });

  it('removed GET /faults returns 404', async function () {
    let status = 0;
    try {
      await axios.get(`${fi.baseUrl}/faults`);
    } catch (err: any) {
      status = err.response?.status ?? 0;
    }
    expect(status).to.equal(404);
  });

  it('removed DELETE /faults returns 404', async function () {
    let status = 0;
    try {
      await axios.delete(`${fi.baseUrl}/faults`);
    } catch (err: any) {
      status = err.response?.status ?? 0;
    }
    expect(status).to.equal(404);
  });

  it('removed DELETE /faults/{point} returns 404', async function () {
    let status = 0;
    try {
      await axios.delete(`${fi.baseUrl}/faults/some.point`);
    } catch (err: any) {
      status = err.response?.status ?? 0;
    }
    expect(status).to.equal(404);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Error paths
  // ───────────────────────────────────────────────────────────────────────

  it('arming a rule in a non-existent session returns 404', async function () {
    let status = 0;
    try {
      await axios.post(`${fi.baseUrl}/sessions/does-not-exist/faults`, {
        point: 'x', action: 'error',
      });
    } catch (err: any) {
      status = err.response?.status ?? 0;
    }
    expect(status).to.equal(404);
  });

  it('arming a rule with missing point returns 400', async function () {
    const s = await fi.newSession();
    trash.push(s);
    let status = 0;
    try {
      await axios.post(`${fi.baseUrl}/sessions/${s.id}/faults`, {
        action: 'error', message: 'no point',
      });
    } catch (err: any) {
      status = err.response?.status ?? 0;
    }
    expect(status).to.equal(400);
  });

  it('arming a rule with invalid action returns 400', async function () {
    const s = await fi.newSession();
    trash.push(s);
    let status = 0;
    try {
      await axios.post(`${fi.baseUrl}/sessions/${s.id}/faults`, {
        point: 'x', action: 'explode',
      });
    } catch (err: any) {
      status = err.response?.status ?? 0;
    }
    expect(status).to.equal(400);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Trigger-inspection convenience methods
  // ───────────────────────────────────────────────────────────────────────

  it('wasTriggered returns false on a fresh session', async function () {
    const s = await fi.newSession();
    trash.push(s);
    expect(await s.wasTriggered(FAULT_POINTS.AFTER_MINT_BATCH)).to.equal(false);
  });

  it('triggerCount returns 0 on a fresh session', async function () {
    const s = await fi.newSession();
    trash.push(s);
    expect(await s.triggerCount(FAULT_POINTS.AFTER_MINT_BATCH)).to.equal(0);
  });
});
