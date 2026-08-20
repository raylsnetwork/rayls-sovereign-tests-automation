/**
 * @title E2E SECURITY: Source Relayer Crash During Revert → Double crossRevertMint Inflation
 *
 * Reproduces the symmetric inflation vulnerability for the SOURCE-side revert path. When
 * the relayer's source-side cross-transfer flow fails (e.g., transient proof/CC error),
 * the orchestrator falls into the revert branch and calls `crossRevertMint(to, amount, reason)`
 * on PL-A to give the user's tokens back. If the relayer crashes AFTER that revert TX is
 * sent but BEFORE the upstream NATS message is acked, NATS redelivers the message on
 * restart. The orchestrator runs the same flow again, fails again, and submits a SECOND
 * `crossRevertMint` TX → user receives the refund TWICE → inflation by `transferAmount`.
 *
 * REPRODUCES THE EXPLOIT BY:
 *   1. Arming `EXECUTOR_BEFORE_EXECUTE` with action=error, max_count=0, one_shot=false →
 *      every ExecuteEnygmaCrossTransfer call fails. After the retryService exhausts its
 *      30 retries, handleEnygmaTransferBatch enters the revert branch.
 *   2. Arming `AFTER_SRC_REVERT_SEND` with action=crash, one_shot=true → the relayer
 *      exits AFTER the first crossRevertMint TX is broadcast, BEFORE the NATS ack.
 *   3. Triggering a normal cross-transfer from alice. The chain of effects above runs.
 *      The crash one-shot is consumed; the executor-error rule survives the restart
 *      via FAULT_INJECTION_PERSIST_PATH.
 *   4. After restart, NATS redelivers → executor still fails → revert path runs again →
 *      SECOND crossRevertMint TX is broadcast (no crash this time, since one-shot was
 *      consumed) → message acks normally.
 *
 * VULNERABILITY ROOT CAUSE:
 *   `crossRevertMint(_to, _value, _reason)` in RaylsEnygmaHandler.sol has NO
 *   `referenceId` parameter and no other idempotency mechanism. Every call mints
 *   unconditionally. The relayer's source-side revert path also has no recovery_data
 *   tracking — there's no row inserted before sending the revert batch — so a NATS
 *   redelivery after a crash mid-revert produces a fresh, undetected duplicate refund.
 *
 * TEST OUTCOME:
 *   - FAILS when vulnerability is present (alice's PL-A balance is INITIAL+TRANSFER, not INITIAL)
 *   - PASSES when EITHER:
 *       (a) the contract guards crossRevertMint against duplicates (e.g., adds a referenceId
 *           parameter and checks it), OR
 *       (b) the relayer adds source-side recovery_data tracking for the revert flow so
 *           NATS redelivery is dedup'd before sending a second crossRevertMint TX.
 *
 * SCOPE NOTE:
 *   - This reproducer covers the revert path only. The analogous forward-path bug
 *     (duplicate crossMint on the destination after a source-relayer crash between
 *     CC submission and NATS ack) is a separate scenario: the revert flow doesn't
 *     go through the executor's persist-and-broadcast machinery, so any fix that
 *     instruments only the forward-path executor will leave this scenario unfixed.
 */

import { ethers } from 'ethers';
import { expect } from 'chai';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { createRandomWallet, eventually, submitTx } from '../../../../src/utils/common';
import { compose } from '../../../../src/utils/docker-compose';
import { FaultInjector, FaultSession, FAULT_POINTS } from '../../../../src/utils/fault-injector';
import { ProductionEnygmaToken, ProductionEnygmaToken__factory } from '../../../../typechain-types';

const TRANSFER_AMOUNT = ethers.parseUnits('5000', 18);
const INITIAL_MINT    = TRANSFER_AMOUNT * 2n;

// Time the orchestrator's retryService takes to exhaust 30 retries when every call
// fails fast (no proof generation, just a fault-injected error). Empirically ~30s.
const RETRY_EXHAUSTION_MS = 60_000;

// Grace period (ms) after relayer-A restart to wait for NATS redelivery + the second
// revert round to complete on PL-A.
const POST_RESTART_GRACE_MS = 60_000;

function fmt(amount: bigint): string {
  return ethers.formatUnits(amount, 18);
}

