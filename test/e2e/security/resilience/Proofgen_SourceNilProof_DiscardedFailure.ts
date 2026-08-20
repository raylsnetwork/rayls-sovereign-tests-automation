// NOTE: Teleport is only the vehicle for a live non-teleport feature — migrate to Enygma/DVP on removal; do not delete this test.
/**
 * @title E2E SECURITY: Source relayer discards a proof-gen failure → ships a nil
 *        proof and records the teleport as a SUCCESS (issue #243)
 *
 * Forces the SOURCE relayer's per-tx Merkle-proof generation to fail once for a
 * teleport (a transient RPC race). On the buggy relayer the error is discarded,
 * the nil proof is dispatched anyway, and the teleport is persisted as
 * `outcome='success'` — the token is stranded with no queryable trace. The fix
 * refuses to ship the nil proof and records `proof_invalid` / `failed` instead.
 *
 * This is the SOURCE-side test for #243. The destination guard (#242) is already
 * in place, so a nil proof no longer crashes the destination — the token is
 * stranded either way for this fault. The test asserts on the SOURCE relayer's
 * `transactions` row, not on destination liveness.
 *
 * The fault point is at the top of Generate, ABOVE the RPC layer the fix retries,
 * so the fix does NOT deliver the token here — it records the failure. (Retry-
 * driven recovery of a real transient is covered by the relayer Go unit tests.)
 *
 * Regression contract (identical code either way):
 *   - Bug: source row `proof_invalid=false` / `outcome='success'` → FAIL.
 *   - Fix: source row `proof_invalid=true`  / `outcome!='success'` → PASS.
 *
 * @serial — the one-shot fault must be consumed by our teleport, not a stray
 * in-flight message (asserted via triggerCount === 1).
 *
 * Fault point: private_relayer.proofgen.ProofGenerator.Generate.start (no-op in
 * untagged builds). Related: relayer-api #243 (fix), #242 (destination guard).
 */

import { ethers } from 'ethers';
import { expect } from 'chai';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { ERC721Wrapper } from '../../../../src/entities/tokens/ERC721Wrapper';
import { delay, eventually, never, submitTx } from '../../../../src/utils/common';
import { FaultInjector, FaultSession, FAULT_POINTS } from '../../../../src/utils/fault-injector';
import { queryOne } from '../../../../src/utils/pg-client';
import { EndpointV1, ProductionErc721Token, ProductionErc721Token__factory } from '../../../../typechain-types';

// SOURCE relayer (relayer-a) postgres. The compose stack exposes postgres on
// 127.0.0.1:5432 and /etc/hosts aliases `postgres` → 127.0.0.1, so the literal
// hostname stays consistent with the relayer .env files. The SOURCE relayer for
// an A→B teleport is relayer-a, whose CrossChainService generates the proof and
// persists the source-side `transactions` row.
const RELAYER_A_DB_CS =
  process.env.RELAYER_A_DB_CS ??
  process.env.PRIVACY_NODE_A_DB_CS ??
  'postgres://admin:admin@postgres:5432/relayerA?sslmode=disable';

// ── Timing constants ─────────────────────────────────────────────────────
// Let the source relayer's cross-chain pipeline go quiet before arming, so the
// one-shot proof-gen fault is consumed by OUR teleport and not by a stray
// in-flight message from setup or a neighbouring test.
const PRE_ARM_SETTLE_MS = 30_000;

// After the teleport, wait this long for the one-shot fault to actually fire on
// relayer-a (i.e. the proof was attempted and the rule spent).
const FAULT_FIRED_TIMEOUT_MS = 90_000;
const FAULT_FIRED_POLL_MS = 2_000;

// Budget to wait for the source relayer to finalise the teleport's row.
const SRC_ROW_POLL_MS = 5_000;
const SRC_ROW_ATTEMPTS = 60; // ~5 min

