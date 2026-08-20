/**
 * @title E2E SECURITY: Source Relayer Crash → Double CC Submission → Inflation
 *
 * Reproduces the inflation vulnerability where a source relayer crash causes
 * tokens to be minted twice on the destination PL.
 *
 * VULNERABILITY:
 *   When Relayer-A (source) crashes AFTER successfully submitting transferBatch()
 *   to the Commit Chain but BEFORE acknowledging the NATS message, the message is
 *   redelivered on restart. The retry uses a DIFFERENT CC block number (latestBlock
 *   has advanced), which bypasses all existing idempotency guards:
 *     - GetPendingHistory(): scoped to blockNumberCC → misses confirmed record at old block
 *     - InsertEnygmaHistory(): unique key includes blockNumberCC → different key = insert succeeds
 *   The CC processes the second submission as a distinct transfer, and Relayer-B
 *   calls crossMint() a second time → tokens created from nothing.
 *
 * SCENARIO:
 *   1. Deploy Enygma token on PL-A, mint tokens to userA
 *   2. Initial cross-transfer PL-A → PL-B (establishes token on PL-B)
 *   3. Arm one-shot crash on Relayer-A at after_cross_transfer
 *      (after transferBatch() to CC succeeds but before NATS message ack)
 *   4. Second cross-transfer PL-A → PL-B
 *   5. Relayer-A submits transferBatch() to CC → succeeds → CRASHES (os.Exit)
 *   6. Relayer-B receives first CC event → calls crossMint() on PL-B (first mint)
 *   7. Restart Relayer-A via compose.sh
 *   8. NATS redelivers the message → Relayer-A resubmits at new blockNumberCC
 *   9. CC processes second submission → Relayer-B calls crossMint() again (second mint)
 *   10. Assert: PL-B totalSupply and balance show EXACTLY the expected amount
 *
 * CRASH POINT:
 *   private_relayer.source.service.EnygmaOrchestrator.handleEnygmaTransfer.after_cross_transfer
 *   This is in the SOURCE relayer's orchestrator, AFTER the cross-transfer to CC
 *   has been executed (transferBatch TX confirmed on CC) but BEFORE the NATS
 *   message is acknowledged. On crash, NATS redelivers the message on restart.
 *
 * TEST OUTCOME:
 *   - FAILS when vulnerability is present (inflation detected → double-mint)
 *   - PASSES when the fix is applied (no inflation)
 *
 * EVIDENCE (2026-03-06 manual reproduction):
 *   Token 728a4b: 5,000 minted on PL-A, burned via linearCrossTransfer.
 *   PL-B received TWO crossMint calls: block 3723 (5,000) + block 3773 (5,000).
 *   PL-B totalSupply: 10,000 (should be 5,000). Global inflation: 5,000 tokens.
 *
 * RELATED:
 *   Issue: SEC-RELAY-CRASH-INFLATION
 *   Fix: crossMint() idempotency guard on referenceId + source relayer dedup
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
import {
  EndpointV1,
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
} from '../../../../typechain-types';

const TRANSFER_AMOUNT = ethers.parseUnits('5000', 18);
const INITIAL_MINT = TRANSFER_AMOUNT * 2n; // enough for setup + test transfer

// Grace period (ms) after relayer-A restart to wait for second relay round
// (Relayer-A resubmit → CC → Relayer-B → crossMint on PL-B)
const POST_RESTART_GRACE_MS = 45_000;

function fmt(amount: bigint): string {
  return ethers.formatUnits(amount, 18);
}

describe('E2E SECURITY: Source Relayer Crash → Inflation via Double CC Submission', function () {
  this.timeout(DEFAULT_TIMEOUT * 10);

  let raylsNodes: PrivacyNodeMap;
  let commitChain: PrivateHub;

  let enygma: EnygmaWrapper<ProductionEnygmaToken>;
  let tokenOnA: ProductionEnygmaToken;
  let tokenOnB: ProductionEnygmaToken;

  let userA: ethers.HDNodeWallet;
  let faultA: FaultInjector;
  let sessionA: FaultSession;

  // ─────────────────────────────────────────────────────────────────────────
  // SETUP: deploy token, mint, first cross-transfer to establish PL-B token
  // ─────────────────────────────────────────────────────────────────────────

  before(async function () {
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    raylsNodes = initializedNodes;
    commitChain = initializedPNH;

    // Fault injector for Relayer-A (SOURCE relayer, port 6660)
    faultA = FaultInjector.forRelayer('A', '127.0.0.1');

    LOGGER.log('\n   SETUP');
    LOGGER.log('   ─────────────────────────────────────────────────');

    const fiAlive = await faultA.isAlive();
    expect(fiAlive).to.equal(true,
      'Fault injection API must be reachable on relayer-A (port 6660). ' +
      'Ensure FAULT_INJECTION_ENABLED=true in .A.env and port 6660 is exposed.'
    );
    sessionA = await faultA.newSession();
    LOGGER.log(`   Fault injection API on relayer-A: reachable, session ${sessionA.id} created`);

    // Fund userA
    userA = createRandomWallet(raylsNodes.A.provider);
    await (await raylsNodes.A.adminWallet.sendTransaction({
      to: userA.address,
      value: ethers.parseEther('5.0'),
    })).wait();

    // Deploy & register Enygma token
    enygma = new EnygmaWrapper<ProductionEnygmaToken>(raylsNodes.A, ProductionEnygmaToken__factory);
    await enygma.deployViaFactory();
    await enygma.activateOnPn();
    await enygma.activateOnHub(commitChain);

    // Mint to userA
    tokenOnA = raylsNodes.A.getContract<ProductionEnygmaToken>(enygma.symbol);
    await submitTx(
      () => tokenOnA.mint(userA.address, INITIAL_MINT, { gasLimit: GAS_LIMIT }),
      `Mint ${fmt(INITIAL_MINT)} to userA on PL-A`,
    );
    await eventually({
      check: async () => (await tokenOnA.balanceOf(userA.address)) === INITIAL_MINT,
      message: 'Waiting for userA mint balance',
    });
    LOGGER.log(`   Minted ${fmt(INITIAL_MINT)} to userA on PL-A`);

    // First cross-transfer: deploys the token on PL-B and establishes the relay path
    const tokenOnAAsUser = tokenOnA.connect(userA) as ProductionEnygmaToken;
    await submitTx(
      () => tokenOnAAsUser.linearCrossTransfer(
        raylsNodes.B.userWallet.address, TRANSFER_AMOUNT, raylsNodes.B.chainId,
        [], // plain transfer (no programmability)
        { gasLimit: 5_000_000 },
      ),
      `Cross-transfer ${fmt(TRANSFER_AMOUNT)} PL-A -> PL-B (setup)`,
    );

    // Wait for token to be deployed on PL-B
    await eventually({
      check: async () => {
        const endpoint = raylsNodes.B.getContract<EndpointV1>('EndpointV1');
        const addr = await endpoint.getAddressByResourceId(enygma.resourceId);
        if (addr === ethers.ZeroAddress) return false;
        enygma.address[raylsNodes.B.chainId] = addr;
        await raylsNodes.B.getContractAt(ProductionEnygmaToken__factory.name, addr, enygma.symbol);
        return true;
      },
      message: 'Waiting for token deployment on PL-B',
    });

    tokenOnB = raylsNodes.B.getContract<ProductionEnygmaToken>(enygma.symbol);

    // Wait for setup transfer to arrive on PL-B
    await eventually({
      check: async () => (await tokenOnB.balanceOf(raylsNodes.B.userWallet.address)) === TRANSFER_AMOUNT,
      message: 'Waiting for setup transfer balance on PL-B',
    });

    LOGGER.log(`   Token on PL-A: ${await tokenOnA.getAddress()}`);
    LOGGER.log(`   Token on PL-B: ${await tokenOnB.getAddress()}`);
    LOGGER.log(`   PL-B balance (setup):     ${fmt(await tokenOnB.balanceOf(raylsNodes.B.userWallet.address))}`);
    LOGGER.log(`   PL-B totalSupply (setup): ${fmt(await tokenOnB.totalSupply())}`);
    LOGGER.log(`   PL-A userA balance:       ${fmt(await tokenOnA.balanceOf(userA.address))}`);
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

  // ─────────────────────────────────────────────────────────────────────────
  // TEST: Source relayer crash → restart → verify no inflation
  // ─────────────────────────────────────────────────────────────────────────
  //
  // Active reproducer for issue #75 inflation scenario. Was skipped while the
  // contract-level idempotency guard was missing; now un-skipped because
  // RaylsEnygmaHandler.crossMint short-circuits when referenceIdsStatus[refId]
  // is RECEIVED (or REVERTED), making the second crossMint on the dest PL a
  // silent no-op after a source-relayer crash + NATS redelivery.
  //
  // The relayer's source-side dedup lookup remains keyed on blockNumber (still
  // unstable across restart) by design — see enygma/service/executor.go
  // comment at the GetPendingByEventKey call. Inflation is blocked by the
  // contract guard, not by the relayer.
  //
  // If this test ever fails again:
  //   - First check that RaylsEnygmaHandler.crossMint still has the guard at
  //     the top of the function body.
  //   - Run `forge test --match-path 'src/test/unit/enygma/RaylsEnygmaHandler_Idempotency.t.sol'`
  //     in rayls-privacy-contracts to localise to the contract layer.
  it('source relayer crash after CC submission: restart must NOT cause double-mint (inflation)', async function () {
    LOGGER.log('================================================================');
    LOGGER.log('   Source relayer crash → restart → check for inflation');
    LOGGER.log('================================================================');

    const signerBAddr = raylsNodes.B.userWallet.address;
    const supplyBefore = await tokenOnB.totalSupply();
    const balanceBefore = await tokenOnB.balanceOf(signerBAddr);
    const expectedSupply = supplyBefore + TRANSFER_AMOUNT;
    const expectedBalance = balanceBefore + TRANSFER_AMOUNT;

    LOGGER.log(`\n   PL-B totalSupply before:  ${fmt(supplyBefore)}`);
    LOGGER.log(`   PL-B balance before:      ${fmt(balanceBefore)}`);
    LOGGER.log(`   Transfer amount:          ${fmt(TRANSFER_AMOUNT)}`);
    LOGGER.log(`   Expected totalSupply:     ${fmt(expectedSupply)}`);
    LOGGER.log(`   Expected balance:         ${fmt(expectedBalance)}`);

    // ── 1. Arm one-shot crash on Relayer-A (SOURCE) ──────────────────────
    LOGGER.log('\n   1. Arming one-shot crash at AFTER_CROSS_TRANSFER on relayer-A');
    LOGGER.log('      (crashes AFTER transferBatch() to CC succeeds, BEFORE NATS ack)');

    await sessionA.arm({
      point: FAULT_POINTS.AFTER_CROSS_TRANSFER,
      action: 'crash',
      one_shot: true,
    });

    const armed = await sessionA.status();
    expect(armed.rules[FAULT_POINTS.AFTER_CROSS_TRANSFER]).to.exist;
    expect(armed.rules[FAULT_POINTS.AFTER_CROSS_TRANSFER].action).to.equal('crash');
    LOGGER.log('      Rule armed: after_cross_transfer -> crash (one-shot)');

    // ── 2. Submit cross-transfer PL-A -> PL-B ────────────────────────────
    LOGGER.log(`\n   2. Submitting cross-transfer: ${fmt(TRANSFER_AMOUNT)} PL-A -> PL-B`);

    const tokenOnAAsUser = tokenOnA.connect(userA) as ProductionEnygmaToken;
    await submitTx(
      () => tokenOnAAsUser.linearCrossTransfer(
        signerBAddr, TRANSFER_AMOUNT, raylsNodes.B.chainId,
        [], // plain transfer (no programmability)
        { gasLimit: 5_000_000 },
      ),
      'Cross-transfer PL-A -> PL-B (test transfer)',
    );
    LOGGER.log('      TX confirmed on PL-A (tokens burned)');
    LOGGER.log('      Relay pipeline: Relayer-A picks up → submits to CC → CRASH');

    // ── 3. Wait for Relayer-A to crash ───────────────────────────────────
    LOGGER.log('\n   3. Waiting for relayer-A to crash...');
    LOGGER.log('      (Relayer-A must: pick up PL event → ZK proof → transferBatch to CC → CRASH)');

    await faultA.waitForCrash();
    LOGGER.log('      Relayer-A is down (crash confirmed)');
    LOGGER.log('      At this point: transferBatch() already succeeded on CC');
    LOGGER.log('      Relayer-B will receive the first CC event and call crossMint()');

    // ── 4. Wait for first mint to land on PL-B ──────────────────────────
    LOGGER.log('\n   4. Waiting for first crossMint to land on PL-B...');

    await eventually({
      check: async () => (await tokenOnB.balanceOf(signerBAddr)) >= expectedBalance,
      message: 'Waiting for first crossMint on PL-B',
    });

    const balanceAfterFirstMint = await tokenOnB.balanceOf(signerBAddr);
    const supplyAfterFirstMint = await tokenOnB.totalSupply();
    LOGGER.log(`      First mint landed: balance=${fmt(balanceAfterFirstMint)}, supply=${fmt(supplyAfterFirstMint)}`);

    // ── 5. Restart Relayer-A ─────────────────────────────────────────────
    LOGGER.log('\n   5. Restarting relayer-A');
    LOGGER.log('      On restart: NATS redelivers the unacked message');
    LOGGER.log('      If vulnerable: Relayer-A resubmits with new blockNumberCC → second CC event → second crossMint');

    compose.restart('relayer-a');
    await faultA.waitUntilAlive(180_000);
    LOGGER.log('      Relayer-A is back online');

    // ── 6. Grace period for second relay round ───────────────────────────
    LOGGER.log(`\n   6. Waiting ${POST_RESTART_GRACE_MS / 1000}s for any second relay round to complete...`);
    LOGGER.log('      (Relayer-A resubmit → CC → Relayer-B → crossMint on PL-B)');

    await new Promise(r => setTimeout(r, POST_RESTART_GRACE_MS));
    LOGGER.log('      Grace period complete');

    // ── 7. Verify: no inflation ──────────────────────────────────────────
    LOGGER.log('\n   7. Checking PL-B for inflation');

    const finalSupply = await tokenOnB.totalSupply();
    const finalBalance = await tokenOnB.balanceOf(signerBAddr);

    LOGGER.log(`      PL-B totalSupply: ${fmt(finalSupply)} (expected: ${fmt(expectedSupply)})`);
    LOGGER.log(`      PL-B balance:     ${fmt(finalBalance)} (expected: ${fmt(expectedBalance)})`);

    if (finalSupply > expectedSupply) {
      const inflatedAmount = finalSupply - expectedSupply;
      LOGGER.log(`      >>> INFLATION DETECTED: ${fmt(inflatedAmount)} tokens created from nothing <<<`);
      LOGGER.log(`      Double-mint confirmed: source relayer resubmitted to CC after crash-restart`);
    }

    expect(finalSupply).to.equal(expectedSupply,
      `INFLATION: PL-B totalSupply is ${fmt(finalSupply)} but expected ${fmt(expectedSupply)}. ` +
      `${fmt(finalSupply - expectedSupply)} tokens were created from nothing due to ` +
      `source relayer crash-restart causing a double transferBatch() submission to CC.`,
    );

    expect(finalBalance).to.equal(expectedBalance,
      `INFLATION: PL-B balance is ${fmt(finalBalance)} but expected ${fmt(expectedBalance)}. ` +
      `Double crossMint detected.`,
    );

    // ── Summary ──────────────────────────────────────────────────────────
    LOGGER.log('\n================================================================');
    LOGGER.log('   PASSED: No inflation after source relayer crash-restart');
    LOGGER.log('   - Source relayer crashed after CC submission');
    LOGGER.log('   - On restart: idempotency guard prevented resubmission');
    LOGGER.log('   - PL-B totalSupply and balance are exactly correct');
    LOGGER.log('================================================================');
  });

});
