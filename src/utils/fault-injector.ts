/**
 * @title FaultInjector — TypeScript client for the relayer fault-injection API
 *
 * Session-based isolation: every test file opens a session in `before()`, arms
 * rules inside it, and drops it in `after()`. Two parallel tests on the same
 * relayer cannot overwrite each other's rules or contaminate each other's
 * trigger logs.
 *
 * The relayer must be started with FAULT_INJECTION_ENABLED=true.
 *
 * Usage:
 *   let fi: FaultInjector;
 *   let session: FaultSession;
 *
 *   before(async () => {
 *     fi = FaultInjector.forRelayer('A');          // → http://relayer-a:6660
 *     session = await fi.newSession();
 *   });
 *   after(async () => {
 *     await session.clear();                        // drops session + rules + log
 *   });
 *
 *   it('observes a crash recovery', async () => {
 *     await session.arm({
 *       point: FAULT_POINTS.AFTER_INSERT_HISTORY,
 *       action: 'crash',
 *       one_shot: true,
 *     });
 *     // ... trigger the relayer flow that should hit the armed point ...
 *
 *     // MANDATORY: confirm relayer is alive — a neighbour session may have armed
 *     // a terminal that fired on the same Check call. Tests share the relayer.
 *     await fi.waitUntilAlive(60_000);
 *     expect(await session.wasTriggered(FAULT_POINTS.AFTER_INSERT_HISTORY)).to.equal(true);
 *   });
 *
 *   // Or with the bundled convenience:
 *   await session.assertLiveAfter(FAULT_POINTS.AFTER_INSERT_HISTORY);
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Multi-arm semantics — when several sessions arm rules on the same point:
 *
 *   sleep  → all sleep arms across sessions decrement together; the actual
 *            delay is max(durations). Sleeps stack semantically: the longer
 *            sleep satisfies both arms.
 *   error  → arms with the same `message` are one equivalence class. Different
 *            messages form different classes. Each Check fires the FIFO-oldest
 *            class; other classes stay armed for the next Check.
 *   panic  → same equivalence rules as error (by message). When one panic
 *            fires, every arm in its class decrements together.
 *   crash  → all crash arms are one equivalence class (no message field).
 *            When the crash fires, every crash arm decrements together.
 *   Priority: crash > panic > error (most destructive wins). Sleep always
 *            runs first when present.
 *
 * Caveat: tests run in parallel by default and share the relayer process. A
 * neighbour's `crash` will take down the relayer; tests must use
 * `waitUntilAlive` (or `session.assertLiveAfter`) after any trigger window.
 * Neighbour-tolerance is a test-authoring requirement, not opt-in/opt-out.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Persistence:
 *   When FAULT_INJECTION_PERSIST_PATH is set (default in dev-local), the whole
 *   session table is saved to a JSON file on every mutation and restored on
 *   relayer startup. Sessions survive process crashes, which is essential for
 *   testing crash-retry scenarios. One-shot rules that already fired are
 *   atomically consumed before the os.Exit and not restored.
 */

import axios from 'axios';

// Per-request timeout for control-plane calls (arm/clear/status/session lifecycle). Without it a slow
// or unresponsive relayer HTTP server would block the call — and the whole suite — indefinitely.
const CONTROL_PLANE_TIMEOUT_MS = 5_000;

export type FaultAction = 'crash' | 'sleep' | 'panic' | 'error';

export interface FaultRule {
  point: string;
  action: FaultAction;
  duration_ms?: number;   // for 'sleep'
  message?: string;       // for 'error' / 'panic'; human-readable text
  /**
   * Machine-readable discriminator that the production cutpoint can switch on
   * via `faultinjector.CodeOf(err)`. Lets one cutpoint drive multiple
   * behaviours (e.g. retry vs revert) from different test arms.
   *
   * When set, `error_code` overrides `message` as the multi-arm
   * equivalence-class key — arms keyed on different codes form distinct FIFO
   * classes; arms with the same code group together.
   */
  error_code?: string;
  one_shot?: boolean;     // consumed after first trigger
  max_count?: number;     // max times to trigger (0 = unlimited)
  triggered?: number;     // server-reported counter; populated on reads
}

export interface TriggerEvent {
  point: string;
  action: FaultAction;
  /** Echo of the firing rule's `error_code` (empty when the rule had none). */
  code?: string;
  /** Echo of the firing rule's `message` (empty for sleep). */
  message?: string;
  timestamp: string;
}