// Window over which non-delivery on PN-B is asserted as a temporal invariant
// (via `never`): long enough for the (buggy) nil proof to reach relayer-b and be
// rejected, or for the (fixed) source to have skipped it — the token is never
// delivered in either case.
const DELIVERY_GRACE_MS = 30_000;
const NON_DELIVERY_POLL_MS = 5_000;

interface SourceTxRow {
  shared_id: string;
  state: number;
  outcome: string;
  proof_invalid: boolean;
}

describe('E2E SECURITY: Source relayer discards proof-gen failure → ships nil proof, records success @serial', function () {
  this.timeout(DEFAULT_TIMEOUT * 10);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  let nft: ERC721Wrapper<ProductionErc721Token>;
  let tokenId: bigint;

  // Source relayer (relayer-a, FI port 6660): where we arm the proof-gen fault.
  let faultA: FaultInjector;
  let sessionA: FaultSession | undefined;

  // Delivery probe for the teleported token on PN-B. Non-throwing: returns
  // false while the destination contract is undeployed or the token unminted.
  const tokenDeliveredOnB = async (): Promise<boolean> => {
    try {
      const endpoint = privacyNodes.B.getContract<EndpointV1>('EndpointV1');
      const addr = await endpoint.getAddressByResourceId(nft.resourceId);
      if (!addr || addr === ethers.ZeroAddress) return false;
      const tokenOnB = ProductionErc721Token__factory.connect(addr, privacyNodes.B.provider);
      const owner = await tokenOnB.ownerOf(tokenId);
      return owner.toLowerCase() === nft.userWallet.address.toLowerCase();
    } catch {
      return false;
    }
  };

  before(async function () {
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    LOGGER.log('\n   SETUP');
    LOGGER.log('   ─────────────────────────────────────────────────');

    faultA = FaultInjector.forRelayer('A', '127.0.0.1');
    expect(await faultA.isAlive()).to.equal(true,
      'Fault-injection API must be reachable on relayer-a (port 6660). ' +
      'Ensure FAULT_INJECTION_ENABLED=true in .A.env and port 6660 is exposed.');

    sessionA = await faultA.newSession();
    LOGGER.log(`   FI reachable on relayer-a (session ${sessionA.id})`);

    // Register + mint one fresh ERC721 on PN-A (vanilla path — the forward
    // teleport goes through the source CrossChainService.BatchGenerate).
    nft = new ERC721Wrapper<ProductionErc721Token>(privacyNodes.A, ProductionErc721Token__factory);
    await nft.deploy();
    await nft.activateOnPn();
    await nft.activateOnHub(privateHub);
    tokenId = await nft.mintAndAwait(privateHub, { toAddress: nft.userWallet.address });
    LOGGER.log(`   Registered ERC721 ${nft.symbol}; minted #${tokenId} on PN-A`);

    LOGGER.log(`   Settling ${PRE_ARM_SETTLE_MS / 1000}s so the one-shot fault fires on OUR teleport...`);
    await delay(PRE_ARM_SETTLE_MS);
    LOGGER.log('   Setup complete\n');
  });

  after(async function () {
    try {
      if (sessionA) await sessionA.clear();
    } catch { /* best-effort cleanup */ }
  });

  it('a discarded source proof-gen failure must not ship a nil proof nor be recorded as a success', async function () {
    LOGGER.log('================================================================');
    LOGGER.log('   Source nil-proof — a discarded failure must be observable, not recorded as success');
    LOGGER.log('================================================================');

    // ── 0. Relayer alive; the token is not yet on B. ───────────────────────
    expect(await faultA.isAlive()).to.equal(true, 'relayer-a must be alive before arming the fault');
    expect(await tokenDeliveredOnB()).to.equal(false, 'token must not be on B before its teleport');
    LOGGER.log('\n   0. relayer-a is alive; token not yet on B');

    // ── 1. Arm the one-shot proof-gen failure on the SOURCE relayer. ───────
    //    `error` (not crash): Generate returns an error. Buggy build discards it
    //    and dispatches the nil proof; the fix refuses to ship it and records it.
    LOGGER.log('\n   1. Arming one-shot proof-gen failure on relayer-a (SOURCE)');
    LOGGER.log(`      point: ${FAULT_POINTS.PROOFGEN_GENERATE_START}`);
    await sessionA!.arm({
      point: FAULT_POINTS.PROOFGEN_GENERATE_START,
      action: 'error',
      one_shot: true,
      message: 'transient proof-generation failure (issue #243 repro)',
    });
    expect((await sessionA!.status()).rules[FAULT_POINTS.PROOFGEN_GENERATE_START]).to.exist;
    expect(await faultA.isAlive()).to.equal(true, 'relayer-a must stay alive after arming an error fault');
    LOGGER.log('      Rule armed: proof-gen fail -> error (one-shot)');

    // ── 2. Teleport A → B. submitTx asserts the burn mined on PN-A. ────────
    LOGGER.log(`\n   2. Teleport ERC721 #${tokenId} A -> B (chainId ${privacyNodes.B.chainId})`);
    const burn = await submitTx(
      () => nft.contract.teleport(
        nft.userWallet.address,
        tokenId,
        privacyNodes.B.chainId,
        { gasLimit: GAS_LIMIT },
      ),
      `Teleport NFT #${tokenId} A -> B (proof gen will fail)`,
    );
    const sourceTxHash = burn.hash;
    LOGGER.log(`      Burn confirmed on PN-A: ${sourceTxHash} (block ${burn.blockNumber})`);

    // ── 3. Wait until the fault actually fires on relayer-a, and confirm it
    //    fired EXACTLY once — on OUR teleport. If a stray relayer-a proof
    //    generation consumed the one-shot, the teleport would have shipped a
    //    valid proof and this run would not exercise the nil-proof path. Run
    //    serially, with no other relayer-a cross-chain traffic.
    LOGGER.log('\n   3. Waiting for the proof-gen fault to fire on relayer-a (one-shot consumed)...');
    await eventually<boolean>({
      check: async () => sessionA!.wasTriggered(FAULT_POINTS.PROOFGEN_GENERATE_START),
      interval: FAULT_FIRED_POLL_MS,
      attempts: Math.ceil(FAULT_FIRED_TIMEOUT_MS / FAULT_FIRED_POLL_MS),
      tolerateErrors: true,
      message: 'Waiting for the source proof-gen fault to fire',
    });
    const firedCount = await sessionA!.triggerCount(FAULT_POINTS.PROOFGEN_GENERATE_START);
    expect(firedCount).to.equal(1,
      `expected the one-shot proof-gen fault to fire exactly once (on our teleport); it fired ${firedCount} ` +
      `time(s). A stray source proof generation likely consumed the one-shot, so the teleport may have shipped ` +
      `a valid proof and this run would not exercise the nil-proof path. Run this test serially with no other ` +
      `relayer-a cross-chain traffic.`);
    LOGGER.log('      Fault fired exactly once: relayer-a hit the proof-gen failure for our teleport');

    // Mandatory post-trigger liveness gate: confirm the
    // source relayer is alive before reading post-state. The `error` action does
    // not crash relayer-a, but this surfaces "relayer is down" immediately (e.g.
    // a stray `crash` armed on the same point) instead of letting the step-4 DB
    // poll burn its full budget on a misleading "row never finalised" timeout.
    await faultA.waitUntilAlive(60_000);

    // ── 4. Read the SOURCE relayer-a row for this teleport. The source
    //    `transactions.tx_hash` stores the ORIGINATING PN-A burn tx hash, so we
    //    key off `sourceTxHash` — no fragile "most-recent-row" heuristic.
    LOGGER.log('\n   4. Reading the SOURCE relayer-a transactions row for this teleport');
    const srcRow = await eventually<SourceTxRow>({
      check: async () => {
        const row = await queryOne<SourceTxRow>(
          RELAYER_A_DB_CS,
          `SELECT shared_id, state, outcome, proof_invalid
             FROM transactions
             WHERE LOWER(tx_hash) = LOWER($1)
               AND outcome IN ('success', 'reverted', 'failed')
             ORDER BY created_at DESC
             LIMIT 1`,
          [sourceTxHash],
        );
        return row ?? undefined;
      },
      message: 'Waiting for relayer-a to finalise the source transaction row',
      interval: SRC_ROW_POLL_MS,
      attempts: SRC_ROW_ATTEMPTS,
      tolerateErrors: true,
    });

    LOGGER.log(`      shared_id:     ${srcRow.shared_id}`);
    LOGGER.log(`      state:         ${srcRow.state}   (1=SourcePublish)`);
    LOGGER.log(`      outcome:       ${srcRow.outcome}   (bug: 'success'; fix: 'failed')`);
    LOGGER.log(`      proof_invalid: ${srcRow.proof_invalid}   (bug: false; fix: true)`);

    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   REGRESSION ASSERTIONS');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');

    // (a) The core #243 observability guarantee: a proof-gen failure must be
    //     flagged for recovery. The buggy build never sets proof_invalid, so this
    //     is the unconditional backstop; checked first to fail fast.
    expect(srcRow.proof_invalid).to.equal(true,
      `NIL-PROOF DISCARD REPRODUCED (issue #243): the source relayer generated a nil proof for teleport ` +
      `${sourceTxHash} and recorded proof_invalid=${srcRow.proof_invalid} (outcome='${srcRow.outcome}'). A ` +
      `proof-generation failure must be flagged proof_invalid=true so the stranded teleport is queryable and ` +
      `alertable for recovery. The fix must refuse to dispatch the nil proof and record the failure. ` +
      `Observed source row: ${JSON.stringify(srcRow)}.`);

    // (b) A proof-generation FAILURE must never be recorded as a SUCCESS.
    expect(srcRow.outcome).to.not.equal('success',
      `NIL-PROOF DISCARD REPRODUCED (issue #243): the source relayer recorded a proof-generation FAILURE as ` +
      `outcome='success' for teleport ${sourceTxHash} — a nil proof was shipped and the teleport marked ` +
      `successful while the token is stranded. The fix must record a non-success terminal outcome. ` +
      `Observed source row: ${JSON.stringify(srcRow)}.`);

    // (c) Impact (shared invariant): the teleported token must NOT be delivered on
    //     PN-B for this non-recoverable proof failure. Asserted as a temporal
    //     invariant with `never` (per CLAUDE.md, negative governance uses `never`,
    //     not `delay`+check): a delivery at any point in the window fails fast.
    //     Holds on both builds (bug: nil proof rejected by the #242 guard; fix:
    //     nil proof never shipped) — a delivery would mean the fault did not break
    //     proof generation, making the test vacuous.
    LOGGER.log(`\n   5. Confirming non-delivery on PN-B over ${DELIVERY_GRACE_MS / 1000}s...`);
    // poll() only delays *between* attempts, so N attempts span (N-1) gaps. Add one
    // so the polled window (first check at t=0 → last at t=DELIVERY_GRACE_MS) truly
    // covers DELIVERY_GRACE_MS rather than one interval short.
    await never<boolean>({
      check: tokenDeliveredOnB,
      message:
        `token #${tokenId} must not be delivered on PN-B — a source proof-gen failure must strand the ` +
        `teleport (a delivery means the fault did not break proof generation, making the test vacuous)`,
      interval: NON_DELIVERY_POLL_MS,
      attempts: Math.ceil(DELIVERY_GRACE_MS / NON_DELIVERY_POLL_MS) + 1,
    });
    LOGGER.log(`      token #${tokenId} not delivered on B (stranded, as expected)`);

    LOGGER.log('\n================================================================');
    LOGGER.log('   PASSED: source refused to ship the nil proof and recorded an observable failure');
    LOGGER.log('================================================================');
  });
});
