/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
/**
 * @title E2E Security Test: Atomic-B Offline Double-Spend Exploit
 * @description Simulates a realistic scenario where atomic-b is stopped before the atomic flow,
 *              preventing SUM from being sent to Hub, testing for potential exploitation of unlock() for double-spending.
 *
 * EXPLOIT SCENARIO:
 * 1. Stop atomic-b BEFORE teleportAtomic (simulates atomic-b down, or Hub unreachable)
 * 2. Alice initiates teleportAtomic(bob, 1000, chainB) on PL_A
 *    - Burns tokens on PL_A
 *    - Message registered on Hub with status=Pending
 * 3. Relayer_B delivers to PL_B, tokens minted and locked for Bob
 *    - Hub status remains PENDING (atomic-b cannot send SUM to Hub)
 * 4. Bob calls unlock() on PL_B
 *    - Succeeds due to missing access control on unlock()
 * 5. Wait for atomic service expiration timer (>1 minute)
 * 6. Restart atomic-b
 * 7. Atomic_A detects expired Pending message, calls revertAtomicMessageBatch()
 * 8. revertTeleportMint() called on PL_A, Alice gets refund
 * 9. If exploit succeeded: Bob has tokens + Alice has tokens = double-spend
 *
 * EXPECTED BEHAVIOR:
 * - Test PASSES when unlock() has proper access control (exploit blocked)
 * - Test FAILS when unlock() lacks access control (exploit succeeds = vulnerability exists)
 */

import hre from 'hardhat';
import { ethers, HDNodeWallet, Wallet } from 'ethers';
import { expect } from 'chai';
import { compose } from '../../../../../src/utils/docker-compose';
import { DEFAULT_TIMEOUT, GAS_LIMIT,LOGGER } from '../../../../../src/config/env-config';
import { PrivateHub } from '../../../../../src/entities/PrivateHub';
import { ERC20Wrapper } from '../../../../../src/entities/tokens/ERC20Wrapper';
import { ProductionErc20Token, ProductionErc20Token__factory } from '../../../../../typechain-types';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../../setup';
import { createRandomWallet, delay, eventually, submitTx} from '../../../../../src/utils/common';

// Helper to format large token balances (18 decimals) to readable form
function formatTokens(amount: bigint): string {
  return ethers.formatUnits(amount, 18);
}

/**
 * IMPORTANT: Atomic-flow expiry is enforced OFF-CHAIN by the relayer. There is no
 * on-chain lock-time/expiration window on the Hub — reverts are gated solely by
 * message status and access control.
 *
 * COMMITCHAIN_EXPIRATIONREVERTTIMEINMINUTES (off-chain, in relayer .env)
 *    - Default: 1m
 *    - Used by Atomic Service's ExpiredPoller to decide when to call revertAtomicMessageBatch()
 *    - The poller checks: if (tx.UpdatedAt + expirationPeriod < now) → trigger revert
 *
 * The VULNERABILITY WINDOW is when Hub status is PENDING and atomic-b cannot send SUM to Hub.
 * This happens when atomic-b is stopped, or Hub is unreachable, or network issues occur.
 * During this window, an attacker can call unlock(), and when the transaction expires,
 * atomic-a will trigger revert, leading to a double-spend.
 */
// Time to wait for transaction to expire. Must be > COMMITCHAIN_EXPIRATIONREVERTTIMEINMINUTES (1m).
// This ensures the expired poller on atomic-a will find the transaction and trigger revert.
const HUB_OFFLINE_DURATION_MS = 70_000; // 70s