export interface SessionSnapshot {
  id: string;
  created_at: string;
  last_activity: string;
  rules: Record<string, FaultRule>;
  log: TriggerEvent[];
}

export interface SessionSummary {
  id: string;
  created_at: string;
  last_activity: string;
  rule_count: number;
  log_count: number;
}

export interface SessionsListing {
  enabled: boolean;
  sessions: SessionSummary[];
}

/**
 * Roles correspond to the three fault-injection-capable service classes. Each
 * service has its own in-process FaultInjector state and HTTP server bound to
 * a distinct port (see per-participant .env files: FAULT_INJECTION_PORT,
 * PUBLIC_RELAYER_FAULT_INJECTION_PORT, KOS_FAULT_INJECTION_PORT). Within a
 * single participant letter, the three roles point at different processes
 * with disjoint rule sets.
 */
export type FaultRole = 'relayer' | 'pubrelayer' | 'kos';

/**
 * Docker service configuration for each relayer in docker-compose.dev-local.yml.
 * Hostname is the Docker Compose service name; port is the default FAULT_INJECTION_PORT
 * from each .env file. Port can be overridden via env var FAULT_INJECTION_PORT_<letter>.
 */
export const RELAYER_SERVICES: Record<string, { hostname: string; defaultPort: number }> = {
  A: { hostname: 'relayer-a', defaultPort: 6660 },
  B: { hostname: 'relayer-b', defaultPort: 6661 },
  C: { hostname: 'relayer-c', defaultPort: 6662 },
  D: { hostname: 'relayer-d', defaultPort: 6663 },
  E: { hostname: 'relayer-e', defaultPort: 6664 },
  F: { hostname: 'relayer-f', defaultPort: 6665 },
};

/**
 * FI service map keyed by (role, participant). Ports come from the per-
 * participant .env files; hostnames are Docker Compose service names (see
 * docker-compose.dev-local.yml). Use FaultInjector.forService(role, letter)
 * for any of the three roles, or the legacy forRelayer(letter) helper which
 * is equivalent to forService('relayer', letter).
 *
 * Per-test port overrides: set FAULT_INJECTION_PORT_<ROLE>_<LETTER> in the
 * environment (e.g. FAULT_INJECTION_PORT_KOS_A=6800 for kos+A).
 */
export const FI_SERVICES: Record<FaultRole, Record<string, { hostname: string; defaultPort: number }>> = {
  relayer:    RELAYER_SERVICES,
  pubrelayer: {
    A: { hostname: 'pubrelayer-a', defaultPort: 6700 },
    B: { hostname: 'pubrelayer-b', defaultPort: 6701 },
    C: { hostname: 'pubrelayer-c', defaultPort: 6702 },
    D: { hostname: 'pubrelayer-d', defaultPort: 6703 },
    E: { hostname: 'pubrelayer-e', defaultPort: 6704 },
    F: { hostname: 'pubrelayer-f', defaultPort: 6705 },
  },
  kos: {
    A: { hostname: 'cts-a', defaultPort: 6800 },
    B: { hostname: 'cts-b', defaultPort: 6801 },
    C: { hostname: 'cts-c', defaultPort: 6802 },
    D: { hostname: 'cts-d', defaultPort: 6803 },
    E: { hostname: 'cts-e', defaultPort: 6804 },
    F: { hostname: 'cts-f', defaultPort: 6805 },
  },
};

/**
 * Well-known fault point names matching the instrumented Go code. Grouped by
 * service: private-relayer enygma flow, public-relayer flows, and KOS flows.
 * Tests target a service by selecting a FaultInjector via forService(role, …);
 * the point names themselves are namespaced so cross-service collisions are
 * impossible.
 */
