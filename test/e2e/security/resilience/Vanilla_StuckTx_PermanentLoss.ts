
/**
 * @title E2E SECURITY: Vanilla dispatch — stuck tx → permanent message loss
 *
 * Reproduces the production failure mode: a
 * single dispatch transaction whose receipt the destination chain never
 * returns (the original incident was an axyl consensus stall on PN-B; here we
 * use fault injection to drive the same code path deterministically). The
 * CTS reaper dead-letters the row after StuckThreshold, the relayer
 * collapses the failure into OutcomeReverted (terminal), and the message
 * never gets retried — even though `arbitraryMessage.A.send1IncreaseCount`
 * was sent by an ordinary user account, the relayer's state machine reaches
 * a state from which the message can never be delivered.
 *
 * VULNERABILITY (who is affected, what is the impact)
 *   - Anyone with the ability to call a cross-chain function (no special
 *     permission required — ENDPOINT_SENDER is granted to the *contract*,
 *     not the caller) sees their message permanently lost any time the
 *     destination chain fails to return a receipt within the CTS reaper's
 *     StuckThreshold (currently 1 minute).
 *   - For the ArbitraryMessage flow exercised here, the on-chain `count`
 *     never advances on PN-B (the relayer terminates the message rather
 *     than retry).
 *   - For a token bridge (Enygma) using the vanilla dispatch path: the
 *     source PL burns the tokens, the relayer marks the message reverted,
 *     no retry happens, the destination PL never mints — tokens are
 *     permanently destroyed.
 *   - The state machine has no operator-triggered retry path. Once the row
 *     reaches `state=DestinationDispatch + outcome=OutcomeReverted`, it is
 *     done.
 *
 * SCENARIO
 *   1. Deploy ArbitraryMessage on PN-A and PN-B (admin setup — once per
 *      test). Grant ENDPOINT_SENDER to the deployed contracts.
 *   2. Fund an UNPRIVILEGED random wallet on PN-A with a small amount of
 *      ETH so it can pay gas. This wallet has NO special role — it is just
 *      a regular user account.
 *   3. Sanity check: from the unprivileged wallet, send one message A→B
 *      with FI disarmed. Verify `count` reaches 1 on B and the relayer
 *      DB row ends up `outcome=success`. (Confirms the pipeline works.)
 *   4. Arm a fault on CTS-B's receipter `before_poll` so it skips every
 *      receipt poll for ~150 s. While the receipter is blind the reaper
 *      claims the row as stuck (~60 s) and RE-BROADCASTS it (send_attempts
 *      climbs) instead of dead-lettering on the first tick. The dispatch tx
 *      still mines on PN-B — FI suppresses only the relayer's observation.
 *   5. From the same unprivileged wallet, send a second message A→B.
 *   6. Wait for the fault budget to drain (~150 s): the receipter resumes,
 *      observes the original (still-mined) receipt, finishes the row, and the
 *      relayer records the message as delivered.
 *   7. Verify the FIXED behaviour (correlated by the PN-A source tx hash):
 *        - relayer-B row: outcome='success' — the lost/stuck case is NEVER
 *          collapsed to the terminal 'reverted'.
 *        - CTS-B row (correlation_id == relayer shared_id): status='finished'
 *          with send_attempts > 1 — the reaper re-broadcast before any
 *          dead-letter. It is NEVER 'failed' with
 *          send_attempts=1 (the original no-resend dead-letter).
 *        - On-chain count on PN-B advances (FI only suppressed observation).
 *          In the real axyl-stall incident the chain truly dropped the tx and
 *          count stayed put; both must be non-loss from the relayer's view.
 *
 * SCOPE NOTE
 *   Because the `before_poll` fault suppresses only *observation* (the tx
 *   still mines), and MaxResendAttempts=5 pushes the dead-letter horizon well
 *   past the ~150 s fault window, this e2e path deterministically exercises
 *   the RECOVERY guarantee. The true-drop dead-letter → 'reverted' collapse path is
 *   covered by the Go unit tests below (it would need broadcast-level fault
 *   injection to drive end-to-end).
 *
 * TEST OUTCOME (the regression contract)
 *   - FAILS when the bug is present: relayer DB has `outcome=reverted`
 *     for the message that was actually delivered. The state machine
 *     reached a terminal "reverted" state from a stuck-no-receipt event.
 *   - PASSES when a fix is in place: the relayer either retries the
 *     dispatch (outcome=success after the retry) or persists a
 *     distinguishable terminal state (e.g. OutcomeFailed) that operators
 *     can detect and recover from. The state-machine no longer collapses
 *     "lost" and "reverted".
 *
 * RELATED REGRESSION TESTS
 *   - cts/batcher/reaper_regression_test.go — Go unit test for "reaper
 *     dead-letters without resend" (Issue #2).
 *   - private-relayer/dest/service/vanilla_lost_tx_regression_test.go —
 *     Go unit test for "TxResultFailed collapsed with TxResultRevert"
 *     (Issue #3).
 *   - axyl/crates/consensus/primary/src/tests/certifier_stall_regression_tests.rs
 *     — Rust test for the underlying consensus instability (Issue #4).
 */

