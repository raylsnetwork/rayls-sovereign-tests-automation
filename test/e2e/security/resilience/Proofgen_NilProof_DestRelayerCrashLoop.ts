// NOTE: Teleport is only the vehicle for a live non-teleport feature — migrate to Enygma/DVP on removal; do not delete this test.
/**
 * @title E2E SECURITY: Nil/malformed cross-chain proof → destination relayer SIGSEGV + crash-loop
 *
 * REPRODUCES THE EXPLOIT BY: forcing the SOURCE relayer's per-tx Merkle-proof
 * generation to fail once (mirroring a transient RPC race). BatchGenerate
 * swallows that error and leaves the proof slot nil, so the source ships a
 * message carrying a nil/empty proof to the destination. The destination's
 * verifyProofs calls proofs.NewProofDB().Import(nil), which returns a nil
 * *ProofDB, and passes it straight into trie.VerifyProof → Get on a nil
 * receiver → SIGSEGV. The panic kills the destination relayer.
 *
 * IMPACT (measured here, not assumed):
 *   - The poison message is only acked AFTER successful processing, so it is
 *     never acked. NATS JetStream redelivers it (default ~30s AckWait) up to
 *     MaxDeliver=10 times (msgqueue/manager.go), crashing the destination each
 *     time it is redelivered — a crash-loop bounded by MaxDeliver, i.e. up to
 *     ~10 crashes over several minutes before the message is dead-lettered and
 *     the relayer stops crashing (the poisoned token is then lost).
 *   - This does NOT block ALL subsequent traffic: between a crash (+ restart)
 *     and the next redelivery there is an up-window in which the relayer
 *     processes other messages, so a valid transfer that arrives in a gap can
 *     still be delivered. This test sends a second, entirely valid teleport
 *     after the poison and records whether it is delivered — to characterise
 *     the real blast radius rather than assume a total block.
 *   - The damage is therefore sustained instability (repeated destination
 *     crashes on an ordinary transient) plus eventual loss of the poisoned
 *     message — a denial-of-service / availability failure reachable by a
 *     single transient proof-generation error.
 *
 * SCENARIO
 *   1. Bring up a clean 2-participant stack built with -tags faultinjection
 *      (FAULT_INJECTION_ENABLED=true). Confirm BOTH relayer FI servers answer.
 *   2. Register + mint TWO ERC721 tokens on PN-A (one poisons, one is the
 *      clean follow-up). Let the pipeline settle so the one-shot fault can only
 *      be consumed by our poison teleport.
 *   3. Arm a one-shot `error` fault on the SOURCE relayer (relayer-a) at
 *      private_relayer.proofgen.ProofGenerator.Generate.start.
 *   4. teleport(token #1) A → B. Wait until the fault actually fires on
 *      relayer-a (one-shot consumed): token #1 ships a nil proof.
 *   5. teleport(token #2) A → B — a normal, valid transfer (fault spent → real
 *      proof).
 *   6. Watch the destination: count how many times it crashes, restart it on
 *      each crash (simulating a cloud orchestrator's auto-restart), and record
 *      whether the valid follow-up transfer is ever delivered.
 *
 * NOTES
 *   - Runs SERIALLY — tagged @serial on the describe, so the parallel runner
 *     sequences it (no concurrent relayer-a cross-chain traffic). It relies on
 *     the one-shot proof-gen fault being consumed by the poison teleport; a
 *     stray Generate would steal it (also asserted via triggerCount === 1).
 *   - PRE_ARM_SETTLE_MS is a fixed-time assumption; there is no observable proxy
 *     for "relayer-a's proof-gen queue is drained". On a saturated CI box it may
 *     need lengthening — a known limitation, not a per-flake tuning knob.
 *
 * FAULT POINT
 *   private_relayer.proofgen.ProofGenerator.Generate.start
 *   Top of ProofGenerator.Generate in private-relayer/proofgen/proofgen.go.
 *   No-op in untagged (production) builds.
 *
 * TEST OUTCOME (the regression contract — identical code either way)
 *   - FAILS when the vulnerability is present: the destination relayer
 *     SIGSEGVs on the nil proof (crashCount > 0), and crash-loops on the
 *     un-acked message across redeliveries.
 *   - PASSES when the fix is applied: verifyProofs rejects the nil/malformed
 *     proof before Import/VerifyProof, processMessage logs "Invalid message
 *     proof" and returns nil, the poison message is acked/skipped, the relayer
 *     never crashes (crashCount === 0), and the follow-up transfer is delivered.
 *
 * RELATED
 *   raylsnetwork/rayls-privacy-relayer-api#245 — the nil-proof fix this test gates.
 */

