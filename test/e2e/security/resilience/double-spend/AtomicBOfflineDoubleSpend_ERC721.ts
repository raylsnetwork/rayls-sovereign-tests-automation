/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
/**
 * @title E2E Security Test: Atomic-B Offline Double-Spend Exploit (ERC721)
 * @description Simulates a realistic scenario where atomic-b is stopped before the atomic flow,
 *              preventing SUM from being sent to Hub, testing for potential exploitation of unlock() for NFT duplication.
 *
 * EXPLOIT SCENARIO:
 * 1. Stop atomic-b BEFORE teleportAtomic (simulates atomic-b down, or Hub unreachable)
 * 2. Alice initiates teleportAtomic(bob, tokenId, chainB) on PL_A
 *    - Burns NFT on PL_A
 *    - Message registered on Hub with status=Pending
 * 3. Relayer_B delivers to PL_B, NFT minted and locked for Bob
 *    - Hub status remains PENDING (atomic-b cannot send SUM to Hub)
 * 4. Bob calls unlock() on PL_B
 *    - Succeeds due to missing access control on unlock()
 * 5. Wait for atomic service expiration timer (>1 minute)
 * 6. Restart atomic-b
 * 7. Atomic_A detects expired Pending message, calls revertAtomicMessageBatch()
 * 8. revertTeleportMint() called on PL_A, Alice gets NFT back
 * 9. If exploit succeeded: Bob has NFT + Alice has NFT = double-spend (NFT duplication)
 *
 * EXPECTED BEHAVIOR:
 * - Test PASSES when unlock() has proper access control (exploit blocked)
 * - Test FAILS when unlock() lacks access control (exploit succeeds = vulnerability exists)
 */

import hre from 'hardhat';
import { HDNodeWallet, Wallet } from 'ethers';
import { expect } from 'chai';
import { PrivateHub } from '../../../../../src/entities/PrivateHub';
import { ERC721Wrapper } from '../../../../../src/entities/tokens/ERC721Wrapper';
import { RaylsErc721Example, RaylsErc721Example__factory } from '../../../../../typechain-types';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../../../src/config/env-config';
import { compose } from '../../../../../src/utils/docker-compose';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../../setup';
import { createRandomWallet, delay, eventually, retry,submitTx } from '../../../../../src/utils/common';
import { shortHex } from '../../../../../src/utils/formatters';

const HUB_OFFLINE_DURATION_MS = 70_000; // 70s — must be > COMMITCHAIN_EXPIRATIONREVERTTIMEINMINUTES (1m)