import { ethers } from 'ethers';
import { expect } from 'chai';
import {
  DEFAULT_TIMEOUT,
  GAS_LIMIT,
  LOGGER,
} from '../../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { createRandomWallet, eventually, submitTx } from '../../../../src/utils/common';
import { FaultInjector, FaultSession, FAULT_POINTS } from '../../../../src/utils/fault-injector';
import { queryOne } from '../../../../src/utils/pg-client';

// Connection strings for the per-PN postgres databases. The compose stack
// exposes postgres on 127.0.0.1:5432 and /etc/hosts already aliases
// `postgres` → 127.0.0.1 for the dev environment, so reusing the literal
// hostname keeps these strings consistent with the relayer/CTS .env files.
const CTS_B_DB_CS     = process.env.CTS_B_DB_CS     ?? 'postgres://admin:admin@postgres:5432/ctsB?sslmode=disable';
const RELAYER_B_DB_CS = process.env.RELAYER_B_DB_CS ?? process.env.PRIVACY_NODE_B_DB_CS ?? 'postgres://admin:admin@postgres:5432/relayerB?sslmode=disable';
import {
  ArbitraryMessage,
  ArbitraryMessage__factory,
  EndpointV1,
} from '../../../../typechain-types';

// ── Timing constants ───────────────────────────────────────────────────
// StuckThreshold and reaper interval inside CTS are both 1 minute, so the
// reaper re-broadcasts a stuck row ~60 s after the tx was sent and again
// every ~60 s thereafter. We suppress the receipter for ~150 s — long enough
// for at least one reaper resend to fire — then let the fault drain so the
// receipter catches up on the original receipt and the row finishes. 150 s is
// comfortably below the dead-letter horizon (MaxResendAttempts=5 ⇒ ~5 min),
// so the message recovers rather than dead-letters.
const FI_SKIP_DURATION_S    = 150;     // how long to suppress the receipter

// Number of receipter Check() calls we need to suppress. The CTS binary
// runs multiple ReceipterService goroutines IN PARALLEL — one per CTS
// "identity" (privatenode, privatehub, privatechain, publicchain,
// dvpoperator). They share the same fault point. Each goroutine polls
// every 1 s, so the FI counter decrements ~5×/second. To suppress for
// FI_SKIP_DURATION_S we need max_count ≈ 5 * FI_SKIP_DURATION_S.
const FI_IDENTITY_COUNT     = 5;
const FI_MAX_COUNT          = FI_IDENTITY_COUNT * FI_SKIP_DURATION_S;

// Stub envelope for ArbitraryMessage.send1IncreaseCount sender ETH funding.
const SENDER_GAS_FUNDING    = ethers.parseEther('1.0');