export const FAULT_POINTS = {
  // ── private-relayer (enygma) ──────────────────────────────────────────
  AFTER_INSERT_HISTORY:     'enygma.handler.Receiver.HandleEnygmaCrossTransfer.after_insert_history',
  AFTER_MINT_BATCH:         'enygma.handler.Receiver.HandleEnygmaCrossTransfer.after_mint_batch',
  AFTER_REVERT_BATCH:       'enygma.handler.Receiver.HandleEnygmaCrossTransfer.after_revert_batch',
  BEFORE_TRANSFER_COMPLETED:'enygma.handler.Receiver.HandleEnygmaCrossTransfer.before_transfer_completed',
  // Routes the destination mint onto the failed -> RevertDestTransferBatch path for the
  // armed message(s): source re-credited, dest mint reverted (net-zero), governance stays
  // PENDING. Reproduces the dest-failure outcome that issuer revert-traps gave before
  // canonical factory bytecode shipped to Enygma destinations. Arm on the DESTINATION
  // relayer (e.g. relayer-B); other destinations are unaffected (each relayer only handles
  // batches destined to its own PL).
  FAIL_MINT:                'enygma.handler.Receiver.HandleEnygmaCrossTransfer.fail_mint',
  AFTER_SRC_REVERT_SEND:    'enygma.service.EnygmaRevertService.revertTransfersInPL.after_send',
  AFTER_CROSS_TRANSFER:     'private_relayer.source.service.EnygmaOrchestrator.handleEnygmaTransfer.after_cross_transfer',
  AFTER_REVERT:             'private_relayer.source.service.EnygmaOrchestrator.handleEnygmaTransfer.after_revert',
  // Forces ExecuteEnygmaCrossTransfer to return an error every time it is called.
  // Used by resilience tests to drive the orchestrator's revert branch (which calls
  // crossRevertMint on the source PL) without needing a real proof/signing failure.
  // Combine with action='error', max_count=0 (unlimited), one_shot=false to keep the
  // executor failing across restart so NATS redelivery enters the revert path again.
  EXECUTOR_BEFORE_EXECUTE:  'enygma.service.EnygmaExecutor.ExecuteEnygmaCrossTransfer.before_execute',

  // ── private-relayer (proofgen / vanilla cross-chain) ──────────────────
  // Top of the SOURCE relayer's per-tx proof generation. Arm action='error'
  // (one_shot) to make Generate fail: BatchGenerate swallows the error and
  // ships a nil proof to the destination. Arm on the SOURCE (teleport sender).
  PROOFGEN_GENERATE_START:  'private_relayer.proofgen.ProofGenerator.Generate.start',

  // ── public-relayer ────────────────────────────────────────────────────
  // After block events were pushed to NATS but before the listener's
  // last_processed_block checkpoint is updated. A fault here prevents the
  // checkpoint advance, so the same block range is re-scanned next tick.
  PUBRELAYER_BLOCK_AFTER_PUSH:      'public_relayer.handler.PublicRelayerHandler.Handle.after_push_messages',
  // Before the generator writes the mint TX batch to the executor's DB queue.
  PUBRELAYER_GEN_BEFORE_PUSH:       'public_relayer.service.GeneratorService.Run.before_executor_push',
  // After revert signatures are durable in the DB but NATS hasn't been acked.
  PUBRELAYER_GEN_AFTER_SIG_PERSIST: 'public_relayer.service.GeneratorService.Run.after_signature_persist',
  // The classic "processed but not acked → redelivery" boundary, per-message.
  PUBRELAYER_GEN_BEFORE_ACK:        'public_relayer.service.GeneratorService.Run.before_ack',
  // Before the revert service pushes compensation TXs to the source executor.
  PUBRELAYER_REVERT_BEFORE_PUSH:    'public_relayer.service.RevertService.Run.before_revert_push',
  // After failed forward TXs are marked ExecutedCallback — they no longer
  // appear in GetFinished. Use to test "we said we compensated but the
  // revert TX never landed".
  PUBRELAYER_REVERT_AFTER_MARK:     'public_relayer.service.RevertService.Run.after_revert_status_mark',
  // After UpdatePublicTokenAddress lands on-chain but NATS hasn't been acked.
  // Redelivery should hit the GetPublicAddressByPrivateAddress idempotency guard.
  PUBRELAYER_DEPLOY_AFTER_GOV:      'public_relayer.service.DeployerService.Deploy.after_governance_update',
  // Right before the deployer acks the deployment message.
  PUBRELAYER_DEPLOY_BEFORE_ACK:     'public_relayer.service.DeployerService.Deploy.before_ack',

  // ── KOS ───────────────────────────────────────────────────────────────
  // Each state-mutating flow has the same 3-phase shape:
  //   before_kms_encrypt → before_db_insert → after_db_insert
  // before_kms_encrypt  → external KMS call about to run (simulates KMS down)
  // before_db_insert    → KMS encrypted, DB write not yet attempted
  // after_db_insert     → DB durable, HTTP response not yet sent (idempotency)
  KOS_VIEWKEY_BEFORE_KMS:     'kos.service.KeysService.CreateRaylsViewKeyPair.before_kms_encrypt',
  KOS_VIEWKEY_BEFORE_DB:      'kos.service.KeysService.CreateRaylsViewKeyPair.before_db_insert',
  KOS_VIEWKEY_AFTER_DB:       'kos.service.KeysService.CreateRaylsViewKeyPair.after_db_insert',
  KOS_PUB_SIGNKEY_BEFORE_KMS: 'kos.service.KeysService.CreatePublicRelayerRaylsSignKeys.before_kms_encrypt',
  KOS_PUB_SIGNKEY_BEFORE_DB:  'kos.service.KeysService.CreatePublicRelayerRaylsSignKeys.before_db_insert',
  KOS_PUB_SIGNKEY_AFTER_DB:   'kos.service.KeysService.CreatePublicRelayerRaylsSignKeys.after_db_insert',
  KOS_KEY_AGREEMENT_BEFORE_KMS: 'kos.service.KeysService.CreateKeyAgreement.before_kms_encrypt',
  KOS_KEY_AGREEMENT_BEFORE_DB:  'kos.service.KeysService.CreateKeyAgreement.before_db_insert',
  KOS_KEY_AGREEMENT_AFTER_DB:   'kos.service.KeysService.CreateKeyAgreement.after_db_insert',
  KOS_PAYMENT_SPEND_BEFORE_KMS: 'kos.service.KeysService.CreatePaymentSpendKey.before_kms_encrypt',
  KOS_PAYMENT_SPEND_BEFORE_DB:  'kos.service.KeysService.CreatePaymentSpendKey.before_db_insert',
  KOS_PAYMENT_SPEND_AFTER_DB:   'kos.service.KeysService.CreatePaymentSpendKey.after_db_insert',

  // ── CTS batcher (vanilla destination dispatch) ────────────────────────
  // Fires at the top of the receipter's per-cycle `receipt()` call, before
  // the row claim and the receipt poll. Arm `error` (with `count=N`, no
  // `one_shot`) to make the receipter skip N consecutive poll cycles for
  // this CTS identity, simulating "the chain dropped the broadcast and
  // never returned a receipt". After ~1 minute (StuckThreshold) the reaper
  // claims the row and dead-letters it. Used by
  // Vanilla_StuckTx_PermanentLoss.ts to drive the
  // lost-tx → no-retry → permanent message-loss regression without needing
  // real chain instability.
  CTS_RECEIPTER_BEFORE_POLL: 'cts.batcher.ReceipterService.receipt.before_poll',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// FaultInjector — relayer-targeting + session factory + health probes
// ─────────────────────────────────────────────────────────────────────────────

export class FaultInjector {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Factory: create a FaultInjector for a specific service instance.
   *
   * Role-specific port override env vars (checked first):
   *   FAULT_INJECTION_PORT_<ROLE>_<LETTER>  — role-scoped (preferred)
   *
   * For role='relayer' the legacy FAULT_INJECTION_PORT_<LETTER> env var is
   * still honoured as a fallback so existing test setups keep working.
   *
   * Host can be overridden (e.g. '127.0.0.1' when running tests outside Docker).
   *
   *   const fi = FaultInjector.forService('relayer', 'B');               // → http://relayer-b:6661
   *   const fi = FaultInjector.forService('pubrelayer', 'A');            // → http://pubrelayer-a:6700
   *   const fi = FaultInjector.forService('kos', 'C', '127.0.0.1');      // → http://127.0.0.1:6802
   */
  static forService(role: FaultRole, participant: string, hostOverride?: string): FaultInjector {
    const letter = participant.toUpperCase();
    const map = FI_SERVICES[role];
    if (!map) {
      throw new Error(`Unknown FI role '${role}'. Valid: ${Object.keys(FI_SERVICES).join(', ')}`);
    }
    const svc = map[letter];
    if (!svc) {
      throw new Error(`Unknown ${role} participant '${participant}'. Valid: ${Object.keys(map).join(', ')}`);
    }
    const roleScoped = process.env[`FAULT_INJECTION_PORT_${role.toUpperCase()}_${letter}`];
    const legacy = role === 'relayer' ? process.env[`FAULT_INJECTION_PORT_${letter}`] : undefined;
    const port = roleScoped ? parseInt(roleScoped, 10)
               : legacy     ? parseInt(legacy, 10)
               : svc.defaultPort;
    const host = hostOverride ?? svc.hostname;
    return new FaultInjector(`http://${host}:${port}`);
  }

  /**
   * Legacy factory: equivalent to forService('relayer', participant, hostOverride).
   * Kept so existing tests that target the private-relayer don't need updating.
   *
   *   const fi = FaultInjector.forRelayer('B');              // → http://relayer-b:6661
   *   const fi = FaultInjector.forRelayer('B', '127.0.0.1'); // → http://127.0.0.1:6661
   */
  static forRelayer(participant: string, hostOverride?: string): FaultInjector {
    return FaultInjector.forService('relayer', participant, hostOverride);
  }

  /**
   * Create a new isolated session. The returned session owns its rules, log,
   * and lifecycle. Call `session.clear()` in `after()` to drop it.
   */
  async newSession(): Promise<FaultSession> {
    try {
      const resp = await axios.post(`${this.baseUrl}/sessions`, undefined, { timeout: CONTROL_PLANE_TIMEOUT_MS });
      const id = resp.data?.id;
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error(`unexpected response shape: ${JSON.stringify(resp.data)}`);
      }
      return new FaultSession(this.baseUrl, id);
    } catch (err: any) {
      throw new Error(`FaultInjector.newSession failed (${err.response?.status ?? 'N/A'}): ${err.response?.data ?? err.message}`);
    }
  }

  /**
   * List all sessions on the relayer. Debug / observability only — tests should
   * normally only interact with their own session.
   */
  async listSessions(): Promise<SessionsListing> {
    try {
      const resp = await axios.get(`${this.baseUrl}/sessions`, { timeout: CONTROL_PLANE_TIMEOUT_MS });
      return resp.data as SessionsListing;
    } catch (err: any) {
      throw new Error(`FaultInjector.listSessions failed (${err.response?.status ?? 'N/A'})`);
    }
  }

  /**
   * Check if the fault-injection server is reachable. Returns false if the
   * server is down (e.g. after a crash fault). Does not throw.
   */
  async isAlive(): Promise<boolean> {
    try {
      const resp = await axios.get(`${this.baseUrl}/sessions`, { timeout: 2000 });
      return resp.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Wait until the fault-injection server is reachable. Useful after a crash
   * fault to wait for the relayer to restart.
   *
   * MANDATORY usage: call this after every operation that might have triggered
   * a fault (your own or a neighbour's). Even sleep-only tests must use it,
   * because a parallel test may have armed `crash` on the same point.
   */
  async waitUntilAlive(timeoutMs: number = 60_000, pollMs: number = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isAlive()) return;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`FaultInjector: relayer at ${this.baseUrl} not reachable after ${timeoutMs}ms`);
  }

  /**
   * Wait until the fault-injection server is unreachable (the relayer has
   * crashed). Use after triggering a flow that hits an `action: 'crash'`
   * cutpoint to block until the crash has been observed.
   *
   * Once this returns, the relayer is DOWN — the caller is responsible for
   * restarting it via `compose.restart(...)` followed by `waitUntilAlive(...)`.
   *
   * Throws on timeout, which typically indicates the fault point was never
   * reached by production code. Default is 60s (was 180s) so a never-reached
   * fault point fails fast instead of blocking the suite for 3 minutes; pass an
   * explicit higher value for flows that legitimately take longer to crash.
   */
  async waitForCrash(timeoutMs: number = 60_000, pollMs: number = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await this.isAlive())) return;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(
      `FaultInjector: relayer at ${this.baseUrl} did not crash within ${timeoutMs / 1000}s — the fault point may not have been reached`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FaultSession — per-test isolation
// ─────────────────────────────────────────────────────────────────────────────

export class FaultSession {
  private readonly base: string;
  readonly id: string;

  constructor(relayerBaseUrl: string, sessionId: string) {
    this.base = relayerBaseUrl.replace(/\/$/, '');
    this.id = sessionId;
  }

  private sessionUrl(): string {
    return `${this.base}/sessions/${encodeURIComponent(this.id)}`;
  }

  /**
   * Arm a fault rule inside this session. If a rule already exists at the same
   * point *in this session*, it is replaced. Rules in other sessions are
   * untouched.
   */
  async arm(rule: FaultRule): Promise<void> {
    try {
      await axios.post(`${this.sessionUrl()}/faults`, rule, { timeout: CONTROL_PLANE_TIMEOUT_MS });
    } catch (err: any) {
      const status = err.response?.status ?? 'N/A';
      const body = err.response?.data ?? err.message;
      throw new Error(`FaultSession[${this.id}].arm failed (${status}): ${JSON.stringify(body)}`);
    }
  }

  /**
   * Disarm a single rule (by point) inside this session.
   */
  async clearPoint(point: string): Promise<void> {
    try {
      await axios.delete(`${this.sessionUrl()}/faults/${encodeURIComponent(point)}`, { timeout: CONTROL_PLANE_TIMEOUT_MS });
    } catch (err: any) {
      const status = err.response?.status ?? 'N/A';
      const body = err.response?.data ?? err.message;
      throw new Error(`FaultSession[${this.id}].clearPoint(${point}) failed (${status}): ${JSON.stringify(body)}`);
    }
  }

  /**
   * Drop every rule in this session (the session and its trigger log survive).
   * Prefer `clear()` in test teardown — it also drops the session.
   */
  async clearAllRules(): Promise<void> {
    try {
      await axios.delete(`${this.sessionUrl()}/faults`, { timeout: CONTROL_PLANE_TIMEOUT_MS });
    } catch (err: any) {
      throw new Error(`FaultSession[${this.id}].clearAllRules failed (${err.response?.status ?? 'N/A'})`);
    }
  }

  /**
   * Drop the entire session: rules, log, metadata. Call in `after()` /
   * `afterAll()` hooks. The session ID becomes invalid after this returns.
   */
  async clear(): Promise<void> {
    try {
      await axios.delete(this.sessionUrl(), { timeout: CONTROL_PLANE_TIMEOUT_MS });
    } catch (err: any) {
      // 404 is acceptable — the session may have been swept by TTL or
      // explicitly dropped by another teardown path.
      if (err.response?.status === 404) return;
      throw new Error(`FaultSession[${this.id}].clear failed (${err.response?.status ?? 'N/A'})`);
    }
  }

  /**
   * Empty the trigger log without dropping any rules. Use case:
   *   1. arm rules,
   *   2. run scenario A,
   *   3. clearLog(),
   *   4. run scenario B,
   *   5. assert only scenario B's triggers are present.
   */
  async clearLog(): Promise<void> {
    try {
      await axios.delete(`${this.sessionUrl()}/log`, { timeout: CONTROL_PLANE_TIMEOUT_MS });
    } catch (err: any) {
      throw new Error(`FaultSession[${this.id}].clearLog failed (${err.response?.status ?? 'N/A'})`);
    }
  }

  /**
   * Full snapshot of the session: rules, log, metadata. The returned object is
   * a value copy — mutating it does not affect the server state.
   */
  async status(): Promise<SessionSnapshot> {
    try {
      const resp = await axios.get(this.sessionUrl(), { timeout: CONTROL_PLANE_TIMEOUT_MS });
      return resp.data as SessionSnapshot;
    } catch (err: any) {
      throw new Error(`FaultSession[${this.id}].status failed (${err.response?.status ?? 'N/A'})`);
    }
  }

  /**
   * Returns `true` iff at least one TriggerEvent for `point` exists in this
   * session's log since `newSession()` or the most recent `clearLog()`.
   *
   * This is a "has it ever happened?" query — it has no implicit time window
   * and does not reset after being read. Use `triggerCount` if you want an
   * exact tally.
   */
  async wasTriggered(point: string): Promise<boolean> {
    const s = await this.status();
    return (s.log || []).some((ev) => ev.point === point);
  }

  /**
   * Returns the exact number of TriggerEvents for `point` in this session's
   * log since `newSession()` or the most recent `clearLog()`.
   */
  async triggerCount(point: string): Promise<number> {
    const s = await this.status();
    return (s.log || []).filter((ev) => ev.point === point).length;
  }

  /**
   * Convenience that bundles the trigger-poll and post-trigger liveness gate
   * required by the authoring contract.
   *
   * Polls `wasTriggered(point)` and `fi.waitUntilAlive` until both succeed or
   * the timeout expires. Throws on timeout. Use after any operation expected
   * to fire `point` to verify it fired AND the relayer survived (relevant when
   * a parallel test might have armed a crash on the same point).
   */
  async assertLiveAfter(point: string, timeoutMs: number = 60_000, pollMs: number = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // 1) is the relayer up?
      let alive = false;
      try {
        const resp = await axios.get(`${this.base}/sessions`, { timeout: 2_000 });
        alive = resp.status === 200;
      } catch {
        alive = false;
      }
      if (alive) {
        // 2) did our point fire?
        try {
          const s = await this.status();
          if ((s.log || []).some((ev) => ev.point === point)) return;
        } catch {
          // session might have been recreated; treat as not-yet
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(
      `FaultSession[${this.id}].assertLiveAfter(${point}): relayer never recovered with the expected trigger within ${timeoutMs}ms`,
    );
  }
}