import { ethers } from 'ethers';
import { expect } from 'chai';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { ERC721Wrapper } from '../../../../src/entities/tokens/ERC721Wrapper';
import { delay, eventually, submitTx } from '../../../../src/utils/common';
import { compose } from '../../../../src/utils/docker-compose';
import { FaultInjector, FaultSession, FAULT_POINTS } from '../../../../src/utils/fault-injector';
import { observeRelayerCrashLoop } from '../../../test-utils/resilience-helpers';
import { EndpointV1, ProductionErc721Token, ProductionErc721Token__factory } from '../../../../typechain-types';

// ── Timing constants ─────────────────────────────────────────────────────
// Let the source relayer's cross-chain pipeline go quiet before arming, so the
// one-shot proof-gen fault is consumed by OUR poison teleport and not by a
// stray in-flight message from setup or a neighbouring test.
const PRE_ARM_SETTLE_MS = 30_000;

// After the poison teleport, wait this long for the one-shot fault to actually
// fire on relayer-a (i.e. the poison proof was generated and the rule spent).
// Only then is the follow-up teleport guaranteed to get a valid proof.
const FAULT_FIRED_TIMEOUT_MS = 90_000;
const FAULT_FIRED_POLL_MS    = 2_000;

// Window to observe the destination's behaviour after the poison + follow-up.
// The observation stops early once the outcome is decided: either the
// destination never crashed and the follow-up was delivered (fixed code), or a
// crash-loop has been demonstrated (buggy code). NATS MaxDeliver=10 bounds the
// loop, so we don't need to watch all ~10 redeliveries to confirm it.
const OBSERVE_WINDOW_MS = 240_000;
const OBSERVE_POLL_MS   = 4_000;
// Number of distinct destination crashes that confirms the crash-loop (so the
// buggy run doesn't have to wait out all MaxDeliver=10 redeliveries).
const CRASH_LOOP_CONFIRM = 3;

// Per-restart wait for the destination relayer's FI API to answer again.
const RECOVERY_WAIT_MS = 60_000;

// A single isAlive() probe has a short (2s) HTTP timeout, so on a loaded CI box
// one probe can time out even when relayer-b is healthy. Only count a crash
// after this many CONSECUTIVE failed probes — matching the persistent-freeze
// signature of a real SIGSEGV under dlv (the FI API stays unreachable) — so a
// lone slow probe can't false-count a crash and flake the crashCount===0 gate.
const CRASH_CONFIRM_PROBES = 2;
const CRASH_CONFIRM_GAP_MS = 1_000;