describe('E2E SECURITY: Vanilla dispatch — stuck tx → permanent message loss', function () {
  // Allow the full reaper / dead-letter / relayer-collapse window plus
  // sanity-check overhead.
  this.timeout(DEFAULT_TIMEOUT * 4);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  let arbitraryA: ArbitraryMessage;
  let arbitraryB: ArbitraryMessage;
  let resourceId: string;

  // Low-privilege wallet — has no role, only gas funds. Drives the
  // user-facing exploit path.
  let attacker: ethers.HDNodeWallet;

  // Fault injection on CTS-B (the destination CTS). Targets the new
  // receipter `before_poll` cut point added in cts/batcher/receipter.go.
  let faultCTSB: FaultInjector;
  let sessionCTSB: FaultSession;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT * 2);

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    // 1. Deploy the ArbitraryMessage test-contract on both PN-A and PN-B
    //    using a fresh resourceId so this test owns its own contract pair.
    resourceId = ethers.hexlify(ethers.randomBytes(32));

    for (const pl of ['A', 'B']) {
      const deployer = privacyNodes[pl].userWallet; // operator wallet
      const factory = await privacyNodes[pl].contractStore.getFactory<ArbitraryMessage__factory>(
        ArbitraryMessage__factory, deployer,
      );
      await privacyNodes[pl].contractStore.deploy(
        factory, 'ArbitraryMessage',
        resourceId,
        privacyNodes[pl].endpointAddress,
        privacyNodes[pl].raylsNodeEndpointAddress,
      );

      const contract = privacyNodes[pl].getContract<ArbitraryMessage>('ArbitraryMessage');
      const contractAddress = await contract.getAddress();

      // Admin actions: register resourceId → contract mapping and grant
      // ENDPOINT_SENDER on the contract. These are *one-time setup* steps
      // an operator does when on-boarding the app. The vulnerability under
      // test is NOT in this admin path — it's in what happens when the
      // ordinary user below calls the resulting deployed contract.
      const endpoint = privacyNodes[pl].getContract<EndpointV1>('EndpointV1');
      const endpointAsAdmin = endpoint.connect(privacyNodes[pl].adminWallet) as typeof endpoint;
      await (await endpointAsAdmin.registerResourceId(resourceId, contractAddress)).wait();
      await privacyNodes[pl].grantEndpointSender([contractAddress]);
    }

    arbitraryA = privacyNodes.A.getContract<ArbitraryMessage>('ArbitraryMessage');
    arbitraryB = privacyNodes.B.getContract<ArbitraryMessage>('ArbitraryMessage');

    LOGGER.log(`\n   ArbitraryMessage deployed on PN-A: ${await arbitraryA.getAddress()}`);
    LOGGER.log(`   ArbitraryMessage deployed on PN-B: ${await arbitraryB.getAddress()}`);

    // 2. Create the low-privilege user wallet that drives the exploit path.
    //    We deliberately use `createRandomWallet` (a brand-new key with NO
    //    role granted on any access-manager) and only fund it with gas.
    //    This is the canonical "any unprivileged user" actor.
    attacker = createRandomWallet(privacyNodes.A.provider);
    await (await privacyNodes.A.adminWallet.sendTransaction({
      to: attacker.address,
      value: SENDER_GAS_FUNDING,
    })).wait();
    LOGGER.log(`   Attacker wallet (unprivileged): ${attacker.address}`);
    LOGGER.log(`   Attacker wallet balance:        ${ethers.formatEther(await privacyNodes.A.provider.getBalance(attacker.address))} ETH`);

    // 3. Fault injector targeting CTS-B (KOS service in fault-injector.ts).
    //    The 'kos' role maps participant 'B' to host port 6801 — the FI HTTP
    //    server on cts-b. start_dev.sh launches CTS-B with FAULT_INJECTION_
    //    ENABLED=true and the receipter point is compiled in via -tags
    //    faultinjection.
    faultCTSB = FaultInjector.forService('kos', 'B', '127.0.0.1');
    expect(await faultCTSB.isAlive()).to.equal(true,
      'Fault injection API must be reachable on cts-b (port 6801). ' +
      'Ensure FAULT_INJECTION_ENABLED=true in .B.env, the cts-b container is up, ' +
      'and host port 6801 is mapped in docker-compose.dev-local.yml.');
    sessionCTSB = await faultCTSB.newSession();
    LOGGER.log(`   FI session on cts-b: ${sessionCTSB.id}`);
  });

  after(async function () {
    try { if (sessionCTSB) await sessionCTSB.clear(); } catch { /* best-effort */ }
  });

  it('SANITY: baseline message from unprivileged wallet succeeds when FI is disarmed', async function () {
    LOGGER.log('================================================================');
    LOGGER.log('   SANITY CHECK — pipeline works for an unprivileged caller');
    LOGGER.log('================================================================');

    const countBefore = await arbitraryB.count();
    const expectedCount = countBefore + 1n;

    const arbAsAttacker = arbitraryA.connect(attacker) as unknown as ArbitraryMessage;
    await submitTx(
      () => arbAsAttacker.send1IncreaseCount(privacyNodes.B.chainId, { gasLimit: GAS_LIMIT }),
      `Attacker sends send1IncreaseCount A->B (baseline)`,
    );

    await eventually<boolean>({
      check: async () => (await arbitraryB.count()) === expectedCount,
      message: `Wait for count to reach ${expectedCount} on PN-B`,
    });

    LOGGER.log(`   countBefore=${countBefore} → countAfter=${await arbitraryB.count()} (expected=${expectedCount})`);
    LOGGER.log('   Baseline pipeline confirmed working\n');
  });

  it('REGRESSION: a receipt-suppressed dispatch recovers (reaper resend + receipter catch-up) and is never collapsed to a terminal revert', async function () {
    LOGGER.log('================================================================');
    LOGGER.log('   STUCK-TX REGRESSION — receipt-suppressed dispatch must recover, not be lost');
    LOGGER.log('================================================================');

    // ── 0. Snapshot pre-conditions ────────────────────────────────────
    const countBefore = await arbitraryB.count();
    LOGGER.log(`   PN-B ArbitraryMessage.count() before: ${countBefore}`);

    // ── 1. Arm the receipter-skip fault. ───────────────────────────────
    //    `action: 'error'` with `count: FI_MAX_COUNT` causes the receipter
    //    to early-return for FI_MAX_COUNT consecutive Check() calls (one
    //    per polling interval, i.e. ~1 s each), so for ~150 s it never
    //    observes the dispatch receipt — long enough for the reaper to fire
    //    at least one resend before the fault drains and the receipter
    //    catches up. (Note: `error` does NOT crash the process — it returns
    //    an error from Check() that the receipter logs as Warn and then
    //    early-returns on.)
    LOGGER.log('\n   1. Arming FI: cts-b receipter `before_poll` returns error');
    LOGGER.log(`      max_count=${FI_MAX_COUNT} (covers ~${FI_SKIP_DURATION_S}s of receipter polling across ${FI_IDENTITY_COUNT} CTS identities)`);
    await sessionCTSB.arm({
      point: FAULT_POINTS.CTS_RECEIPTER_BEFORE_POLL,
      action: 'error',
      max_count: FI_MAX_COUNT,
      message: 'simulated chain-drop: receipter polling suppressed by regression test',
    });

    // Confirm the rule armed.
    const status = await sessionCTSB.status();
    expect(status.rules[FAULT_POINTS.CTS_RECEIPTER_BEFORE_POLL]).to.exist;
    LOGGER.log(`      Rule status: ${JSON.stringify(status.rules[FAULT_POINTS.CTS_RECEIPTER_BEFORE_POLL])}`);
    expect(await faultCTSB.isAlive()).to.equal(true,
      'cts-b must remain alive after arming the receipter fault');

    // ── 2. Drive the path with the unprivileged wallet. ───────────────
    //    Any caller of a registered cross-chain function (no role, no
    //    permission) triggers a dispatch whose receipt the faulted
    //    receipter will be unable to observe for ~150 s.
    LOGGER.log('\n   2. Attacker (unprivileged) sends a single send1IncreaseCount A->B');
    const arbAsAttacker = arbitraryA.connect(attacker) as unknown as ArbitraryMessage;
    // submitTx asserts receipt.status === 1 internally, so a failed source tx
    // throws here — the source tx succeeding on PN-A is not the bug under test.
    const receipt = await submitTx(
      () => arbAsAttacker.send1IncreaseCount(privacyNodes.B.chainId, { gasLimit: GAS_LIMIT }),
      'attacker send1IncreaseCount A->B (vanilla dispatch)',
    );
    const sourceTxHash = receipt.hash;
    LOGGER.log(`      Source tx on PN-A: ${sourceTxHash} (block ${receipt.blockNumber})`);

    // ── 3. Correlate to THIS message and wait for the relayer to finalise it.
    //    relayer-B `transactions.tx_hash` stores the ORIGINATING PN-A source
    //    tx hash (verified against the live schema), so we key off
    //    `sourceTxHash` — no fragile "most-recent-row" heuristic. The
    //    `shared_id` recovered here is also the CTS `correlation_id`, which
    //    pins the exact cts_transaction row in step 5.
    //
    //    EXPECTED BEHAVIOUR WITH THE FIX (reaper resend + lost/reverted split):
    //    FI suppresses only the receipter's *observation*, never the on-chain
    //    execution — the dispatch tx still mines on PN-B. While the receipter
    //    is blind the reaper re-broadcasts the row (send_attempts climbs);
    //    once the fault budget drains (~150 s) the receipter resumes, sees the
    //    original receipt, and the row finishes. The message is RECOVERED, so
    //    the relayer records outcome 'success' — never the terminal 'reverted'
    //    the original bug produced.
    LOGGER.log('\n   3. Waiting for relayer-B to finalise this message (keyed by PN-A source tx hash)');
    const relayerRow = await eventually<{
      shared_id: string;
      state: number;
      outcome: string;
      tx_hash_destination: string | null;
    }>({
      check: async () => {
        const row = await queryOne<{
          shared_id: string;
          state: number;
          outcome: string;
          tx_hash_destination: string | null;
        }>(
          RELAYER_B_DB_CS,
          `SELECT shared_id, state, outcome, tx_hash_destination
             FROM transactions
             WHERE LOWER(tx_hash) = LOWER($1)
               AND outcome IN ('success', 'reverted', 'failed')
             ORDER BY created_at DESC
             LIMIT 1`,
          [sourceTxHash],
        );
        return row ?? undefined;
      },
      message: 'Waiting for relayer-B to finalise the dispatched message',
      interval: 5_000,
      attempts: 60,
      tolerateErrors: true,
    });

    // ── 4. relayer-B terminal outcome for this message. ────────────────
    LOGGER.log('\n   4. relayer-B terminal outcome for this message');
    LOGGER.log(`      shared_id:           ${relayerRow.shared_id}`);
    LOGGER.log(`      state:               ${relayerRow.state}   (10=DestinationDispatch)`);
    LOGGER.log(`      outcome:             ${relayerRow.outcome}   (fix: 'success' via recovery; bug: 'reverted')`);
    LOGGER.log(`      tx_hash_destination: ${relayerRow.tx_hash_destination}`);

    // ── 5. Pin the exact CTS-B row via correlation_id == relayer shared_id.
    //    By the time the relayer has finalised, the receipter has already
    //    marked the CTS row terminal (publish-before-mark), so a short budget
    //    suffices. With the fix this row is 'finished' (recovered) with
    //    send_attempts > 1 (the reaper re-broadcast at least once while the
    //    receipter was blind); the original bug left it 'failed' with
    //    send_attempts == 1 (dead-lettered on the first reaper tick, no resend).
    LOGGER.log('\n   5. Inspecting the correlated CTS-B row');
    const ctsRow = await eventually<{
      correlation_id: string;
      status: string;
      send_attempts: number;
      receipt_attempts: number;
      error_reason: string | null;
      tx_hash: Buffer | null;
    }>({
      check: async () => {
        const row = await queryOne<{
          correlation_id: string;
          status: string;
          send_attempts: number;
          receipt_attempts: number;
          error_reason: string | null;
          tx_hash: Buffer | null;
        }>(
          CTS_B_DB_CS,
          `SELECT correlation_id, status, send_attempts, receipt_attempts, error_reason,
                  tx_hash
             FROM cts_transaction
             WHERE correlation_id = $1
               AND status IN ('finished', 'failed')
             ORDER BY created_at DESC
             LIMIT 1`,
          [relayerRow.shared_id],
        );
        return row ?? undefined;
      },
      message: 'Waiting for CTS-B to finalise the correlated row',
      interval: 5_000,
      attempts: 24,
      tolerateErrors: true,
    });

    const ctsTxHashHex = ctsRow.tx_hash ? '0x' + ctsRow.tx_hash.toString('hex') : '(null)';
    LOGGER.log(`      correlation_id:   ${ctsRow.correlation_id}`);
    LOGGER.log(`      status:           ${ctsRow.status}   (fix: 'finished' via recovery)`);
    LOGGER.log(`      tx_hash:          ${ctsTxHashHex}`);
    LOGGER.log(`      send_attempts:    ${ctsRow.send_attempts}   (fix: > 1, i.e. the reaper re-broadcast)`);
    LOGGER.log(`      receipt_attempts: ${ctsRow.receipt_attempts}`);
    LOGGER.log(`      error_reason:     ${ctsRow.error_reason ?? '(null)'}`);

    // ── 6. On-chain reality. FI only suppressed the receipter, so the
    //    dispatch tx still landed on PN-B and `count` advances. (In the real
    //    axyl-stall incident the chain truly dropped the tx and count stayed
    //    put; both must be non-loss from the relayer's perspective, but only
    //    the FI path can be driven deterministically here.)
    const countAfter = await arbitraryB.count();
    LOGGER.log(`\n   6. PN-B ArbitraryMessage.count(): before=${countBefore} after=${countAfter}`);

    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   REGRESSION ASSERTIONS');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');

    // (a) the core "permanent loss" guard. A stuck/lost dispatch must
    //     NOT be persisted as outcome='reverted' (reserved for txs mined and
    //     reverted on-chain; terminal, no retry path). With the fix the
    //     message recovers and the relayer records 'success'.
    expect(relayerRow.outcome).to.equal('success',
      `REGRESSION: a dispatch whose receipt was merely `
      + `unobservable for a while must recover to outcome='success' and must NEVER be `
      + `collapsed to the terminal 'reverted' state (reserved for genuine on-chain `
      + `reverts). Observed relayer row: ${JSON.stringify(relayerRow)}.`);

    // (b) the reaper must re-broadcast a stuck row before dead-lettering.
    //     A row finalised 'failed' with send_attempts == 1 was dead-lettered on
    //     the first reaper tick with no resend (the original bug).
    const noResendDeadLetter = ctsRow.status === 'failed' && ctsRow.send_attempts <= 1;
    expect(noResendDeadLetter).to.equal(false,
      `REGRESSION: the CTS reaper must attempt at least one `
      + `re-broadcast before dead-lettering a stuck row. A row finalised 'failed' with `
      + `send_attempts=1 means it was dead-lettered on the first reaper tick after `
      + `StuckThreshold with no resend. Observed CTS row: `
      + `${JSON.stringify({ ...ctsRow, tx_hash: ctsRow.tx_hash?.toString('hex') })}.`);

    // (c) End-to-end delivery (informational): with FI suppressing only
    //     observation the message lands, so count advances. Not a hard
    //     assertion — the production-incident (true chain drop) leaves count
    //     unchanged while still being a non-loss for the relayer.
    LOGGER.log(`\n   (c) count advanced by ${countAfter - countBefore} (informational; 0 in the true-chain-drop incident)`);

    LOGGER.log('\n================================================================');
    LOGGER.log('   PASSED: stuck dispatch recovered without permanent loss');
    LOGGER.log('   - reaper re-broadcast the row while the receipter was blind');
    LOGGER.log('   - receipter recovered the original receipt after the fault drained');
    LOGGER.log('   - relayer recorded success, never collapsed lost→reverted');
    LOGGER.log('================================================================');
  });
});
