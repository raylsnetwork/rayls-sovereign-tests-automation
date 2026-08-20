/**
 * @title E2E SECURITY: Dest Relayer Crash After History Insert → Token Loss
 *
 * Reproduces a token loss scenario where the destination relayer crashes after
 * inserting the EnygmaHistory record but BEFORE calling crossMint on PL-B.
 * On restart, the receiver finds the existing history and skips the batch,
 * permanently losing the tokens (burned on PL-A, never minted on PL-B).
 *
 * VULNERABILITY:
 *   The receiver uses a single DB record as both "processing started" and
 *   "processing completed" marker. When a crash occurs between history insert
 *   and crossMint execution, the DB record prevents retry, but the tokens
 *   were never minted on the destination PL.
 *
 * SCENARIO:
 *   1. Deploy Enygma token on PL-A, mint tokens to userA
 *   2. Initial cross-transfer PL-A → PL-B (establishes token on PL-B)
 *   3. Arm one-shot crash on Relayer-B at after_insert_history
 *   4. Second cross-transfer PL-A → PL-B
 *   5. Relayer-B inserts history record → CRASHES (os.Exit) before crossMint
 *   6. Restart Relayer-B via compose.sh
 *   7. Relayer-B retries: finds existing history → skips → crossMint never called
 *   8. Assert: PL-B supply did NOT increase (tokens permanently lost)
 *
 * CRASH POINT:
 *   enygma.handler.Receiver.HandleEnygmaCrossTransfer.after_insert_history
 *   In receiver.go, AFTER InsertEnygmaHistory() succeeds and AFTER the
 *   empty-batch check (line ~204), but BEFORE destMintBatcher.Send() is called.
 *
 * TEST OUTCOME:
 *   - FAILS when vulnerability is present (tokens lost, supply mismatch)
 *   - PASSES when the fix is applied (tokens arrive despite crash)
 *
 * RELATED:
 *   Issue: SEC-RELAY-CRASH-INFLATION
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
const INITIAL_MINT = TRANSFER_AMOUNT * 2n;

// Grace period after relayer-B restart for any processing to complete
const POST_RESTART_GRACE_MS = 45_000;

function fmt(amount: bigint): string {
  return ethers.formatUnits(amount, 18);
}

describe('E2E SECURITY: Dest Relayer Crash After History Insert → Token Loss', function () {
  this.timeout(DEFAULT_TIMEOUT * 10);

  let raylsNodes: PrivacyNodeMap;
  let commitChain: PrivateHub;

  let enygma: EnygmaWrapper<ProductionEnygmaToken>;
  let tokenOnA: ProductionEnygmaToken;
  let tokenOnB: ProductionEnygmaToken;

  let userA: ethers.HDNodeWallet;
  let faultB: FaultInjector;
  let sessionB: FaultSession;

  before(async function () {
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    raylsNodes = initializedNodes;
    commitChain = initializedPNH;

    // Fault injector for Relayer-B (DESTINATION relayer, port 6661)
    faultB = FaultInjector.forRelayer('B', '127.0.0.1');

    LOGGER.log('\n   SETUP');
    LOGGER.log('   ─────────────────────────────────────────────────');

    const fiAlive = await faultB.isAlive();
    expect(fiAlive).to.equal(true,
      'Fault injection API must be reachable on relayer-B (port 6661). ' +
      'Ensure FAULT_INJECTION_ENABLED=true in .B.env and port 6661 is exposed.'
    );
    sessionB = await faultB.newSession();
    LOGGER.log(`   Fault injection API on relayer-B: reachable, session ${sessionB.id} created`);

    userA = createRandomWallet(raylsNodes.A.provider);
    await (await raylsNodes.A.adminWallet.sendTransaction({
      to: userA.address,
      value: ethers.parseEther('5.0'),
    })).wait();

    enygma = new EnygmaWrapper<ProductionEnygmaToken>(raylsNodes.A, ProductionEnygmaToken__factory);
    await enygma.deployViaFactory();
    await enygma.activateOnPn();
    await enygma.activateOnHub(commitChain);

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

    // First cross-transfer to establish token on PL-B
    const tokenOnAAsUser = tokenOnA.connect(userA) as ProductionEnygmaToken;
    await submitTx(
      () => tokenOnAAsUser.linearCrossTransfer(
        raylsNodes.B.userWallet.address, TRANSFER_AMOUNT, raylsNodes.B.chainId,
        [], // plain transfer (no programmability)
        { gasLimit: 5_000_000 },
      ),
      `Cross-transfer ${fmt(TRANSFER_AMOUNT)} PL-A -> PL-B (setup)`,
    );

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

    await eventually({
      check: async () => (await tokenOnB.balanceOf(raylsNodes.B.userWallet.address)) === TRANSFER_AMOUNT,
      message: 'Waiting for setup transfer balance on PL-B',
    });

    LOGGER.log(`   Token on PL-A: ${await tokenOnA.getAddress()}`);
    LOGGER.log(`   Token on PL-B: ${await tokenOnB.getAddress()}`);
    LOGGER.log(`   PL-B balance (setup):     ${fmt(await tokenOnB.balanceOf(raylsNodes.B.userWallet.address))}`);
    LOGGER.log(`   PL-B totalSupply (setup): ${fmt(await tokenOnB.totalSupply())}`);
    LOGGER.log(`   PL-A userA balance:       ${fmt(await tokenOnA.balanceOf(userA.address))}`);

    // Stabilization: wait for any background processing to complete on Relayer-B
    // (finalization, checkpoints, stale NATS redeliveries from previous tests)
    LOGGER.log('   Waiting 30s for Relayer-B background processing to settle...');
    await new Promise(r => setTimeout(r, 30_000));
    LOGGER.log('   Stabilization complete');
    LOGGER.log('   Setup complete\n');
  });

  after(async function () {
    try {
      // Belt and suspenders: ensure relayer-B is up, then drop the session.
      if (!(await faultB.isAlive())) {
        compose.start('relayer-b');
        await faultB.waitUntilAlive(180_000);
      }
      if (sessionB) await sessionB.clear();
    } catch { /* best-effort cleanup */ }
  });

  it('dest relayer crash after history insert: crossMint never called → tokens permanently lost', async function () {
    LOGGER.log('================================================================');
    LOGGER.log('   Dest relayer crash after history insert → token loss');
    LOGGER.log('================================================================');

    const signerBAddr = raylsNodes.B.userWallet.address;
    const supplyBBefore = await tokenOnB.totalSupply();
    const balanceBBefore = await tokenOnB.balanceOf(signerBAddr);
    const balanceABefore = await tokenOnA.balanceOf(userA.address);
    const expectedSupplyB = supplyBBefore + TRANSFER_AMOUNT;
    const expectedBalanceB = balanceBBefore + TRANSFER_AMOUNT;

    LOGGER.log(`\n   PL-B totalSupply before:  ${fmt(supplyBBefore)}`);
    LOGGER.log(`   PL-B balance before:      ${fmt(balanceBBefore)}`);
    LOGGER.log(`   PL-A userA balance:       ${fmt(balanceABefore)}`);
    LOGGER.log(`   Transfer amount:          ${fmt(TRANSFER_AMOUNT)}`);
    LOGGER.log(`   Expected PL-B supply:     ${fmt(expectedSupplyB)}`);

    // ── 1. Arm one-shot crash on Relayer-B (DEST) ────────────────────────
    // The fault point in receiver.go fires only for batches with actual
    // transactions (empty cover-traffic batches exit before the fault point),
    // so the one-shot fault can only be consumed by a real transfer.
    LOGGER.log('\n   1. Arming one-shot crash at AFTER_INSERT_HISTORY on relayer-B');
    LOGGER.log('      (crashes AFTER history DB insert, BEFORE crossMint)');

    expect(await faultB.isAlive()).to.equal(true, 'Relayer-B should be alive before arming fault');

    await sessionB.arm({
      point: FAULT_POINTS.AFTER_INSERT_HISTORY,
      action: 'crash',
      one_shot: true,
    });

    const armed = await sessionB.status();
    expect(armed.rules[FAULT_POINTS.AFTER_INSERT_HISTORY]).to.exist;
    LOGGER.log('      Rule armed: after_insert_history -> crash (one-shot)');

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

    // Verify tokens were burned on PL-A
    const balanceAAfterBurn = await tokenOnA.balanceOf(userA.address);
    LOGGER.log(`      PL-A userA balance after burn: ${fmt(balanceAAfterBurn)}`);
    expect(balanceAAfterBurn).to.equal(balanceABefore - TRANSFER_AMOUNT,
      'Tokens should be burned on PL-A after linearCrossTransfer');

    // ── 3. Wait for Relayer-B to crash ───────────────────────────────────
    LOGGER.log('\n   3. Waiting for relayer-B to crash...');
    LOGGER.log('      (Relayer-A → CC → Relayer-B picks up → inserts history → CRASH)');
    LOGGER.log('      Full relay pipeline takes 20-60s: PL-A event → Relayer-A ZK proof → CC → Relayer-B');

    const crashStartTime = Date.now();
    await faultB.waitForCrash(180_000);
    const crashElapsedMs = Date.now() - crashStartTime;
    LOGGER.log(`      Relayer-B is down (crash detected after ${(crashElapsedMs / 1000).toFixed(1)}s)`);
    LOGGER.log('      At this point: history inserted in DB, but crossMint NEVER called');

    // ── 4. Restart Relayer-B ─────────────────────────────────────────────
    LOGGER.log('\n   4. Restarting relayer-B');
    LOGGER.log('      On restart: message redelivered → history exists → SKIP');
    LOGGER.log('      crossMint will NOT be called (history acts as "processed" marker)');

    compose.restart('relayer-b');
    await faultB.waitUntilAlive(180_000);
    LOGGER.log('      Relayer-B is back online');

    // ── 5. Grace period ──────────────────────────────────────────────────
    LOGGER.log(`\n   5. Waiting ${POST_RESTART_GRACE_MS / 1000}s for any processing to complete...`);

    await new Promise(r => setTimeout(r, POST_RESTART_GRACE_MS));
    LOGGER.log('      Grace period complete');

    // ── 6. Verify: token loss ────────────────────────────────────────────
    LOGGER.log('\n   6. Checking PL-B for token loss');

    const finalSupplyB = await tokenOnB.totalSupply();
    const finalBalanceB = await tokenOnB.balanceOf(signerBAddr);
    const finalBalanceA = await tokenOnA.balanceOf(userA.address);

    LOGGER.log(`      PL-B totalSupply: ${fmt(finalSupplyB)} (expected: ${fmt(expectedSupplyB)})`);
    LOGGER.log(`      PL-B balance:     ${fmt(finalBalanceB)} (expected: ${fmt(expectedBalanceB)})`);
    LOGGER.log(`      PL-A userA bal:   ${fmt(finalBalanceA)} (burned: ${fmt(balanceABefore - finalBalanceA)})`);

    if (finalSupplyB < expectedSupplyB) {
      const lostAmount = expectedSupplyB - finalSupplyB;
      LOGGER.log(`      >>> TOKEN LOSS DETECTED: ${fmt(lostAmount)} tokens burned on PL-A but never minted on PL-B <<<`);
      LOGGER.log(`      Tokens permanently destroyed: burned on source, history prevents retry on dest`);
    }

    expect(finalSupplyB).to.equal(expectedSupplyB,
      `TOKEN LOSS: PL-B totalSupply is ${fmt(finalSupplyB)} but expected ${fmt(expectedSupplyB)}. ` +
      `${fmt(expectedSupplyB - finalSupplyB)} tokens were burned on PL-A but never minted on PL-B. ` +
      `The dest relayer's history record prevented crossMint retry after crash.`,
    );

    expect(finalBalanceB).to.equal(expectedBalanceB,
      `TOKEN LOSS: PL-B balance is ${fmt(finalBalanceB)} but expected ${fmt(expectedBalanceB)}.`,
    );

    LOGGER.log('\n================================================================');
    LOGGER.log('   PASSED: No token loss after dest relayer crash-restart');
    LOGGER.log('   - History insert + crossMint are properly transactional');
    LOGGER.log('   - Tokens correctly minted on PL-B despite crash');
    LOGGER.log('================================================================');
  });

});