describe('E2E SECURITY: Source Relayer Crash During Revert → Double crossRevertMint Inflation', function () {
  this.timeout(DEFAULT_TIMEOUT * 10);

  let raylsNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let enygma: EnygmaWrapper<ProductionEnygmaToken>;
  let tokenOnA: ProductionEnygmaToken;
  let alice: ethers.HDNodeWallet;
  let faultA: FaultInjector;
  let sessionA: FaultSession;

  before(async function () {
    const setup = await initializePrivacyNodesAndPnh(2);
    raylsNodes = setup.initializedNodes;
    privateHub = setup.initializedPNH;

    faultA = FaultInjector.forRelayer('A', '127.0.0.1');
    expect(await faultA.isAlive()).to.equal(true,
      'Fault-injection API on relayer-a must be reachable; ensure FAULT_INJECTION_ENABLED=true and port 6660 exposed.',
    );
    sessionA = await faultA.newSession();

    LOGGER.log('\n   SETUP');
    LOGGER.log('   ─────────────────────────────────────────────────');

    alice = createRandomWallet(raylsNodes.A.provider);
    await (await raylsNodes.A.adminWallet.sendTransaction({
      to: alice.address,
      value: ethers.parseEther('5.0'),
    })).wait();

    enygma = new EnygmaWrapper<ProductionEnygmaToken>(raylsNodes.A, ProductionEnygmaToken__factory);
    await enygma.deployViaFactory();
    await enygma.activateOnPn();
    await enygma.activateOnHub(privateHub);

    tokenOnA = raylsNodes.A.getContract<ProductionEnygmaToken>(enygma.symbol);
    await submitTx(
      () => tokenOnA.mint(alice.address, INITIAL_MINT, { gasLimit: GAS_LIMIT }),
      `Mint ${fmt(INITIAL_MINT)} to alice on PL-A`,
    );
    await eventually({
      check: async () => (await tokenOnA.balanceOf(alice.address)) === INITIAL_MINT,
      message: 'Waiting for alice mint balance',
    });

    LOGGER.log(`   alice on PL-A: ${alice.address}`);
    LOGGER.log(`   alice balance: ${fmt(await tokenOnA.balanceOf(alice.address))}`);
    LOGGER.log(`   token totalSupply: ${fmt(await tokenOnA.totalSupply())}`);
    LOGGER.log('   Setup complete\n');
  });

  after(async function () {
    try {
      // Belt and suspenders: ensure relayer-A is up, then drop the session.
      if (!(await faultA.isAlive())) {
        compose.start('relayer-a');
        await faultA.waitUntilAlive(180_000);
      }
      if (sessionA) await sessionA.clear();
    } catch { /* best-effort cleanup */ }
  });

  // Active reproducer for issue #75 revert-path inflation scenario. Was skipped
  // while crossRevertMint had no referenceId parameter (3-arg ABI) and no
  // idempotency guard; now un-skipped because:
  //   - crossRevertMint(_to, _value, _reason, _referenceId) is the new 4-arg
  //     ABI; the relayer's enygma/txgen/src_transfer_revert.go packs the
  //     referenceId from the transfer event payload.
  //   - RaylsEnygmaHandler.crossRevertMint silent-returns when the referenceId
  //     status is already REVERTED, so a crash + NATS redelivery between the
  //     first crossRevertMint TX broadcast and the NATS ack produces a
  //     duplicate-but-harmless second TX rather than a duplicate mint.
  //
  // If this test ever fails again:
  //   - Verify RaylsEnygmaHandler.crossRevertMint has the REVERTED guard.
  //   - Run the txgen unit test:
  //       go test ./enygma/txgen/... -run TestGenerate_packsCrossRevertMintWithReferenceId -v
  //     in rayls-sovereign-relayer to localise to the relayer pack site.
  it('source revert flow crash + restart must NOT cause double crossRevertMint (inflation)', async function () {
    const supplyBefore  = await tokenOnA.totalSupply();
    const balanceBefore = await tokenOnA.balanceOf(alice.address);
    const expectedSupply  = supplyBefore;                      // burn(transfer) + mint(refund) = net 0
    const expectedBalance = balanceBefore;                     // alice ends with the same tokens she started with

    LOGGER.log('================================================================');
    LOGGER.log('   Source revert crash → restart → check for inflation');
    LOGGER.log('================================================================');
    LOGGER.log(`\n   PRE: alice balance=${fmt(balanceBefore)}, totalSupply=${fmt(supplyBefore)}`);
    LOGGER.log(`   Transfer amount:           ${fmt(TRANSFER_AMOUNT)}`);
    LOGGER.log(`   Expected post-state: balance=${fmt(expectedBalance)} (one revert restored)`);
    LOGGER.log(`   Inflation check: any gain over baseline = double crossRevertMint`);

    // ── 1. Arm the fault chain ─────────────────────────────────────────────────
    LOGGER.log('\n   1. Arming fault chain on relayer-A:');
    LOGGER.log('      a) EXECUTOR_BEFORE_EXECUTE → action=error, max_count=0, one_shot=false');
    LOGGER.log('         (forces every ExecuteEnygmaCrossTransfer call to fail; survives restart via persist file)');
    LOGGER.log('      b) AFTER_SRC_REVERT_SEND   → action=crash, one_shot=true');
    LOGGER.log('         (crashes after the FIRST crossRevertMint TX is broadcast, before NATS ack)');

    await sessionA.arm({
      point:     FAULT_POINTS.EXECUTOR_BEFORE_EXECUTE,
      action:    'error',
      message:   'simulated executor failure to drive the revert path',
      one_shot:  false,
      max_count: 0,
    });
    await sessionA.arm({
      point:    FAULT_POINTS.AFTER_SRC_REVERT_SEND,
      action:   'crash',
      one_shot: true,
    });

    const armed = await sessionA.status();
    expect(armed.rules[FAULT_POINTS.EXECUTOR_BEFORE_EXECUTE]).to.exist;
    expect(armed.rules[FAULT_POINTS.AFTER_SRC_REVERT_SEND]).to.exist;
    LOGGER.log('      Both rules armed and verified\n');

    // ── 2. Trigger the cross-transfer ──────────────────────────────────────────
    LOGGER.log('   2. Submitting cross-transfer: alice burns 5000 tokens, addressed to PL-B');
    LOGGER.log(`      Source-A executor will fail with the armed error → retry exhausted (~${RETRY_EXHAUSTION_MS / 1000}s)`);
    LOGGER.log('      → orchestrator enters revert branch → crossRevertMint sent on PL-A');
    LOGGER.log('      → fault crashes the relayer immediately after Send returns');

    const tokenOnAAsAlice = tokenOnA.connect(alice) as ProductionEnygmaToken;
    await submitTx(
      () => tokenOnAAsAlice.linearCrossTransfer(
        raylsNodes.B.userWallet.address, TRANSFER_AMOUNT, raylsNodes.B.chainId,
        [], // plain transfer (no programmability)
        { gasLimit: 5_000_000 },
      ),
      'linearCrossTransfer (will trigger source revert path under fault)',
    );
    const balanceAfterBurn = await tokenOnA.balanceOf(alice.address);
    expect(balanceAfterBurn).to.equal(balanceBefore - TRANSFER_AMOUNT,
      `BURN sanity-check: expected balance ${fmt(balanceBefore - TRANSFER_AMOUNT)} after PL-A burn but got ${fmt(balanceAfterBurn)}.`,
    );
    LOGGER.log(`      Burn confirmed on PL-A: alice balance ${fmt(balanceAfterBurn)}`);

    // ── 3. Wait for the relayer to crash ──────────────────────────────────────
    LOGGER.log('\n   3. Waiting for relayer-A to crash (max ~3min for retries + revert)…');
    await faultA.waitForCrash(RETRY_EXHAUSTION_MS + 120_000);
    LOGGER.log('      Relayer-A is down — first crossRevertMint TX has already landed on PL-A');

    const balanceAfterFirstRevert = await tokenOnA.balanceOf(alice.address);
    LOGGER.log(`      PL-A alice balance after first revert: ${fmt(balanceAfterFirstRevert)}`);

    // ── 4. Restart and let the second round play out ───────────────────────────
    LOGGER.log('\n   4. Restarting relayer-A');
    LOGGER.log('      The EXECUTOR_BEFORE_EXECUTE rule is restored from the persist file → executor fails again');
    LOGGER.log('      AFTER_SRC_REVERT_SEND was one_shot → no second crash → second revert acks normally');
    compose.restart('relayer-a');
    await faultA.waitUntilAlive(180_000);
    LOGGER.log('      Relayer-A is back online');

    LOGGER.log(`\n   5. Waiting ${POST_RESTART_GRACE_MS / 1000}s for the second revert round to complete…`);
    await new Promise((r) => setTimeout(r, POST_RESTART_GRACE_MS));

    // ── 5. Disarm the executor rule so cleanup doesn't poison the next test ───
    await sessionA.clearPoint(FAULT_POINTS.EXECUTOR_BEFORE_EXECUTE);

    // ── 6. Check for inflation ────────────────────────────────────────────────
    LOGGER.log('\n   6. Checking PL-A for inflation');
    const finalSupply  = await tokenOnA.totalSupply();
    const finalBalance = await tokenOnA.balanceOf(alice.address);
    LOGGER.log(`      PL-A totalSupply: ${fmt(finalSupply)} (expected: ${fmt(expectedSupply)})`);
    LOGGER.log(`      PL-A alice balance: ${fmt(finalBalance)} (expected: ${fmt(expectedBalance)})`);

    const balanceGain = finalBalance > expectedBalance ? finalBalance - expectedBalance : 0n;
    if (balanceGain > 0n) {
      LOGGER.log(`\n      >>> INFLATION DETECTED: alice gained ${fmt(balanceGain)} tokens beyond baseline <<<`);
      LOGGER.log('      Source-relayer revert path called crossRevertMint twice with no idempotency guard.');
    }

    expect(finalBalance).to.equal(expectedBalance,
      `INFLATION: PL-A alice balance is ${fmt(finalBalance)} but expected ${fmt(expectedBalance)}. ` +
      `${fmt(balanceGain)} tokens were minted from nothing because crossRevertMint was called twice ` +
      `(once before the source-relayer crash + once after NATS redelivery on restart) and the contract ` +
      `function lacks an idempotency guard (no referenceId parameter).`,
    );
    expect(finalSupply).to.equal(expectedSupply,
      `INFLATION: PL-A totalSupply is ${fmt(finalSupply)} but expected ${fmt(expectedSupply)}. ` +
      `${fmt(finalSupply - expectedSupply)} tokens were minted from nothing via duplicate crossRevertMint.`,
    );

    LOGGER.log('\n================================================================');
    LOGGER.log('   PASSED: No inflation after source-relayer crash during revert flow');
    LOGGER.log('================================================================');
  });
});
