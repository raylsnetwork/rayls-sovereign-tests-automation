/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
/**
 * @title E2E Security Test: Atomic-B Offline Double-Spend Exploit (ERC1155)
 * @description Simulates a realistic scenario where atomic-b is stopped before the atomic flow,
 *              preventing SUM from being sent to Hub, testing for potential exploitation of unlock() for double-spending.
 *
 * EXPLOIT SCENARIO:
 * 1. Stop atomic-b BEFORE teleportAtomic (simulates atomic-b down, or Hub unreachable)
 * 2. Alice initiates teleportAtomic(bob, tokenId, amount, chainB) on PL_A
 *    - Burns tokens on PL_A
 *    - Message registered on Hub with status=Pending
 * 3. Relayer_B delivers to PL_B, tokens minted and locked for Bob
 *    - Hub status remains PENDING (atomic-b cannot send SUM to Hub)
 * 4. Bob calls unlock() on PL_B
 *    - Succeeds due to missing access control on unlock()
 * 5. Wait for atomic service expiration timer (>1 minute)
 * 6. Restart atomic-b
 * 7. Atomic_A detects expired Pending message, calls revertAtomicMessageBatch()
 * 8. revertTeleportMint() called on PL_A, Alice gets tokens back
 * 9. If exploit succeeded: Bob has tokens + Alice has tokens = double-spend
 *
 * EXPECTED BEHAVIOR:
 * - Test PASSES when unlock() has proper access control (exploit blocked)
 * - Test FAILS when unlock() lacks access control (exploit succeeds = vulnerability exists)
 */

import hre from 'hardhat';
import { HDNodeWallet, Wallet } from 'ethers';
import { expect } from 'chai';
import { PrivateHub } from '../../../../../src/entities/PrivateHub';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../../setup';
import { RaylsErc1155Example, RaylsErc1155Example__factory } from '../../../../../typechain-types';
import { ERC1155Wrapper } from '../../../../../src/entities/tokens/ERC1155Wrapper';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../../../src/config/env-config';
import { createRandomWallet, delay, eventually, submitTx } from '../../../../../src/utils/common';
import { compose } from '../../../../../src/utils/docker-compose';

const HUB_OFFLINE_DURATION_MS = 70_000; // 70s — must be > COMMITCHAIN_EXPIRATIONREVERTTIMEINMINUTES (1m)