describe('E2E SECURITY: Atomic-B Offline Double-Spend Exploit (ERC20) @serial @decommissioned', function () {
  this.timeout(360000); // 6 minutes - enough for setup + 3min polling

  const TELEPORT_AMOUNT = ethers.parseUnits('1000', 18); // 1000 tokens (with 18 decimals)
  let aliceBalanceAfterSetup: bigint;

  let privacyNodes: PrivacyNodeMap;
  let privateHub : PrivateHub;
  let token : ERC20Wrapper<ProductionErc20Token>;
  let tokenB : ProductionErc20Token;
  // Use random name/symbol from Token class to avoid conflicts with previous runs

  let aliceAddress: string;
  let bobWallet: HDNodeWallet | Wallet;

  before(async function () {
    const {initializedNodes, initializedPNH} = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    bobWallet = createRandomWallet(privacyNodes.B.provider);
    token = new ERC20Wrapper(privacyNodes.A, ProductionErc20Token__factory)

    await token.deploy();
    await token.activateOnPn();
    await token.activateOnHub(privateHub);
    aliceAddress = token.userWallet.address;

    // ProductionErc20Token constructor has no premint — mint the 2M the old factory path auto-minted.
    await token.mintAndAwait(privateHub, { toAddress: aliceAddress, amount: ethers.parseUnits('2000000', 18) });
  });

  it('Should deploy token on PL_B via vanilla teleport', async function () {
    // Teleport to Alice's address on PL_B (not Bob) to deploy the token
    // This ensures Bob starts with 0 tokens for clear accounting
    await submitTx(
      () => token.contract.teleport(
        aliceAddress,
        TELEPORT_AMOUNT,
        privacyNodes.B.chainId,
        { gasLimit: GAS_LIMIT }
      ),
      `Teleporting ${formatTokens(TELEPORT_AMOUNT)} tokens to Alice on PL_B to deploy token...`
    );

    tokenB = await privacyNodes.B.setContractByResourceId(ProductionErc20Token__factory.name, token.resourceId, token.symbol, token.userWallet.connect(privacyNodes.B.provider))
    LOGGER.log(`✅ Token deployed on PL_B at: ${await tokenB.getAddress()}`);

    // Teleport tokens back to Alice on PL_A so she starts with all 2M tokens
    // This makes the test easier to understand - Alice has everything at the start
    // Note: We need to use Alice's wallet connected to PL_B (not the default PL_B signer)
    await submitTx(
      () => tokenB.teleport(
        aliceAddress,
        TELEPORT_AMOUNT,
        privacyNodes.A.chainId,
        { gasLimit: GAS_LIMIT }
      ),
      `Teleporting ${formatTokens(TELEPORT_AMOUNT)} tokens back to Alice on PL_A...`
    );

    // Wait for Alice to receive tokens back on PL_A
    const expectedBalance = ethers.parseUnits('2000000', 18); // 2M tokens
    await token.waitForBalance(expectedBalance, aliceAddress)

    LOGGER.log(`✅ Alice now has all 2M tokens on PL_A`);
  }).timeout(DEFAULT_TIMEOUT);

  it('ATOMIC-B-OFFLINE-001: Full Atomic-B Offline Double-Spend Attack', async function () {
    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   PHASE 1: INITIAL STATE');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    // Get balances - Alice should have all 2M tokens on PL_A
    aliceBalanceAfterSetup = await token.contract.balanceOf(aliceAddress);
    const aliceBalanceOnB = await tokenB.balanceOf(aliceAddress);
    const bobBalanceInitial = await tokenB.balanceOf(bobWallet.address);

    // Get total supply on both chains
    const totalSupplyA_initial: bigint = await token.contract.totalSupply();
    const totalSupplyB_initial = await tokenB.totalSupply();
    const combinedSupply_initial = totalSupplyA_initial + totalSupplyB_initial;

    LOGGER.log(`   Alice (PL_A): ${formatTokens(aliceBalanceAfterSetup)} tokens`);
    LOGGER.log(`   Bob   (PL_B): ${formatTokens(bobBalanceInitial)} tokens`);
    LOGGER.log(`   `);
    LOGGER.log(`   TOTAL SUPPLY: ${formatTokens(combinedSupply_initial)} tokens`);
    LOGGER.log(`   Teleport amount for exploit: ${formatTokens(TELEPORT_AMOUNT)} tokens`);

    // Verify initial state is clean
    expect(aliceBalanceOnB).to.equal(0n, 'Alice should have 0 tokens on PL_B at start');
    expect(bobBalanceInitial).to.equal(0n, 'Bob should have 0 tokens at start');

    // NOTE: The atomic service has been integrated into the relayer.
    // We cannot stop relayer-b before teleportAtomic because it must deliver messages to PL_B.
    // Instead, we stop relayer-b AFTER tokens are locked on PL_B (see after Phase 4).
    // This prevents the SUM from being sent to Hub (or interrupts it if already in flight).

    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   PHASE 3: ALICE INITIATES ATOMIC TELEPORT');
    LOGGER.log('═══════════════════════════════════════════════════════════════');
    LOGGER.log(`   Alice → teleportAtomic(bob, ${formatTokens(TELEPORT_AMOUNT)}, chainB)`);

    await submitTx(
      () => token.contract.teleportAtomic(
        bobWallet.address,
        TELEPORT_AMOUNT,
        privacyNodes.B.chainId,
        { gasLimit: GAS_LIMIT }
      ),
      'teleportAtomic in progress...'
    );

    const aliceBalanceAfterAtomicBurn = await token.contract.balanceOf(aliceAddress);
    LOGGER.log(`   ✅ Alice's tokens burned. Balance: ${formatTokens(aliceBalanceAfterAtomicBurn)} tokens`);

    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   PHASE 4: WAIT FOR TOKENS LOCKED ON PL_B');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    let lockedAmount = 0n;
    await eventually<boolean>({
      check: async () => {
        lockedAmount = await tokenB.getLockedAmount(bobWallet.address);
        return lockedAmount > 0n;
      },
      message: 'Waiting for locked amount on PL_B...',
    });

    LOGGER.log(`   ✅ Tokens locked for Bob: ${formatTokens(lockedAmount)} tokens`);
    LOGGER.log(`   Hub status: PENDING (will stop relayer-b now to prevent SUM)`);

    // Stop relayer-b NOW to prevent SUM from being sent to Hub.
    // The atomic service is integrated into the relayer, so stopping relayer-b
    // after tokens are locked simulates the old atomic-b being offline.
    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   PHASE 4.5: STOP RELAYER-B (after tokens locked)');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    compose.stop('relayer-b');
    LOGGER.log(`   relayer-b stopped AFTER tokens locked on PL_B.`);
    LOGGER.log(`   Hub status should remain PENDING (relayer-b can no longer send SUM).`);
    LOGGER.log(`   relayer-a's expired poller will trigger revert when transaction expires.`);

    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   PHASE 5: BOB TRIES TO EXPLOIT unlock()');
    LOGGER.log('═══════════════════════════════════════════════════════════════');
    LOGGER.log(`   Bob calls unlock(bob, ${formatTokens(TELEPORT_AMOUNT)}) on PL_B`);

    // Use a separate random attacker wallet (not Bob, not admin) to prove ANY unauthorized
    // caller can trigger unlock — the attacker doesn't need to be the recipient
    const attackerWallet = ethers.Wallet.createRandom().connect(privacyNodes.B.provider);
    const tokenBAsAttacker = await hre.ethers.getContractAt(
      'ProductionErc20Token',
      await tokenB.getAddress(),
      attackerWallet
    );

    let exploitSucceeded = false;
    try {
      const exploitTx = await tokenBAsAttacker.unlock(bobWallet.address, TELEPORT_AMOUNT, { gasLimit: GAS_LIMIT });
      await exploitTx.wait();

      const bobBalanceAfterUnlock = await tokenB.balanceOf(bobWallet);
      const lockedAfterUnlock = await tokenB.getLockedAmount(bobWallet);

      LOGGER.log(`   EXPLOIT SUCCEEDED - unlock() has no access control`);
      LOGGER.log(`   Bob's balance after unlock: ${formatTokens(bobBalanceAfterUnlock)} tokens`);
      LOGGER.log(`   Bob's locked amount: ${formatTokens(lockedAfterUnlock)} tokens`);

      exploitSucceeded = true;

    } catch (error: any) {
      // Any revert from unlock() means the exploit was blocked
      // The receiveMethod modifier causes a revert (may have no reason string)
      const errorMsg = error.message || '';
      LOGGER.log(`   EXPLOIT BLOCKED - Access control is present`);
      LOGGER.log(`   Transaction reverted (this is expected when fix is applied)`);
      if (errorMsg.includes('receive method') || errorMsg.includes('executor')) {
        LOGGER.log(`   Reason: receiveMethod modifier blocked unauthorized call`);
      }
    }

    // Continue to remaining phases regardless of exploit result
    // This ensures we capture the full state for verification

    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   PHASE 6: WAIT FOR TRANSACTION TO EXPIRE');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    LOGGER.log(`   Waiting ${HUB_OFFLINE_DURATION_MS / 1000}s for transaction to expire...`);
    LOGGER.log(`   (COMMITCHAIN_EXPIRATIONREVERTTIMEINMINUTES should be 1m or less)`);
    await delay(HUB_OFFLINE_DURATION_MS);

    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   PHASE 7: RESTART RELAYER-B');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    compose.start('relayer-b');
    LOGGER.log(`   relayer-b re-started.`);
    LOGGER.log(`   Transaction already expired -> relayer-a will query Hub and see PENDING`);
    LOGGER.log(`   relayer-a will trigger revert (no race since Hub never saw EXECUTED)`);

    // Track atomic flow completion status
    let revertCompleted = false;
    let executeCompleted = false;

    // PHASE 8: Wait for atomic flow to complete (execute or revert)
    // This is needed regardless of whether exploit succeeded or was blocked
    // - If exploit succeeded: wait for revert to confirm double-spend
    // - If exploit was blocked: wait for execute OR revert to complete normally
    {
      LOGGER.log('\n═══════════════════════════════════════════════════════════════');
      LOGGER.log('   PHASE 8: WAIT FOR ATOMIC FLOW TO COMPLETE');
      LOGGER.log('═══════════════════════════════════════════════════════════════');

      if (exploitSucceeded) {
        LOGGER.log(`   Exploit succeeded - Bob has tokens via unauthorized unlock()`);
        LOGGER.log(`   Revert EXPECTED - Hub status is PENDING (relayer-b was stopped, never sent SUM).`);
      } else {
        LOGGER.log(`   Exploit was BLOCKED - waiting for atomic flow to complete normally...`);
        LOGGER.log(`   The flow should either EXECUTE (Bob gets tokens) or REVERT (Alice gets refund because her tokens were burned in teleportAtomic()).`);
      }
      LOGGER.log(`   `);
      LOGGER.log(`   TIMING CONFIGURATION:`);
      LOGGER.log(`   └─ COMMITCHAIN_EXPIRATIONREVERTTIMEINMINUTES = 1m (off-chain, relayer .env)`);
      LOGGER.log(`      └─ Relayer's ExpiredPoller uses this to trigger revertAtomicMessageBatch()`);
      LOGGER.log(`   Waiting for Relayer-A to trigger revert flow...`);

      /**
       * ═══════════════════════════════════════════════════════════════════════════════
       * EDUCATIONAL: MANUAL REVERT (commented out)
       * ═══════════════════════════════════════════════════════════════════════════════
       *
       * In production, the Atomic Service automatically calls revertAtomicMessageBatch()
       * after COMMITCHAIN_EXPIRATIONREVERTTIMEINMINUTES has passed.
       *
       * However, you can also trigger the revert manually if you have an authorized
       * relayer wallet. Here's how:
       *
       * 1. First, capture the message IDs from the AtomicMessageTeleportStartedBatch event:
       *
       *    const teleportV1 = privateHub.contract['TeleportV1'] as TeleportV1;
       *    const filter = teleportV1.filters.AtomicMessageTeleportStartedBatch();
       *    const recentEvents = await teleportV1.queryFilter(filter, -100);
       *    const latestEvent = recentEvents[recentEvents.length - 1];
       *    const msgIds = [...(latestEvent.args?.msgIds || [])];
       *
       * 2. Then call revertAtomicMessageBatch() with the message IDs:
       *
       *    const revertTx = await teleportV1.revertAtomicMessageBatch(msgIds, '', { gasLimit: GAS_LIMIT });
       *    await revertTx.wait();
       *
       * NOTE: revertAtomicMessageBatch() has the `restricted` modifier (AUTH-V3),
       * so the caller must hold RELAYER in the RaylsAccessManagerV1 on the Hub.
       * Reverts are gated by message status and access control — there is no on-chain
       * time/expiration window, so an authorized relayer can revert a PENDING message at any time.
       * ═══════════════════════════════════════════════════════════════════════════════
       */

      const maxWaitForAtomicFlow = 180; // 3 minutes: brief wait to confirm no revert happens
      const startTime = Date.now();

      // Also check Bob's locked amount - if it goes to 0, execute completed
      const bobLockedInitial = await tokenB.getLockedAmount(bobWallet);
      LOGGER.log(`   Bob's initial locked amount: ${formatTokens(bobLockedInitial)} tokens`);

      while ((Date.now() - startTime) / 1000 < maxWaitForAtomicFlow) {
        const aliceCurrentBalance = await token.contract.balanceOf(aliceAddress);
        const bobCurrentBalance = await tokenB.balanceOf(bobWallet);
        const bobLockedCurrent = await tokenB.getLockedAmount(bobWallet);
        const elapsed = Math.floor((Date.now() - startTime) / 1000);

        // Check if REVERT completed (Alice gets refund)
        if (aliceCurrentBalance > aliceBalanceAfterAtomicBurn) {
          LOGGER.log(`   ✅ REVERT COMPLETED by Atomic-A service! (after ${elapsed}s)`);
          LOGGER.log(`   Alice's balance: ${formatTokens(aliceBalanceAfterAtomicBurn)} → ${formatTokens(aliceCurrentBalance)} tokens`);
          revertCompleted = true;
          break;
        }

        // Check if EXECUTE completed (Bob's locked tokens released via normal flow)
        // This can happen if Atomic-B successfully calls executeAtomicMessageBatch
        if (!exploitSucceeded && bobLockedCurrent === 0n && bobCurrentBalance >= TELEPORT_AMOUNT) {
          LOGGER.log(`   ✅ EXECUTE COMPLETED by Atomic-B service! (after ${elapsed}s)`);
          LOGGER.log(`   Bob's locked amount: ${formatTokens(bobLockedInitial)} → ${formatTokens(bobLockedCurrent)}`);
          LOGGER.log(`   Bob's balance: ${formatTokens(bobCurrentBalance)} tokens (received via normal execute)`);
          executeCompleted = true;
          break;
        }

        LOGGER.log(`   [${elapsed}s] Polling... Alice: ${formatTokens(aliceCurrentBalance)}, Bob: ${formatTokens(bobCurrentBalance)}, Bob locked: ${formatTokens(bobLockedCurrent)}`);
        await new Promise(resolve => setTimeout(resolve, 10000));
      }

      if (!revertCompleted && !executeCompleted) {
        // Check one more time
        const aliceFinal = await token.contract.balanceOf(aliceAddress);
        const bobFinal = await tokenB.balanceOf(bobWallet);
        const bobLockedFinal = await tokenB.getLockedAmount(bobWallet);

        if (aliceFinal > aliceBalanceAfterAtomicBurn) {
          LOGGER.log(`   ✅ REVERT COMPLETED by Atomic-A service!`);
          LOGGER.log(`   Alice's balance: ${formatTokens(aliceBalanceAfterAtomicBurn)} → ${formatTokens(aliceFinal)} tokens`);
          revertCompleted = true;
        } else if (!exploitSucceeded && bobLockedFinal === 0n && bobFinal >= TELEPORT_AMOUNT) {
          LOGGER.log(`   ✅ EXECUTE COMPLETED by Atomic-B service!`);
          LOGGER.log(`   Bob received tokens via normal execute flow`);
          executeCompleted = true;
        } else {
          LOGGER.log(`   ⚠️ Atomic flow did not complete within ${maxWaitForAtomicFlow}s.`);
          LOGGER.log(`   Alice balance: ${formatTokens(aliceFinal)}, Bob balance: ${formatTokens(bobFinal)}, Bob locked: ${formatTokens(bobLockedFinal)}`);
          LOGGER.log(`   Check that atomic-a/atomic-b services are running and COMMITCHAIN_EXPIRATIONREVERTTIMEINMINUTES=1m`);
        }
      }
    } // end PHASE 8 block

    // PHASE 8.5: Wait for destination chain cleanup (revertTeleportBurn)
    // After revert completes on source chain, the atomic service should also
    // call revertTeleportBurn on the destination chain to burn orphaned tokens.
    if (revertCompleted) {
      LOGGER.log('\n═══════════════════════════════════════════════════════════════');
      LOGGER.log('   PHASE 8.5: WAIT FOR DESTINATION CHAIN CLEANUP');
      LOGGER.log('═══════════════════════════════════════════════════════════════');

      const supplyBefore = await tokenB.totalSupply();
      LOGGER.log(`   PL_B supply before cleanup: ${formatTokens(supplyBefore)} tokens`);
      LOGGER.log(`   Waiting 30s for revertTeleportBurn on PL_B...`);

      const cleanupWaitTime = 30; // seconds
      await new Promise(resolve => setTimeout(resolve, cleanupWaitTime * 1000));

      const supplyAfter = await tokenB.totalSupply();
      const bobLockedAfterCleanup = await tokenB.getLockedAmount(bobWallet);

      if (supplyAfter < supplyBefore) {
        LOGGER.log(`   ✅ DESTINATION CLEANUP COMPLETED!`);
        LOGGER.log(`   PL_B supply: ${formatTokens(supplyBefore)} → ${formatTokens(supplyAfter)} tokens`);
        LOGGER.log(`   Burned: ${formatTokens(supplyBefore - supplyAfter)} tokens`);
      } else if (bobLockedAfterCleanup > 0n) {
        LOGGER.log(`   ⚠️ DESTINATION CLEANUP NOT EXECUTED`);
        LOGGER.log(`   PL_B supply unchanged: ${formatTokens(supplyAfter)} tokens`);
        LOGGER.log(`   Bob still has ${formatTokens(bobLockedAfterCleanup)} locked tokens (orphaned)`);
        LOGGER.log(`   NOTE: Relayer may not be calling revertTeleportBurn on destination chain.`);
      } else {
        LOGGER.log(`   ℹ️ No orphaned tokens to clean up on PL_B`);
      }
    }

    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   PHASE 9: VERIFY DOUBLE-SPEND');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    const aliceFinalBalance = await token.contract.balanceOf(aliceAddress);
    const bobFinalBalance = await tokenB.balanceOf(bobWallet);
    const bobLockedFinal = await tokenB.getLockedAmount(bobWallet);

    // Get total supply on both chains (using totalSupply() for accuracy)
    const totalSupplyA_final = await token.contract.totalSupply();
    const totalSupplyB_final = await tokenB.totalSupply();
    const combinedSupply_final: bigint = totalSupplyA_final + totalSupplyB_final;
    const tokensCreatedFromNothing = combinedSupply_final - combinedSupply_initial;

    LOGGER.log(`\n   FINAL STATE:`);
    LOGGER.log(`   ├─ Alice (PL_A): ${formatTokens(aliceFinalBalance)} tokens`);
    LOGGER.log(`   ├─ Bob   (PL_B): ${formatTokens(bobFinalBalance)} tokens`);
    LOGGER.log(`   └─ Bob locked (PL_B): ${formatTokens(bobLockedFinal)} tokens`);
    LOGGER.log(`   `);
    LOGGER.log(`   TOTAL SUPPLY:`);
    LOGGER.log(`   ├─ PL_A: ${formatTokens(totalSupplyA_final)} tokens`);
    LOGGER.log(`   ├─ PL_B: ${formatTokens(totalSupplyB_final)} tokens`);
    LOGGER.log(`   ├─ COMBINED: ${formatTokens(combinedSupply_final)} tokens`);
    LOGGER.log(`   └─ BEFORE:   ${formatTokens(combinedSupply_initial)} tokens`);

    if (tokensCreatedFromNothing > 0n) {
      LOGGER.log(`   ⚠️ INFLATION DETECTED: +${formatTokens(tokensCreatedFromNothing)} tokens created`);
      if (exploitSucceeded) {
        LOGGER.log(`      Cause: Double-spend exploit (Bob unlocked + Alice refunded)`);
      } else if (bobLockedFinal > 0n) {
        LOGGER.log(`      Cause: Stranded tokens on PL_B (revertTeleportBurn not called or failed)`);
        LOGGER.log(`      Bob has ${formatTokens(bobLockedFinal)} locked tokens that inflate total supply.`);
        LOGGER.log(`      NOTE: This is a bug - destination cleanup should burn these tokens.`);
      } else {
        LOGGER.log(`      Cause: Unknown supply mismatch`);
      }
    } else if (tokensCreatedFromNothing < 0n) {
      LOGGER.log(`   ⚠️ TOKEN LOSS DETECTED: ${formatTokens(tokensCreatedFromNothing)} tokens destroyed`);
      LOGGER.log(`      Cause: partial revert — Alice's tokens were burned in teleportAtomic but never refunded,`);
      LOGGER.log(`      while the destination locked copy was burned. Value is permanently lost / the flow is stuck.`);
      LOGGER.log(`      NOTE: a "flow did not complete" warning with a supply shortfall is a real failure, not a benign timeout.`);
    }

    // DOUBLE-SPEND ASSERTION:
    // 1. Bob must have tokens (stolen via unlock())
    // 2. Alice must have been refunded (balance restored after revert)
    const bobHasTokens = bobFinalBalance >= TELEPORT_AMOUNT;
    const aliceWasRefunded = aliceFinalBalance >= aliceBalanceAfterSetup;
    const doubleSpendConfirmed = bobHasTokens && aliceWasRefunded;

    LOGGER.log(`\n   DOUBLE-SPEND CHECK:`);
    LOGGER.log(`   ├─ Bob has tokens (>= ${formatTokens(TELEPORT_AMOUNT)}): ${bobHasTokens ? 'YES' : 'NO'} (has ${formatTokens(bobFinalBalance)})`);
    LOGGER.log(`   ├─ Alice was refunded (>= ${formatTokens(aliceBalanceAfterSetup)}): ${aliceWasRefunded ? 'YES' : 'NO'} (has ${formatTokens(aliceFinalBalance)})`);
    LOGGER.log(`   └─ DOUBLE-SPEND: ${doubleSpendConfirmed ? '🚨️ CONFIRMED' : 'UNCONFIRMED'}`);

    if (doubleSpendConfirmed) {
      LOGGER.log(`\n   🚨️ DOUBLE-SPEND CONFIRMED`);
      LOGGER.log(`   Bob received ${formatTokens(TELEPORT_AMOUNT)} tokens via unauthorized unlock()`);
      LOGGER.log(`   Alice was refunded ${formatTokens(TELEPORT_AMOUNT)} tokens via revert`);
      LOGGER.log(`   Net effect: ${formatTokens(TELEPORT_AMOUNT)} tokens created from nothing`);
    } else if (!exploitSucceeded && executeCompleted) {
      LOGGER.log(`\n   ✅ NORMAL FLOW COMPLETED`);
      LOGGER.log(`   Exploit was blocked, and atomic flow executed normally.`);
      LOGGER.log(`   Bob received ${formatTokens(bobFinalBalance)} tokens via legitimate execute.`);
    } else if (!exploitSucceeded && revertCompleted) {
      LOGGER.log(`\n   ✅ NORMAL REVERT COMPLETED`);
      LOGGER.log(`   Exploit was blocked, and atomic flow reverted (possibly due to timeout).`);
      LOGGER.log(`   Alice was refunded ${formatTokens(TELEPORT_AMOUNT)} tokens (balance: ${formatTokens(aliceFinalBalance)}).`);
    } else if (bobHasTokens && !revertCompleted) {
      LOGGER.log(`\n   Bob has tokens. Waiting for Alice's refund...`);
      LOGGER.log(`   Exploit in progress. Revert may complete later.`);
    }

    // SECURITY ASSERTION:
    // Test PASSES when exploit is blocked (no double-spend possible)
    // Test FAILS when exploit succeeds (vulnerability exists)
    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   SECURITY VERDICT');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    if (!exploitSucceeded) {
      LOGGER.log('   ✅ SECURE: unlock() access control is working correctly');
      LOGGER.log('   The exploit was blocked - no unauthorized token release occurred.');
      if (executeCompleted) {
        LOGGER.log('   Atomic flow completed via EXECUTE - Bob received tokens legitimately.');
      } else if (revertCompleted) {
        LOGGER.log('   Atomic flow completed via REVERT - Alice was refunded.');
      } else {
        LOGGER.log('   ⚠️ Atomic flow did not complete - check atomic services.');
      }
      LOGGER.log('   Test PASSES.');
    } else if (doubleSpendConfirmed) {
      LOGGER.log('   ⚠️  VULNERABLE: Double-spend exploit succeeded!');
      LOGGER.log(`   Bob received ${formatTokens(TELEPORT_AMOUNT)} tokens via unauthorized unlock()`);
      LOGGER.log(`   Alice was refunded ${formatTokens(TELEPORT_AMOUNT)} tokens via revert`);
      LOGGER.log(`   Net effect: ${formatTokens(tokensCreatedFromNothing)} tokens created from nothing`);
      LOGGER.log('   Test FAILS - fix the unlock() access control!');
    } else {
      LOGGER.log('   ⚠️  VULNERABLE: Exploit partially succeeded');
      LOGGER.log(`   Bob has tokens: ${bobHasTokens}, Alice refunded: ${aliceWasRefunded}`);
      LOGGER.log('   Test FAILS - unlock() lacks proper access control!');
    }

    // The test PASSES only if the exploit was BLOCKED
    expect(!exploitSucceeded,
      `VULNERABILITY DETECTED: unlock() lacks access control! ` +
      `Bob was able to call unlock() directly and received ${formatTokens(bobFinalBalance)} tokens. ` +
      `Add the 'receiveMethod' modifier to unlock() to fix this vulnerability.`
    ).to.be.true;

    // The test also FAILS on ANY supply mismatch. A correct atomic teleport ends in EXECUTE
    // (Bob credited) or REVERT (Alice refunded) — both conserve combined supply. This single
    // bidirectional check catches BOTH inflation (double-spend / mint-from-nothing, delta > 0)
    // AND token loss (partial revert / stuck flow that burned without refunding, delta < 0).
    // The previous check only caught delta > 0, so the −1000 loss in ATOMIC-B-OFFLINE-001 passed silently.
    // Note: a still-locked copy on PL_B keeps combined supply unchanged, so a merely-slow flow
    // does NOT trip this — only genuine inflation or genuine loss does.
    const supplyConserved = combinedSupply_final === combinedSupply_initial;
    expect(supplyConserved,
      `SUPPLY NOT CONSERVED: combined total supply changed by ${formatTokens(tokensCreatedFromNothing)} tokens ` +
      `(before ${formatTokens(combinedSupply_initial)} → after ${formatTokens(combinedSupply_final)}). ` +
      `Alice ${formatTokens(aliceFinalBalance)}, Bob ${formatTokens(bobFinalBalance)}, Bob locked ${formatTokens(bobLockedFinal)}. ` +
      (tokensCreatedFromNothing > 0n
        ? `INFLATION — double-spend or stranded locked tokens (revertTeleportBurn missing).`
        : `TOKEN LOSS — burned in teleportAtomic but never refunded (partial revert / stuck flow).`)
    ).to.be.true;
  });

  after(async function () {
    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   CLEANUP: Ensuring services are running...');
    LOGGER.log('═══════════════════════════════════════════════════════════════');
    try {
      compose.start('relayer-b');
    } catch {
      LOGGER.log('   Services may already be running or docker compose not available');
    }
  });
});