describe('E2E SECURITY: Atomic-B Offline Double-Spend Exploit (ERC721) @serial @decommissioned', function () {
  this.timeout(DEFAULT_TIMEOUT*2); // 8 minutes - enough for setup + 3min polling
  const TOKEN_ID = 0n; // Token ID used in the exploit teleport
  const DEPLOY_TOKEN_ID = 100n; // Token ID used to deploy the contract on PL_B

  let privacyNodes: PrivacyNodeMap;
  let privateHub : PrivateHub;
  let nft : ERC721Wrapper<RaylsErc721Example>;
  let nftB : RaylsErc721Example;

  let aliceAddress: string;
  let bobWallet: HDNodeWallet | Wallet;

  before(async function () {
    const {initializedNodes, initializedPNH} = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    bobWallet = createRandomWallet(privacyNodes.B.provider);

    nft = new ERC721Wrapper(privacyNodes.A,RaylsErc721Example__factory)
    await nft.deploy();
    await nft.activateOnPn();
    await nft.activateOnHub(privateHub);
    aliceAddress = nft.userWallet.address;

    // Erc721Example constructor premints #0, #100, #150 to the deployer (userWallet = Alice):
    // #100 deploys the contract on PL_B, #0 (TOKEN_ID) drives the exploit. No explicit mint needed.
  });

  it('Should deploy NFT on PL_B via vanilla teleport', async function () {
    // Teleport token ID 100 (different from exploit token) to deploy on PL_B
    await submitTx(
      () => nft.contract.teleport(
        aliceAddress, // Teleport to Alice on PL_B
        100, // Use token ID 100 for deployment
        privacyNodes.B.chainId,
        { gasLimit: GAS_LIMIT }
      ),
      `Teleporting NFT #100 to Alice on PL_B to deploy contract...`
    );

    nftB = await privacyNodes.B.setContractByResourceId(RaylsErc721Example__factory.name, nft.resourceId, nft.symbol, nft.userWallet.connect(privacyNodes.B.provider))

    LOGGER.log(`NFT deployed on PL_B at: ${await nftB.getAddress()}`);

    await submitTx(
      () => nftB.teleport(
        aliceAddress,
        100,
        privacyNodes.A.chainId,
        { gasLimit: GAS_LIMIT }
      ),
      `Teleporting NFT #100 back to Alice on PL_A...`
    );

    // Wait for Alice to receive NFT back on PL_A — cross-chain delivery needs real polling
    await eventually<boolean>({
      check: async () => {
        const owner = await nft.contract.ownerOf(100);
        LOGGER.log('Waiting for Alice to receive NFT #100 on PL_A');
        return owner === aliceAddress;
      },
      interval: 1000,
      attempts: Math.floor(DEFAULT_TIMEOUT / 1000),
      message: `Waiting for Alice owns NFT #100 on PL_A (${shortHex(aliceAddress)})`,
      tolerateErrors: true,
    });

    LOGGER.log(`Alice now owns NFT #100 on PL_A`);
  }).timeout(DEFAULT_TIMEOUT);

  it('ATOMIC-B-OFFLINE-002: Full Atomic-B Offline Double-Spend Attack (ERC721)', async function () {
    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   PHASE 1: INITIAL STATE');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    // Verify Alice owns the token on PL_A
    const ownerOnA = await nft.contract.ownerOf(TOKEN_ID);
    const aliceBalanceOnA = await nft.contract.balanceOf(aliceAddress);
    const bobBalanceOnB = await nftB.balanceOf(bobWallet.address);

    LOGGER.log(`   Alice owns NFT #${TOKEN_ID} on PL_A: ${ownerOnA === aliceAddress}`);
    LOGGER.log(`   Alice's NFT balance on PL_A: ${aliceBalanceOnA}`);
    LOGGER.log(`   Bob's NFT balance on PL_B: ${bobBalanceOnB}`);

    expect(ownerOnA).to.equal(aliceAddress, 'Alice should own the token on PL_A');
    expect(bobBalanceOnB).to.equal(0n, 'Bob should have 0 NFTs at start');

    // NOTE: The atomic service has been integrated into the relayer.
    // We cannot stop relayer-b before teleportAtomic because it must deliver messages to PL_B.
    // Instead, we stop relayer-b AFTER NFT is locked on PL_B (see after Phase 4).
    // This prevents the SUM from being sent to Hub (or interrupts it if already in flight).

    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   PHASE 3: ALICE INITIATES ATOMIC TELEPORT')
    LOGGER.log('═══════════════════════════════════════════════════════════════');
    LOGGER.log(`   Alice → teleportAtomic(bob, tokenId=${TOKEN_ID}, chainB)`);

    await submitTx(
      () => nft.contract.teleportAtomic(
        bobWallet.address,
        TOKEN_ID,
        privacyNodes.B.chainId,
        { gasLimit: GAS_LIMIT }
      ),
      'teleportAtomic in progress...'
    );

    LOGGER.log(`   Alice's NFT burned on PL_A`);

    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   PHASE 4: WAIT FOR NFT LOCKED ON PL_B');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    const isLocked = await eventually<boolean>({
      check: async () => nftB.isTokenLocked(bobWallet.address, TOKEN_ID),
      interval: 2000,
      attempts: 15,
      message: `Waiting for NFT #${TOKEN_ID} locked for ${shortHex(bobWallet.address)}`,
      tolerateErrors: true,
    });

    LOGGER.log(`   NFT #${TOKEN_ID} locked for Bob: ${isLocked}`);
    LOGGER.log(`   Hub status: PENDING (will stop relayer-b now to prevent SUM)`);

    // Stop relayer-b NOW to prevent SUM from being sent to Hub.
    // The atomic service is integrated into the relayer, so stopping relayer-b
    // after NFT is locked simulates the old atomic-b being offline.
    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   PHASE 4.5: STOP RELAYER-B (after NFT locked)');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    compose.stop('relayer-b');
    LOGGER.log(`   relayer-b stopped AFTER NFT locked on PL_B.`);
    LOGGER.log(`   Hub status should remain PENDING (relayer-b can no longer send SUM).`);
    LOGGER.log(`   relayer-a's expired poller will trigger revert when transaction expires.`);

    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   PHASE 5: BOB TRIES TO EXPLOIT unlock()');
    LOGGER.log('═══════════════════════════════════════════════════════════════');
    LOGGER.log(`   Bob calls unlock(bob, tokenId=${TOKEN_ID}) on PL_B`);

    // Use a separate random attacker wallet (not admin) to prove ANY unauthorized
    // caller can trigger unlock — the attacker doesn't need to be the recipient
    const attackerWallet = Wallet.createRandom().connect(privacyNodes.B.provider);
    const nftBAsAttacker = await hre.ethers.getContractAt(
      'RaylsErc721Example',
      await nftB.getAddress(),
      attackerWallet
    );

    let exploitSucceeded = false;
    try {
      const exploitTx = await nftBAsAttacker.unlock(bobWallet.address, TOKEN_ID, { gasLimit: GAS_LIMIT });
      await exploitTx.wait();

      const bobOwnsToken = await nftB.ownerOf(TOKEN_ID) === bobWallet.address;
      const isStillLocked = await nftB.isTokenLocked(bobWallet.address, TOKEN_ID);

      LOGGER.log(`   EXPLOIT SUCCEEDED - unlock() has no access control`);
      LOGGER.log(`   Bob now owns NFT #${TOKEN_ID}: ${bobOwnsToken}`);
      LOGGER.log(`   Token still locked: ${isStillLocked}`);

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

    // Wait for transaction to expire (COMMITCHAIN_EXPIRATIONREVERTTIMEINMINUTES=1m)
    // This ensures atomic-a's expired poller will find the transaction
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
        LOGGER.log(`   This will confirm the double-spend (Bob has NFT + Alice gets NFT back).`);
      } else {
        LOGGER.log(`   Exploit was BLOCKED - waiting for atomic flow to complete normally...`);
        LOGGER.log(`   The flow should either EXECUTE (Bob gets NFT) or REVERT (Alice gets NFT back).`);
      }

      // NOTE: By stopping atomic-b BEFORE teleportAtomic:
      // - atomic-b was never running during the atomic flow
      // - Hub status is PERMANENTLY PENDING (no SUM was ever sent)
      // - When atomic-b restarts, the transaction is already expired
      // - atomic-a's expired poller queries Hub -> sees PENDING -> triggers revert
      // - Revert payload (revertTeleportMint) executes on PL_A -> Alice gets NFT back
      // - If exploit succeeded: DOUBLE-SPEND (Bob has NFT via exploit + Alice has NFT via revert)
      //
      // NO RACE CONDITION: Hub status was never updated to EXECUTED, so revert is guaranteed.
      const maxWaitForAtomicFlow = 180; // 3 minutes: 1m expiration + 1m poller interval + 1m buffer
      const startTime = Date.now();

      while ((Date.now() - startTime) / 1000 < maxWaitForAtomicFlow) {
        try {
          // Check if Alice got the NFT back (revert completed)
          const ownerOnA = await nft.contract.ownerOf(TOKEN_ID);
          if (ownerOnA === aliceAddress) {
            LOGGER.log(`   REVERT COMPLETED by Atomic-A service! (after ${Math.round((Date.now() - startTime) / 1000)}s)`);
            LOGGER.log(`   Alice owns NFT #${TOKEN_ID} on PL_A again`);
            revertCompleted = true;
            break;
          }
        } catch {
          // Token might not exist on PL_A yet (still waiting for revert)
        }

        // Check if execute completed (token no longer locked on PL_B)
        if (!exploitSucceeded) {
          try {
            const isStillLocked = await nftB.isTokenLocked(bobWallet.address, TOKEN_ID);
            if (!isStillLocked) {
              const ownerOnB = await nftB.ownerOf(TOKEN_ID);
              if (ownerOnB === bobWallet.address) {
                LOGGER.log(`   EXECUTE COMPLETED by Atomic-B service! (after ${Math.round((Date.now() - startTime) / 1000)}s)`);
                LOGGER.log(`   Bob now owns NFT #${TOKEN_ID} on PL_B (legitimate transfer)`);
                executeCompleted = true;
                break;
              }
            }
          } catch {
            // Token might not exist yet
          }
        }

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        LOGGER.log(`   [${elapsed}s] Polling... waiting for atomic flow to complete`);
        await new Promise(resolve => setTimeout(resolve, 10000));
      }

      if (!revertCompleted && !executeCompleted) {
        LOGGER.log(`   WARNING: Atomic flow did not complete within ${maxWaitForAtomicFlow}s. Check COMMITCHAIN_EXPIRATIONREVERTTIMEINMINUTES=1m`);
      }
    }

    // PHASE 8.5: Wait for destination chain cleanup (revertTeleportBurn)
    // After revert completes on source chain, the atomic service should also
    // call revertTeleportBurn on the destination chain to burn orphaned NFT.
    if (revertCompleted) {
      LOGGER.log('\n═══════════════════════════════════════════════════════════════');
      LOGGER.log('   PHASE 8.5: WAIT FOR DESTINATION CHAIN CLEANUP');
      LOGGER.log('═══════════════════════════════════════════════════════════════');

      let nftExistsBefore: boolean;
      try {
        await nftB.ownerOf(TOKEN_ID);
        nftExistsBefore = true;
      } catch {
        nftExistsBefore = false;
      }

      LOGGER.log(`   NFT #${TOKEN_ID} exists on PL_B before cleanup: ${nftExistsBefore}`);
      LOGGER.log(`   Waiting 30s for revertTeleportBurn on PL_B...`);

      const cleanupWaitTime = 30; // seconds
      await new Promise(resolve => setTimeout(resolve, cleanupWaitTime * 1000));

      let nftExistsAfter: boolean;
      let nftLockedAfterCleanup = false;
      try {
        await nftB.ownerOf(TOKEN_ID);
        nftExistsAfter = true;
        nftLockedAfterCleanup = await nftB.isTokenLocked(bobWallet.address, TOKEN_ID);
      } catch {
        nftExistsAfter = false;
      }

      if (nftExistsBefore && !nftExistsAfter) {
        LOGGER.log(`   ✅ DESTINATION CLEANUP COMPLETED!`);
        LOGGER.log(`   NFT #${TOKEN_ID} was burned on PL_B`);
      } else if (nftExistsAfter && nftLockedAfterCleanup) {
        LOGGER.log(`   ⚠️ DESTINATION CLEANUP NOT EXECUTED`);
        LOGGER.log(`   NFT #${TOKEN_ID} still exists on PL_B (locked: ${nftLockedAfterCleanup})`);
        LOGGER.log(`   NOTE: Relayer may not be calling revertTeleportBurn on destination chain.`);
      } else if (!nftExistsBefore) {
        LOGGER.log(`   ℹ️ No orphaned NFT to clean up on PL_B`);
      }
    }

    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   PHASE 9: VERIFY FINAL STATE');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    let aliceHasToken: boolean;
    let bobHasToken: boolean;
    let nftLockedOnB: boolean;

    try {
      const ownerOnA = await nft.contract.ownerOf(TOKEN_ID);
      aliceHasToken = ownerOnA === aliceAddress;
    } catch {
      aliceHasToken = false;
    }

    try {
      const ownerOnB = await nftB.ownerOf(TOKEN_ID);
      bobHasToken = ownerOnB === bobWallet.address;
    } catch {
      bobHasToken = false;
    }

    try {
      nftLockedOnB = await nftB.isTokenLocked(bobWallet.address, TOKEN_ID);
    } catch {
      nftLockedOnB = false;
    }

    const aliceFinalBalance = await nft.contract.balanceOf(aliceAddress);
    const bobFinalBalance = await nftB.balanceOf(bobWallet.address);

    LOGGER.log(`\n   FINAL STATE:`);
    LOGGER.log(`   ├─ Alice owns NFT #${TOKEN_ID} on PL_A: ${aliceHasToken}`);
    LOGGER.log(`   ├─ Bob owns NFT #${TOKEN_ID} on PL_B: ${bobHasToken}`);
    LOGGER.log(`   ├─ NFT #${TOKEN_ID} locked on PL_B: ${nftLockedOnB}`);
    LOGGER.log(`   ├─ Alice's total NFT balance (PL_A): ${aliceFinalBalance}`);
    LOGGER.log(`   └─ Bob's total NFT balance (PL_B): ${bobFinalBalance}`);

    // Check for stranded locked NFT (minted on PL_B but not burned after revert = inflation)
    const inflationDetected = !exploitSucceeded && nftLockedOnB && aliceHasToken;
    if (inflationDetected) {
      LOGGER.log(`\n   ⚠️ INFLATION DETECTED: NFT #${TOKEN_ID} is stranded on PL_B`);
      LOGGER.log(`      Cause: revertTeleportBurn not called or failed on destination chain`);
      LOGGER.log(`      This NFT inflates supply - Alice has original + copy exists on PL_B.`);
      LOGGER.log(`      NOTE: This is a bug - destination cleanup should burn this NFT.`);
    }

    const doubleSpendConfirmed = bobHasToken && aliceHasToken;
    // Real theft requires the unauthorized unlock() to have succeeded. "Bob has it, Alice
    // doesn't" on its own is ALSO the correct end-state of a successful atomic teleport
    // (Alice voluntarily sent the NFT to Bob and the flow EXECUTED), so it must be gated on
    // exploitSucceeded to avoid a false-positive THEFT label on the legitimate transfer.
    const theftConfirmed = bobHasToken && !aliceHasToken && exploitSucceeded;

    LOGGER.log(`\n   EXPLOIT CHECK:`);
    LOGGER.log(`   ├─ Bob has NFT #${TOKEN_ID}: ${bobHasToken ? 'YES' : 'NO'}`);
    LOGGER.log(`   ├─ Alice has NFT #${TOKEN_ID}: ${aliceHasToken ? 'YES' : 'NO'}`);
    if (doubleSpendConfirmed) {
      LOGGER.log(`   └─ RESULT: 🚨️ DOUBLE-SPEND (NFT duplicated on both chains)`);
    } else if (theftConfirmed) {
      LOGGER.log(`   └─ RESULT: 🚨️ THEFT (Bob stole Alice's NFT via unauthorized unlock())`);
    } else if (executeCompleted) {
      LOGGER.log(`   └─ RESULT: ✅ No exploit (atomic teleport executed legitimately — Bob received NFT as Alice intended)`);
    } else {
      LOGGER.log(`   └─ RESULT: ✅ No exploit (flow completed normally)`);
    }

    if (doubleSpendConfirmed) {
      LOGGER.log(`\n   🚨️ DOUBLE-SPEND CONFIRMED`);
      LOGGER.log('   VULNERABLE: Double-spend exploit succeeded!');
      LOGGER.log(`   Bob received NFT #${TOKEN_ID} via unauthorized unlock()`);
      LOGGER.log(`   Alice received NFT #${TOKEN_ID} back via revert`);
      LOGGER.log('   Net effect: NFT was DUPLICATED (exists on both chains)');
    } else if (theftConfirmed && exploitSucceeded) {
      LOGGER.log(`\n   NFT THEFT CONFIRMED`);
      LOGGER.log('   VULNERABLE: NFT theft exploit succeeded!');
      LOGGER.log(`   Bob stole NFT #${TOKEN_ID} via unauthorized unlock()`);
      LOGGER.log(`   Alice LOST NFT #${TOKEN_ID} permanently (no revert occurred)`);
      LOGGER.log('   Reason: unlock() clears locked state, so atomic service saw "executed"');
      LOGGER.log('   Net effect: Alice\'s NFT was STOLEN by Bob');
    } else if (revertCompleted && !exploitSucceeded) {
      LOGGER.log(`\n   ✅ NORMAL REVERT COMPLETED`);
      LOGGER.log('   Exploit was blocked, and atomic flow reverted.');
      LOGGER.log(`   Alice received NFT #${TOKEN_ID} back.`);
    } else if (executeCompleted) {
      LOGGER.log(`\n   NORMAL EXECUTE COMPLETED`);
      LOGGER.log('   Exploit was blocked, and atomic flow executed normally.');
      LOGGER.log(`   Bob legitimately received NFT #${TOKEN_ID}.`);
    }

    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   SECURITY VERDICT');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    if (!exploitSucceeded) {
      LOGGER.log('   SECURE: unlock() access control is working correctly');
      LOGGER.log('   The exploit was blocked - no unauthorized NFT release occurred.');
      if (revertCompleted) {
        LOGGER.log('   Atomic flow completed via REVERT - Alice got NFT back.');
      } else if (executeCompleted) {
        LOGGER.log('   Atomic flow completed via EXECUTE - Bob got NFT legitimately.');
      }
      LOGGER.log('   Test PASSES.');
    } else {
      LOGGER.log('   VULNERABLE: unlock() lacks proper access control!');
      LOGGER.log('   Add the receiveMethod modifier to unlock() to fix this vulnerability.');
      LOGGER.log('   Test FAILS.');
    }

    expect(!exploitSucceeded,
      `VULNERABILITY DETECTED: unlock() lacks access control! ` +
      `Bob was able to call unlock() directly and received NFT #${TOKEN_ID}. ` +
      `Add the 'receiveMethod' modifier to unlock() to fix this vulnerability.`
    ).to.be.true;

    // The test also FAILS if inflation was detected (stranded NFT on destination chain)
    expect(!inflationDetected,
      `INFLATION DETECTED: NFT #${TOKEN_ID} is stranded on PL_B! ` +
      `revertTeleportBurn should burn this NFT to prevent supply inflation.`
    ).to.be.true;

    // The test also FAILS on duplication: the NFT must never exist on both chains at once.
    // Covers the path where the copy ends up UNLOCKED on PL_B and slips past inflationDetected.
    expect(!doubleSpendConfirmed,
      `DOUBLE-SPEND DETECTED: NFT #${TOKEN_ID} exists on BOTH chains! ` +
      `Alice owns it on PL_A and Bob owns it on PL_B — the atomic teleport duplicated the token.`
    ).to.be.true;

    // Supply conservation (the OTHER direction): the NFT must exist in EXACTLY one place.
    // doubleSpendConfirmed catches duplication; this catches token LOSS — a partial revert
    // that burns the NFT on both chains and never refunds Alice, leaving it owned by no one
    // and not locked. A "flow did not complete" warning with this state is a real failure,
    // not a benign timeout. (A still-locked NFT counts as existing — stuck but recoverable.)
    const tokenExistsSomewhere = aliceHasToken || bobHasToken || nftLockedOnB;
    expect(tokenExistsSomewhere,
      `TOKEN LOSS DETECTED: NFT #${TOKEN_ID} no longer exists on either chain! ` +
      `Alice doesn't own it (PL_A), Bob doesn't own it (PL_B), and it is not locked on PL_B. ` +
      `A correct atomic teleport must leave the NFT in exactly one place (revert → Alice, or execute → Bob).`
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