describe('E2E SECURITY: Atomic-B Offline Double-Spend Exploit (ERC1155) @serial @decommissioned', function () {
  this.timeout(DEFAULT_TIMEOUT*10);
  const TOKEN_ID = 0n; // Token ID exercised by the exploit
  const TELEPORT_AMOUNT = 30n; // Amount to teleport
  const MINT_AMOUNT = 1000n; // Initial supply minted to Alice (factory instances start at zero)

  let privacyNodes: PrivacyNodeMap;

  let privateHub : PrivateHub;
  let token : ERC1155Wrapper<RaylsErc1155Example>;
  let tokenB : RaylsErc1155Example;

  let aliceAddress: string;
  let bobWallet: HDNodeWallet | Wallet;
  let aliceInitialBalance: bigint;

  before(async function () {
    const {initializedNodes, initializedPNH} = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    bobWallet = createRandomWallet(privacyNodes.B.provider);

    token = new ERC1155Wrapper(privacyNodes.A, RaylsErc1155Example__factory);
    await token.deploy();
    await token.activateOnPn();
    await token.activateOnHub(privateHub);
    aliceAddress = token.userWallet.address;

    // Erc1155TokenExample constructor premints id 0 (Gold, 100) to the deployer; add MINT_AMOUNT more for a
    // known baseline. Balances below are asserted relative to aliceInitialBalance.
    await token.mintAndAwait(privateHub, { toAddress: aliceAddress, tokenId: TOKEN_ID, amount: MINT_AMOUNT });

    // Store initial balance
    aliceInitialBalance = await token.contract.balanceOf(aliceAddress, TOKEN_ID);
    LOGGER.log(`Alice's initial balance of token ID ${TOKEN_ID}: ${aliceInitialBalance}`);
  });

  it('Should deploy token on PL_B via vanilla teleport', async function () {
    // Teleport some tokens to Alice on PL_B to deploy the contract
    await submitTx(
      () => token.contract.teleport(
        aliceAddress, // Teleport to Alice on PL_B
        TOKEN_ID,
        TELEPORT_AMOUNT,
        privacyNodes.B.chainId,
        token.data(),
        { gasLimit: GAS_LIMIT }
      ),
      `Teleporting ${TELEPORT_AMOUNT} tokens (ID ${TOKEN_ID}) to Alice on PL_B to deploy contract...`
    );

    await privacyNodes.B.setContractByResourceId(RaylsErc1155Example__factory.name, token.resourceId, token.symbol, token.userWallet.connect(privacyNodes.B.provider));
    tokenB = privacyNodes.B.getContract<RaylsErc1155Example>(token.symbol);

    LOGGER.log(`Token deployed on PL_B at: ${await tokenB.getAddress()}`);

    await submitTx(
      () => tokenB.teleport(
        aliceAddress,
        TOKEN_ID,
        TELEPORT_AMOUNT,
        privacyNodes.A.chainId,
        token.data(),
        { gasLimit: GAS_LIMIT }
      ),
      `Teleporting ${TELEPORT_AMOUNT} tokens back to Alice on PL_A...`
    );

    await token.waitForBalance(aliceInitialBalance, aliceAddress, TOKEN_ID)

    LOGGER.log(`Alice now has all tokens on PL_A`);
  }).timeout(DEFAULT_TIMEOUT);

  it('ATOMIC-B-OFFLINE-003: Full Atomic-B Offline Double-Spend Attack (ERC1155)', async function () {

    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   PHASE 1: INITIAL STATE');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    const aliceBalanceOnA = await token.contract.balanceOf(aliceAddress, TOKEN_ID);
    const bobBalanceOnB = await tokenB.balanceOf(bobWallet.address, TOKEN_ID);

    LOGGER.log(`   Alice's balance (PL_A, ID ${TOKEN_ID}): ${aliceBalanceOnA}`);
    LOGGER.log(`   Bob's balance (PL_B, ID ${TOKEN_ID}): ${bobBalanceOnB}`);
    LOGGER.log(`   Teleport amount: ${TELEPORT_AMOUNT}`);

    expect(aliceBalanceOnA).to.be.gte(TELEPORT_AMOUNT, 'Alice should have enough tokens');
    expect(bobBalanceOnB).to.equal(0n, 'Bob should have 0 tokens at start');

    const aliceBalanceAfterSetup = aliceBalanceOnA;

    // NOTE: The atomic service has been integrated into the relayer.
    // We cannot stop relayer-b before teleportAtomic because it must deliver messages to PL_B.
    // Instead, we stop relayer-b AFTER tokens are locked on PL_B (see after Phase 4).
    // This prevents the SUM from being sent to Hub (or interrupts it if already in flight).

    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   PHASE 3: ALICE INITIATES ATOMIC TELEPORT');
    LOGGER.log('═══════════════════════════════════════════════════════════════');
    LOGGER.log(`   Alice → teleportAtomic(bob, id=${TOKEN_ID}, amount=${TELEPORT_AMOUNT}, chainB)`);

    await submitTx(
      () => token.contract.teleportAtomic(
        bobWallet.address,
        TOKEN_ID,
        TELEPORT_AMOUNT,
        privacyNodes.B.chainId,
        token.data(),
        { gasLimit: GAS_LIMIT }
      ),
      'teleportAtomic in progress...'
    );

    const aliceBalanceAfterAtomicBurn = await token.contract.balanceOf(aliceAddress, TOKEN_ID);
    LOGGER.log(`   Alice's tokens burned. Balance: ${aliceBalanceAfterAtomicBurn}`);

    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   PHASE 4: WAIT FOR TOKENS LOCKED ON PL_B');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    let lockedAmount = 0n;
    await eventually<boolean>({
      check: async () => {
        lockedAmount = await tokenB.getLockedAmount(bobWallet.address, TOKEN_ID);
        return lockedAmount > 0n;
      },
      message: 'Waiting for locked amount on PL_B...',
    });

    LOGGER.log(`   Tokens locked for Bob: ${lockedAmount}`);
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
    LOGGER.log(`   Bob calls unlock(bob, id=${TOKEN_ID}, amount=${TELEPORT_AMOUNT}, data) on PL_B`);

    const tokenBAsAttacker = await hre.ethers.getContractAt(
      'RaylsErc1155Example',
      await tokenB.getAddress(),
      bobWallet
    );

    let exploitSucceeded = false;
    try {
      const exploitTx = await tokenBAsAttacker.unlock(
        bobWallet.address,
        TOKEN_ID,
        TELEPORT_AMOUNT,
        token.data(),
        { gasLimit: GAS_LIMIT }
      );
      await exploitTx.wait();

      const bobBalanceAfterUnlock = await tokenB.balanceOf(bobWallet.address, TOKEN_ID);
      const lockedAfterUnlock = await tokenB.getLockedAmount(bobWallet.address, TOKEN_ID);

      LOGGER.log(`   EXPLOIT SUCCEEDED - unlock() has no access control`);
      LOGGER.log(`   Bob's balance after unlock: ${bobBalanceAfterUnlock}`);
      LOGGER.log(`   Bob's locked amount: ${lockedAfterUnlock}`);

      exploitSucceeded = true;

    } catch (error: any) {
      const errorMsg = error.message || '';
      LOGGER.log(`   EXPLOIT BLOCKED - Access control is present`);
      LOGGER.log(`   Transaction reverted (this is expected when fix is applied)`);
      if (errorMsg.includes('receive method') || errorMsg.includes('executor')) {
        LOGGER.log(`   Reason: receiveMethod modifier blocked unauthorized call`);
      }
    }

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

    let revertCompleted = false;
    let executeCompleted = false;

    {
      LOGGER.log('\n═══════════════════════════════════════════════════════════════');
      LOGGER.log('   PHASE 8: WAIT FOR ATOMIC FLOW TO COMPLETE');
      LOGGER.log('═══════════════════════════════════════════════════════════════');

      if (exploitSucceeded) {
        LOGGER.log(`   Exploit succeeded - waiting for Atomic-A to trigger revert...`);
        LOGGER.log(`   This will confirm the double-spend (Bob has tokens + Alice gets refund).`);
      } else {
        LOGGER.log(`   Exploit was BLOCKED - waiting for atomic flow to complete normally...`);
        LOGGER.log(`   The flow should either EXECUTE (Bob gets tokens) or REVERT (Alice gets refund).`);
      }

      const maxWaitForAtomicFlow = 180; // 3 minutes: 1m expiration + 1m poller interval + 1m buffer
      const startTime = Date.now();

      while ((Date.now() - startTime) / 1000 < maxWaitForAtomicFlow) {
        const aliceCurrentBalance = await token.contract.balanceOf(aliceAddress, TOKEN_ID);
        const bobLockedCurrent = await tokenB.getLockedAmount(bobWallet.address, TOKEN_ID);

        // Check if revert completed (Alice got tokens back)
        if (aliceCurrentBalance > aliceBalanceAfterAtomicBurn) {
          LOGGER.log(`   REVERT COMPLETED by Atomic-A service! (after ${Math.round((Date.now() - startTime) / 1000)}s)`);
          LOGGER.log(`   Alice's balance: ${aliceBalanceAfterAtomicBurn} → ${aliceCurrentBalance}`);
          revertCompleted = true;
          break;
        }

        // Check if execute completed (Bob's tokens no longer locked)
        if (!exploitSucceeded && bobLockedCurrent === 0n) {
          const bobBalance = await tokenB.balanceOf(bobWallet.address, TOKEN_ID);
          if (bobBalance >= TELEPORT_AMOUNT) {
            LOGGER.log(`   EXECUTE COMPLETED by Relayer-B service! (after ${Math.round((Date.now() - startTime) / 1000)}s)`);
            LOGGER.log(`   Bob's balance: ${bobBalance} (legitimate transfer)`);
            executeCompleted = true;
            break;
          }
        }

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        LOGGER.log(`   [${elapsed}s] Polling... Alice: ${aliceCurrentBalance}, Bob locked: ${bobLockedCurrent}`);
        await new Promise(resolve => setTimeout(resolve, 10000));
      }

      if (!revertCompleted && !executeCompleted) {
        LOGGER.log(`   WARNING: Atomic flow did not complete within ${maxWaitForAtomicFlow}s. Check COMMITCHAIN_EXPIRATIONREVERTTIMEINMINUTES=1m`);
      }
    }

    // PHASE 8.5: Wait for destination chain cleanup (revertTeleportBurn)
    // After revert completes on source chain, the atomic service should also
    // call revertTeleportBurn on the destination chain to burn orphaned tokens.
    if (revertCompleted) {
      LOGGER.log('\n═══════════════════════════════════════════════════════════════');
      LOGGER.log('   PHASE 8.5: WAIT FOR DESTINATION CHAIN CLEANUP');
      LOGGER.log('═══════════════════════════════════════════════════════════════');

      const tokenBAddress = await tokenB.getAddress();
      const balanceBefore = await tokenB.balanceOf(tokenBAddress, TOKEN_ID);
      const lockedBefore = await tokenB.getLockedAmount(bobWallet.address, TOKEN_ID);
      LOGGER.log(`   PL_B vault balance before cleanup: ${balanceBefore} tokens (ID ${TOKEN_ID})`);
      LOGGER.log(`   Bob locked before cleanup: ${lockedBefore} tokens`);
      LOGGER.log(`   Waiting 30s for revertTeleportBurn on PL_B...`);

      const cleanupWaitTime = 30; // seconds
      await new Promise(resolve => setTimeout(resolve, cleanupWaitTime * 1000));

      const balanceAfter = await tokenB.balanceOf(tokenBAddress, TOKEN_ID);
      const lockedAfter = await tokenB.getLockedAmount(bobWallet.address, TOKEN_ID);

      if (balanceAfter < balanceBefore) {
        LOGGER.log(`   ✅ DESTINATION CLEANUP COMPLETED!`);
        LOGGER.log(`   PL_B owner balance: ${balanceBefore} → ${balanceAfter} tokens`);
        LOGGER.log(`   Burned: ${balanceBefore - balanceAfter} tokens`);
      } else if (lockedAfter > 0n) {
        LOGGER.log(`   ⚠️ DESTINATION CLEANUP NOT EXECUTED`);
        LOGGER.log(`   PL_B owner balance unchanged: ${balanceAfter} tokens`);
        LOGGER.log(`   Bob still has ${lockedAfter} locked tokens (orphaned)`);
        LOGGER.log(`   NOTE: Relayer may not be calling revertTeleportBurn on destination chain.`);
      } else {
        LOGGER.log(`   ℹ️ No orphaned tokens to clean up on PL_B`);
      }
    }

    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   PHASE 9: VERIFY DOUBLE-SPEND');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    const aliceFinalBalance = await token.contract.balanceOf(aliceAddress, TOKEN_ID);
    const bobFinalBalance = await tokenB.balanceOf(bobWallet.address, TOKEN_ID);
    const bobLockedFinal = await tokenB.getLockedAmount(bobWallet.address, TOKEN_ID);

    LOGGER.log(`\n   FINAL STATE:`);
    LOGGER.log(`   ├─ Alice (PL_A, ID ${TOKEN_ID}): ${aliceFinalBalance} tokens`);
    LOGGER.log(`   ├─ Bob   (PL_B, ID ${TOKEN_ID}): ${bobFinalBalance} tokens`);
    LOGGER.log(`   └─ Bob locked (PL_B, ID ${TOKEN_ID}): ${bobLockedFinal} tokens`);

    // Check for stranded locked tokens (minted on PL_B but not burned after revert = inflation)
    const inflationDetected = !exploitSucceeded && bobLockedFinal > 0n && aliceFinalBalance >= aliceBalanceAfterSetup;
    if (inflationDetected) {
      LOGGER.log(`\n   ⚠️ INFLATION DETECTED: ${bobLockedFinal} tokens stranded on PL_B`);
      LOGGER.log(`      Cause: revertTeleportBurn not called or failed on destination chain`);
      LOGGER.log(`      These tokens inflate total supply - should have been burned.`);
      LOGGER.log(`      NOTE: This is a bug - destination cleanup should burn these tokens.`);
    }

    const bobHasTokens = bobFinalBalance >= TELEPORT_AMOUNT;
    const aliceWasRefunded = aliceFinalBalance >= aliceBalanceAfterSetup;
    const doubleSpendConfirmed = bobHasTokens && aliceWasRefunded;

    LOGGER.log(`\n   DOUBLE-SPEND CHECK:`);
    LOGGER.log(`   ├─ Bob has tokens (>= ${TELEPORT_AMOUNT}): ${bobHasTokens ? 'YES' : 'NO'} (has ${bobFinalBalance})`);
    LOGGER.log(`   ├─ Alice was refunded (>= ${aliceBalanceAfterSetup}): ${aliceWasRefunded ? 'YES' : 'NO'} (has ${aliceFinalBalance})`);
    LOGGER.log(`   └─ DOUBLE-SPEND: ${doubleSpendConfirmed ? '🚨️ CONFIRMED' : 'UNCONFIRMED'}`);

    if (doubleSpendConfirmed) {
      LOGGER.log(`\n   🚨️ DOUBLE-SPEND CONFIRMED`);
      LOGGER.log('   VULNERABLE: Double-spend exploit succeeded!');
      LOGGER.log(`   Bob received ${TELEPORT_AMOUNT} tokens via unauthorized unlock()`);
      LOGGER.log(`   Alice was refunded via revert`);
      LOGGER.log('   Test FAILS - fix the unlock() access control!');
    } else if (revertCompleted && !exploitSucceeded) {
      LOGGER.log(`\n   ✅ NORMAL REVERT COMPLETED`);
      LOGGER.log('   Exploit was blocked, and atomic flow reverted.');
      LOGGER.log(`   Alice was refunded (balance: ${aliceFinalBalance}).`);
    } else if (executeCompleted) {
      LOGGER.log(`\n   NORMAL EXECUTE COMPLETED`);
      LOGGER.log('   Exploit was blocked, and atomic flow executed normally.');
      LOGGER.log(`   Bob legitimately received ${TELEPORT_AMOUNT} tokens.`);
    } else if (exploitSucceeded && !revertCompleted) {
      LOGGER.log('   VULNERABLE: Exploit partially succeeded');
      LOGGER.log(`   Bob has tokens: ${bobHasTokens}, Alice refunded: ${aliceWasRefunded}`);
      LOGGER.log('   Test FAILS - unlock() lacks proper access control!');
    }

    // Supply conservation for the teleported amount. RaylsErc1155Example exposes no
    // totalSupply(id), so we reconcile the moved amount directly: every token Alice burned in
    // teleportAtomic must end up EITHER back with Alice (revert refund) OR on PL_B for Bob
    // (locked in the vault or unlocked). balance vs locked are mutually exclusive, so no double count.
    //   EXECUTE          → refund 0  + held 30 = 30 ✓
    //   REVERT (clean)   → refund 30 + held 0  = 30 ✓
    //   still locked     → refund 0  + held 30 = 30 ✓ (stuck but recoverable, not lost)
    //   partial revert   → refund 0  + held 0  = 0  ✗ TOKEN LOSS (the ATOMIC-B-OFFLINE-001 bug)
    //   double-spend     → refund 30 + held 30 = 60 ✗ INFLATION
    // Coerce to BigInt: the wrapper's .contract getter types these as number while the raw
    // typechain contract returns bigint; values are bigint at runtime (ethers v6) either way.
    const refundedToAlice = BigInt(aliceFinalBalance) - BigInt(aliceBalanceAfterAtomicBurn);
    const onBForBob = BigInt(bobFinalBalance) + BigInt(bobLockedFinal);
    const movedAmountAccountedFor = refundedToAlice + onBForBob;
    const supplyConserved = movedAmountAccountedFor === TELEPORT_AMOUNT;

    LOGGER.log(`\n   SUPPLY CONSERVATION (ID ${TOKEN_ID}):`);
    LOGGER.log(`   ├─ Refunded to Alice (PL_A): ${refundedToAlice}`);
    LOGGER.log(`   ├─ Held for Bob (PL_B, balance + locked): ${onBForBob}`);
    LOGGER.log(`   └─ Accounted: ${movedAmountAccountedFor} / ${TELEPORT_AMOUNT} → ${supplyConserved ? '✅ conserved' : '🚨️ MISMATCH'}`);

    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   SECURITY VERDICT');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    if (!exploitSucceeded) {
      LOGGER.log('   SECURE: unlock() access control is working correctly');
      LOGGER.log('   The exploit was blocked - no unauthorized token release occurred.');
      if (revertCompleted) {
        LOGGER.log('   Atomic flow completed via REVERT - Alice was refunded.');
      } else if (executeCompleted) {
        LOGGER.log('   Atomic flow completed via EXECUTE - Bob got tokens legitimately.');
      }
      LOGGER.log('   Test PASSES.');
    } else {
      LOGGER.log('   VULNERABLE: unlock() lacks proper access control!');
      LOGGER.log('   Add the receiveMethod modifier to unlock() to fix this vulnerability.');
      LOGGER.log('   Test FAILS.');
    }

    expect(!exploitSucceeded,
      `VULNERABILITY DETECTED: unlock() lacks access control! ` +
      `Bob was able to call unlock() directly and received ${bobFinalBalance} tokens. ` +
      `Add the 'receiveMethod' modifier to unlock() to fix this vulnerability.`
    ).to.be.true;

    // The test also FAILS if inflation was detected (stranded tokens on destination chain)
    expect(!inflationDetected,
      `INFLATION DETECTED: ${bobLockedFinal} tokens stranded on PL_B! ` +
      `revertTeleportBurn should burn these tokens to prevent supply inflation.`
    ).to.be.true;

    // The test also FAILS on ANY supply mismatch (bidirectional). The teleported amount must
    // end up with Alice (revert) or Bob (execute / still-locked). A shortfall is token LOSS
    // (partial revert / stuck flow — the ATOMIC-B-OFFLINE-001 bug); a surplus is double-spend
    // INFLATION. A merely-slow flow keeps the copy locked on PL_B and stays conserved, so it
    // does not trip this.
    expect(supplyConserved,
      `SUPPLY NOT CONSERVED: of ${TELEPORT_AMOUNT} tokens teleported, ${movedAmountAccountedFor} are accounted for ` +
      `(refunded to Alice: ${refundedToAlice}, held for Bob: ${onBForBob}). ` +
      (movedAmountAccountedFor < TELEPORT_AMOUNT
        ? `TOKEN LOSS — burned in teleportAtomic but never refunded (partial revert / stuck flow).`
        : `INFLATION — Bob credited and Alice refunded (double-spend).`)
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