describe('E2E SECURITY: Nil/malformed cross-chain proof → destination relayer SIGSEGV + crash-loop @serial', function () {
  this.timeout(DEFAULT_TIMEOUT * 10);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  let nft: ERC721Wrapper<ProductionErc721Token>;
  let poisonTokenId: bigint; // token #1 — its teleport ships the nil proof
  let cleanTokenId: bigint;  // token #2 — a valid follow-up transfer to the same dest

  // Source relayer (relayer-a, FI port 6660): where we arm the proof-gen fault.
  let faultA: FaultInjector;
  let sessionA: FaultSession | undefined;
  // Destination relayer (relayer-b, FI port 6661): the victim we watch for the
  // SIGSEGV / crash-loop. No fault is armed here — the crash is driven entirely
  // by the nil-proof message the source ships.
  let faultB: FaultInjector;

  before(async function () {
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    LOGGER.log('\n   SETUP');
    LOGGER.log('   ─────────────────────────────────────────────────');

    faultA = FaultInjector.forRelayer('A', '127.0.0.1');
    faultB = FaultInjector.forRelayer('B', '127.0.0.1');

    expect(await faultA.isAlive()).to.equal(true,
      'Fault-injection API must be reachable on relayer-a (port 6660). ' +
      'Ensure FAULT_INJECTION_ENABLED=true in .A.env and port 6660 is exposed.');
    expect(await faultB.isAlive()).to.equal(true,
      'Fault-injection API must be reachable on relayer-b (port 6661). ' +
      'Ensure FAULT_INJECTION_ENABLED=true in .B.env and port 6661 is exposed.');

    sessionA = await faultA.newSession();
    LOGGER.log(`   FI reachable on relayer-a (session ${sessionA.id}) and relayer-b`);

    // Register + mint two fresh ERC721 tokens on PN-A (vanilla path — the
    // forward teleport goes through source CrossChainService.BatchGenerate).
    // Token #1 is the one we poison; token #2 is the clean follow-up transfer.
    nft = new ERC721Wrapper<ProductionErc721Token>(privacyNodes.A, ProductionErc721Token__factory);
    await nft.deploy();
    await nft.activateOnPn();
    await nft.activateOnHub(privateHub);
    poisonTokenId = await nft.mintAndAwait(privateHub, { toAddress: nft.userWallet.address });
    cleanTokenId = await nft.mintAndAwait(privateHub, { toAddress: nft.userWallet.address });
    LOGGER.log(`   Registered ERC721 ${nft.symbol}; minted poison #${poisonTokenId} and clean #${cleanTokenId} on PN-A`);

    LOGGER.log(`   Settling ${PRE_ARM_SETTLE_MS / 1000}s so the one-shot fault fires on OUR poison teleport...`);
    await delay(PRE_ARM_SETTLE_MS);
    LOGGER.log('   Setup complete\n');
  });

  after(async function () {
    try {
      // Best-effort: if relayer-b is down, bring the container back. Use restart
      // (stop+start), not start: an unrecovered panic under `dlv --continue`
      // freezes the process while the container stays "running", so a plain
      // start is a no-op — only a restart forces it down and back up. On the
      // BUGGY code the un-acked poison message keeps re-crashing it until NATS
      // MaxDeliver=10 dead-letters the message (or a --clean rebuild / the fix
      // clears it), so this may not fully recover it here.
      if (!(await faultB.isAlive())) {
        compose.restart('relayer-b');
        await faultB.waitUntilAlive(RECOVERY_WAIT_MS).catch(() => { /* may re-crash on buggy code */ });
      }
      if (sessionA) await sessionA.clear();
    } catch { /* best-effort cleanup */ }
  });

  it('a nil/malformed cross-chain proof must not crash the destination relayer', async function () {
    LOGGER.log('================================================================');
    LOGGER.log('   Nil-proof DoS — destination must not SIGSEGV / crash-loop');
    LOGGER.log('================================================================');

    // Delivery probe for the CLEAN follow-up token on PN-B. Non-throwing:
    // returns false while the destination contract is undeployed or the token
    // is unminted on B.
    const cleanTokenDeliveredOnB = async (): Promise<boolean> => {
      try {
        const endpoint = privacyNodes.B.getContract<EndpointV1>('EndpointV1');
        const addr = await endpoint.getAddressByResourceId(nft.resourceId);
        if (!addr || addr === ethers.ZeroAddress) return false;
        const tokenOnB = ProductionErc721Token__factory.connect(addr, privacyNodes.B.provider);
        const owner = await tokenOnB.ownerOf(cleanTokenId);
        return owner.toLowerCase() === nft.userWallet.address.toLowerCase();
      } catch {
        return false;
      }
    };

    // ── 0. Both relayers alive; the clean token is not yet on B. ───────────
    expect(await faultA.isAlive()).to.equal(true, 'relayer-a must be alive before arming the fault');
    expect(await faultB.isAlive()).to.equal(true, 'relayer-b must be alive before the teleport');
    expect(await cleanTokenDeliveredOnB()).to.equal(false, 'clean token must not be on B before its teleport');
    LOGGER.log('\n   0. Both relayer-a and relayer-b are alive; clean token not yet on B');

    // ── 1. Arm the one-shot proof-gen failure on the SOURCE relayer. ───────
    //    `error` (not crash): Generate returns an error, BatchGenerate logs a
    //    warning and leaves the proof slot nil — exactly the transient path.
    LOGGER.log('\n   1. Arming one-shot proof-gen failure on relayer-a (SOURCE)');
    LOGGER.log(`      point: ${FAULT_POINTS.PROOFGEN_GENERATE_START}`);
    await sessionA!.arm({
      point: FAULT_POINTS.PROOFGEN_GENERATE_START,
      action: 'error',
      one_shot: true,
      message: 'transient proof-generation failure',
    });
    expect((await sessionA!.status()).rules[FAULT_POINTS.PROOFGEN_GENERATE_START]).to.exist;
    expect(await faultA.isAlive()).to.equal(true, 'relayer-a must stay alive after arming an error fault');
    LOGGER.log('      Rule armed: proof-gen fail -> error (one-shot)');

    // ── 2. POISON teleport A → B. submitTx asserts the burn mined on PN-A. ──
    LOGGER.log(`\n   2. POISON teleport ERC721 #${poisonTokenId} A -> B (chainId ${privacyNodes.B.chainId})`);
    const poisonBurn = await submitTx(
      () => nft.contract.teleport(
        nft.userWallet.address,
        poisonTokenId,
        privacyNodes.B.chainId,
        { gasLimit: GAS_LIMIT },
      ),
      `Poison teleport NFT #${poisonTokenId} A -> B (will ship a nil proof)`,
    );
    LOGGER.log(`      Burn confirmed on PN-A: ${poisonBurn.hash} (block ${poisonBurn.blockNumber})`);

    // ── 3. Wait until the fault actually fires on relayer-a. This consumes
    //    the one-shot rule (so the follow-up gets a valid proof) AND
    //    guarantees the poison message is dispatched ahead of the clean one.
    LOGGER.log('\n   3. Waiting for the proof-gen fault to fire on relayer-a (one-shot consumed)...');
    await eventually<boolean>({
      check: async () => sessionA!.wasTriggered(FAULT_POINTS.PROOFGEN_GENERATE_START),
      interval: FAULT_FIRED_POLL_MS,
      attempts: Math.ceil(FAULT_FIRED_TIMEOUT_MS / FAULT_FIRED_POLL_MS),
      tolerateErrors: true, // wasTriggered hits relayer-a's FI API; retry transient HTTP blips
      message: 'Waiting for the source proof-gen fault to fire (nil proof shipped)',
    });
    // The one-shot must have fired exactly once, on OUR poison teleport. If a
    // stray relayer-a proof generation (a neighbouring test / leftover in-flight
    // message) consumed it instead, the poison teleport would have shipped a
    // VALID proof and this run would silently NOT exercise the nil-proof path.
    // Run this crash-loop test serially, with no other relayer-a traffic.
    const firedCount = await sessionA!.triggerCount(FAULT_POINTS.PROOFGEN_GENERATE_START);
    expect(firedCount).to.equal(1,
      `expected the one-shot proof-gen fault to fire exactly once (on the poison teleport); it fired ${firedCount} ` +
      `time(s). A stray source proof generation likely consumed the one-shot, so the poison teleport may have shipped ` +
      `a valid proof and this run would not exercise the nil-proof path. Run this test serially with no other ` +
      `relayer-a cross-chain traffic.`);
    LOGGER.log('      Fault fired exactly once: relayer-a shipped a nil proof for the poison teleport');

    // ── 4. CLEAN follow-up teleport A → B — a normal, valid transfer. The
    //    fault is spent, so this ships a real proof.
    LOGGER.log(`\n   4. CLEAN follow-up teleport ERC721 #${cleanTokenId} A -> B (valid proof, no fault)`);
    const cleanBurn = await submitTx(
      () => nft.contract.teleport(
        nft.userWallet.address,
        cleanTokenId,
        privacyNodes.B.chainId,
        { gasLimit: GAS_LIMIT },
      ),
      `Clean teleport NFT #${cleanTokenId} A -> B`,
    );
    LOGGER.log(`      Burn confirmed on PN-A: ${cleanBurn.hash} (block ${cleanBurn.blockNumber})`);

    // ── 5. Observe the destination: count crashes, restart on each (cloud
    //    auto-restart sim), and measure whether the follow-up is delivered.
    LOGGER.log(`\n   5. Observing relayer-b for up to ${OBSERVE_WINDOW_MS / 1000}s (restart on crash; watch the clean transfer)...`);
    const obs = await observeRelayerCrashLoop(faultB, {
      service: 'relayer-b',
      checkDelivered: cleanTokenDeliveredOnB,
      deadlineMs: OBSERVE_WINDOW_MS,
      pollMs: OBSERVE_POLL_MS,
      confirmProbes: CRASH_CONFIRM_PROBES,
      confirmGapMs: CRASH_CONFIRM_GAP_MS,
      crashLoopConfirm: CRASH_LOOP_CONFIRM,
      recoveryWaitMs: RECOVERY_WAIT_MS,
    });

    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   IMPACT SUMMARY');
    LOGGER.log(`      destination crashes observed:  ${obs.crashCount}${obs.firstCrashAtS !== null ? ` (first after ${obs.firstCrashAtS}s)` : ''}`);
    LOGGER.log(`      restarts issued (cloud-sim):   ${obs.restarts}`);
    LOGGER.log(`      follow-up transfer delivered:  ${obs.delivered}${obs.deliveredAtS !== null ? ` (after ${obs.deliveredAtS}s)` : ''}`);
    if (obs.crashCount >= CRASH_LOOP_CONFIRM) {
      LOGGER.log(`      → crash-loop confirmed: relayer-b re-crashes on the un-acked poison message on every`);
      LOGGER.log(`        NATS redelivery (bounded by MaxDeliver=10). Subsequent transfers ${obs.delivered ? 'CAN' : 'may or may not'} slip`);
      LOGGER.log(`        through the up-windows between crashes; the destination stays unstable meanwhile.`);
    }
    LOGGER.log('   ─────────────────────────────────────────────────────────────');

    // ── 6. The regression contract (identical assertion on buggy and fixed
    //    builds): a nil/malformed proof must never crash the destination. On
    //    the buggy code crashCount > 0 (SIGSEGV + crash-loop); on the fixed
    //    code the poison is skipped/acked and crashCount === 0.
    expect(obs.crashCount).to.equal(0,
      `NIL-PROOF DoS REPRODUCED: the destination relayer (relayer-b) SIGSEGV'd ${obs.crashCount} time(s) on a ` +
      `nil/empty cross-chain proof` +
      `${obs.firstCrashAtS !== null ? ` (first after ${obs.firstCrashAtS}s)` : ''} and crash-loops on the un-acked ` +
      `message across NATS redeliveries (bounded by MaxDeliver=10). trie.VerifyProof dereferenced a nil ` +
      `*ProofDB returned by proofs.NewProofDB().Import(nil). Blast radius this run: the follow-up valid ` +
      `transfer was ${obs.delivered ? 'delivered in an up-window between crashes' : 'not delivered within the window'} ` +
      `— so subsequent traffic is degraded/unstable, not necessarily fully blocked. The fix must reject the ` +
      `nil/malformed proof in verifyProofs (before Import/VerifyProof) so processMessage logs "Invalid message ` +
      `proof", acks/skips the poison message, and the relayer never crashes.`);

    LOGGER.log('\n================================================================');
    LOGGER.log('   PASSED: destination survived the nil proof (skipped gracefully) and stayed available');
    LOGGER.log('================================================================');
  });
});
