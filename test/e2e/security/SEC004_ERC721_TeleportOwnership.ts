/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
/**
 * @title E2E SECURITY: SEC-004 ERC721 teleport() Ownership Vulnerability
 * @description Tests that teleport() and teleportAtomic() enforce ownership checks.
 *
 * VULNERABILITY (before fix):
 *   teleport() and teleportAtomic() call _burn(id) without checking msg.sender == ownerOf(id).
 *   OZ ERC721._burn(uint256) passes auth=address(0), skipping the ownership check.
 *   Any address can burn and teleport any ERC721 token they do not own.
 *
 * EXPLOIT SCENARIO:
 *   1. Victim owns NFT #1 on Privacy Ledger A
 *   2. Attacker (no relationship to the token) calls token.teleport(attackerAddress, 1, chainB)
 *   3. Without the fix: token is burned on chain A, minted to attacker on chain B
 *   4. Victim loses their NFT, attacker gains it on another chain
 *
 * TEST BEHAVIOR:
 *   - PASSES: teleport() reverts when called by non-owner (fix is in place)
 *   - FAILS: teleport() succeeds for non-owner (vulnerability exists)
 */
import { expect } from 'chai';
import { HDNodeWallet } from 'ethers';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER, SECOND } from '../../../src/config/env-config';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { ERC721Wrapper } from '../../../src/entities/tokens/ERC721Wrapper';
import { ProductionErc721Token, ProductionErc721Token__factory } from '../../../typechain-types';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { createUserOperator } from '../../../src/utils/wallet-factory';
import { eventually } from '../../../src/utils/common';
import { shortHex } from '../../../src/utils/formatters';

describe('E2E SECURITY: SEC-004 ERC721 Teleport Ownership @security @erc721 @decommissioned', function () {
  this.retries(0);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let nft: ERC721Wrapper<ProductionErc721Token>;

  let ownerAddress: string;
  let attackerWallet: HDNodeWallet;
  const TOKEN_ID = 1n;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    // Deploy ERC721 on Privacy Ledger A
    nft = new ERC721Wrapper<ProductionErc721Token>(privacyNodes.A, ProductionErc721Token__factory);
    nft.setFields('sec004-teleport');
    await nft.deploy();
    await nft.activateOnPn();
    await nft.activateOnHub(privateHub);

    ownerAddress = nft.userWallet.address;

    // Mint NFT to the owner
    await nft.mintAndAwait(privateHub, {
      toAddress: ownerAddress,
      tokenId: TOKEN_ID,
    });

    // Create attacker wallet (different address, no relationship to the token)
    attackerWallet = createUserOperator(privacyNodes.A.provider);
  });

  it('EXPLOIT: Non-owner calls teleport() to steal NFT cross-chain', async function () {
    const tokenAddressOnA = nft.address[privacyNodes.A.chainId];

    LOGGER.log('\n   ═══════════════════════════════════════════════════');
    LOGGER.log('   SEC-004: ERC721 teleport() Ownership Exploit');
    LOGGER.log('   ═══════════════════════════════════════════════════');
    LOGGER.log(`   Victim (owner):  ${ownerAddress}`);
    LOGGER.log(`   Attacker:        ${attackerWallet.address}`);
    LOGGER.log(`   Token on A:      ${tokenAddressOnA}`);
    LOGGER.log(`   Target chain:    ${privacyNodes.B.chainId}`);
    LOGGER.log(`   Token ID:        ${TOKEN_ID}`);

    // ── PHASE 1: Verify initial state on chain A ──
    LOGGER.log('\n   --- BEFORE EXPLOIT ---');
    const initialOwnerOnA = await nft.contract.ownerOf(TOKEN_ID);
    const victimBalanceOnA = await nft.contract.balanceOf(ownerAddress);
    const attackerBalanceOnA = await nft.contract.balanceOf(attackerWallet.address);
    LOGGER.log(`   Chain A — NFT #${TOKEN_ID} owner:   ${initialOwnerOnA}`);
    LOGGER.log(`   Chain A — Victim balance:            ${victimBalanceOnA}`);
    LOGGER.log(`   Chain A — Attacker balance:          ${attackerBalanceOnA}`);
    expect(initialOwnerOnA.toLowerCase()).to.equal(ownerAddress.toLowerCase());

    // ── PHASE 2: Attacker calls teleport() ──
    LOGGER.log('\n   --- EXPLOIT ATTEMPT ---');
    LOGGER.log(`   Attacker calls: teleport(${attackerWallet.address}, ${TOKEN_ID}, ${privacyNodes.B.chainId})`);

    const nftAsAttacker = nft.contract.connect(attackerWallet) as typeof nft.contract;

    let exploitSucceeded = false;
    try {
      const tx = await nftAsAttacker.teleport(
        attackerWallet.address,
        TOKEN_ID,
        privacyNodes.B.chainId,
        { gasLimit: GAS_LIMIT },
      );
      await tx.wait();
      exploitSucceeded = true;
      LOGGER.log('   TX SUCCEEDED — attacker burned victim\'s NFT without authorization');
    } catch (error: any) {
      const reason = error.message?.includes('NotTokenOwner')
        ? 'ownership check'
        : error.message?.includes('TokenAlreadyLocked')
          ? 'lock check'
          : 'unknown';
      LOGGER.log(`   TX REVERTED — blocked by ${reason}`);
    }

    // ── PHASE 3: Inspect chain A after exploit ──
    LOGGER.log('\n   --- AFTER EXPLOIT (Chain A) ---');
    let tokenExistsOnA = true;
    let finalOwnerOnA = '';
    try {
      finalOwnerOnA = await nft.contract.ownerOf(TOKEN_ID);
    } catch {
      tokenExistsOnA = false;
    }
    const victimBalanceAfterA = await nft.contract.balanceOf(ownerAddress);
    const attackerBalanceAfterA = await nft.contract.balanceOf(attackerWallet.address);

    LOGGER.log(`   Chain A — Token exists:              ${tokenExistsOnA}`);
    LOGGER.log(`   Chain A — NFT #${TOKEN_ID} owner:   ${tokenExistsOnA ? finalOwnerOnA : 'BURNED (destroyed)'}`);
    LOGGER.log(`   Chain A — Victim balance:            ${victimBalanceAfterA} (was ${victimBalanceOnA})`);
    LOGGER.log(`   Chain A — Attacker balance:          ${attackerBalanceAfterA} (was ${attackerBalanceOnA})`);

    // ── PHASE 4: If exploit succeeded, check chain B for stolen token ──
    if (exploitSucceeded) {
      LOGGER.log('\n   --- CROSS-CHAIN IMPACT (Chain B) ---');
      LOGGER.log('   Waiting for relayer to deliver stolen NFT to chain B...');

      let tokenOnB: typeof nft;
      try {
        tokenOnB = await nft.forNode(privacyNodes.B, true);
        const tokenAddressOnB = tokenOnB.address[privacyNodes.B.chainId];
        LOGGER.log(`   Chain B — Token address:             ${tokenAddressOnB}`);

        // Poll for the attacker to receive the token on chain B.
        // Lenient on purpose: an exhaustion still counts as "PARTIAL THEFT", not a test failure.
        let attackerReceivedOnB = false;
        try {
          attackerReceivedOnB = await eventually<boolean>({
            check: async () => {
              const ownerOnB = await tokenOnB.contract.ownerOf(TOKEN_ID);
              return ownerOnB.toLowerCase() === attackerWallet.address.toLowerCase();
            },
            interval: 3 * SECOND,
            attempts: 20,
            message: `Waiting for [SEC004] attacker ${shortHex(attackerWallet.address)} owns NFT #${TOKEN_ID} on B`,
            tolerateErrors: true,
          });
        } catch {
          attackerReceivedOnB = false;
        }

        if (attackerReceivedOnB) {
          const ownerOnB = await tokenOnB.contract.ownerOf(TOKEN_ID);
          const attackerBalanceOnB = await tokenOnB.contract.balanceOf(attackerWallet.address);
          const victimBalanceOnB = await tokenOnB.contract.balanceOf(ownerAddress);
          LOGGER.log(`   Chain B — NFT #${TOKEN_ID} owner:   ${ownerOnB}`);
          LOGGER.log(`   Chain B — Attacker balance:          ${attackerBalanceOnB}`);
          LOGGER.log(`   Chain B — Victim balance:            ${victimBalanceOnB}`);
          LOGGER.log('   FULL THEFT CONFIRMED: token materialized under attacker on chain B');
        } else {
          LOGGER.log('   Token not yet on chain B (relayer may be slow), but burned on A');
          LOGGER.log('   PARTIAL THEFT: victim lost NFT on A regardless of B delivery');
        }
      } catch {
        LOGGER.log('   Could not resolve token on chain B (contract not yet deployed)');
        LOGGER.log('   PARTIAL THEFT: victim lost NFT on A regardless of B delivery');
      }
    }

    // ── VERDICT ──
    LOGGER.log('\n   ═══════════════════════════════════════════════════');
    if (exploitSucceeded) {
      LOGGER.log('   VERDICT: VULNERABLE');
      LOGGER.log('   Attacker (non-owner) burned victim\'s NFT via teleport()');
      LOGGER.log('   Impact: victim lost NFT on chain A, attacker receives it on chain B');
      LOGGER.log('   Fix: add require(_ownerOf(id) == msg.sender) to teleport()');
    } else {
      LOGGER.log('   VERDICT: SECURE');
      LOGGER.log('   teleport() correctly rejected non-owner call');
      LOGGER.log('   Victim\'s NFT remains safe on chain A');
    }
    LOGGER.log('   ═══════════════════════════════════════════════════');

    expect(exploitSucceeded,
      'VULNERABILITY: teleport() allows non-owner to burn and teleport NFT. ' +
      'Fix: add require(_ownerOf(id) == msg.sender) to teleport().',
    ).to.be.false;

    expect(tokenExistsOnA,
      'NFT should still exist on chain A after blocked exploit',
    ).to.be.true;

    expect(finalOwnerOnA.toLowerCase()).to.equal(
      ownerAddress.toLowerCase(),
      'Original owner should still own the NFT on chain A',
    );
  }).timeout(DEFAULT_TIMEOUT);

  it('EXPLOIT: Non-owner calls teleportAtomic() to steal NFT', async function () {
    LOGGER.log('\n   ═══════════════════════════════════════════════════');
    LOGGER.log('   SEC-004: ERC721 teleportAtomic() Ownership Exploit');
    LOGGER.log('   ═══════════════════════════════════════════════════');

    // Verify token still belongs to victim (from previous test)
    const ownerBefore = await nft.contract.ownerOf(TOKEN_ID);
    LOGGER.log(`   Chain A — NFT #${TOKEN_ID} owner before: ${ownerBefore}`);
    expect(ownerBefore.toLowerCase()).to.equal(ownerAddress.toLowerCase());

    const nftAsAttacker = nft.contract.connect(attackerWallet) as typeof nft.contract;

    let exploitSucceeded = false;
    try {
      const tx = await nftAsAttacker.teleportAtomic(
        attackerWallet.address,
        TOKEN_ID,
        privacyNodes.B.chainId,
        { gasLimit: GAS_LIMIT },
      );
      await tx.wait();
      exploitSucceeded = true;
      LOGGER.log('   TX SUCCEEDED — attacker burned victim\'s NFT via teleportAtomic()');
    } catch {
      LOGGER.log('   TX REVERTED — teleportAtomic() blocked non-owner');
    }

    let tokenExists = true;
    let finalOwner = '';
    try {
      finalOwner = await nft.contract.ownerOf(TOKEN_ID);
    } catch {
      tokenExists = false;
    }
    LOGGER.log(`   Chain A — Token exists after:         ${tokenExists}`);
    LOGGER.log(`   Chain A — NFT #${TOKEN_ID} owner after:  ${tokenExists ? finalOwner : 'BURNED'}`);
    LOGGER.log(`   VERDICT: ${exploitSucceeded ? 'VULNERABLE' : 'SECURE'}`);

    expect(exploitSucceeded,
      'VULNERABILITY: teleportAtomic() allows non-owner to burn and teleport NFT.',
    ).to.be.false;

    expect(finalOwner.toLowerCase()).to.equal(
      ownerAddress.toLowerCase(),
      'Original owner should still own the NFT',
    );
  }).timeout(DEFAULT_TIMEOUT);

  it('EXPLOIT: Approved spender cannot use teleport() to steal NFT', async function () {
    LOGGER.log('\n   ═══════════════════════════════════════════════════');
    LOGGER.log('   SEC-004: Approved Spender teleport() Exploit');
    LOGGER.log('   ═══════════════════════════════════════════════════');

    // Owner approves attacker for the token
    await (await nft.contract.approve(attackerWallet.address, TOKEN_ID)).wait();
    const approved = await nft.contract.getApproved(TOKEN_ID);
    LOGGER.log(`   Owner approved attacker: ${approved}`);
    LOGGER.log(`   Note: ERC721 approval grants transferFrom rights, NOT teleport rights`);

    const nftAsAttacker = nft.contract.connect(attackerWallet) as typeof nft.contract;

    let exploitSucceeded = false;
    try {
      const tx = await nftAsAttacker.teleport(
        attackerWallet.address,
        TOKEN_ID,
        privacyNodes.B.chainId,
        { gasLimit: GAS_LIMIT },
      );
      await tx.wait();
      exploitSucceeded = true;
      LOGGER.log('   TX SUCCEEDED — approved spender teleported NFT');
    } catch {
      LOGGER.log('   TX REVERTED — approval does not grant teleport rights');
    }

    const finalOwner = await nft.contract.ownerOf(TOKEN_ID);
    LOGGER.log(`   Chain A — NFT #${TOKEN_ID} owner after: ${finalOwner}`);
    LOGGER.log(`   VERDICT: ${exploitSucceeded ? 'VULNERABLE' : 'SECURE'}`);

    expect(exploitSucceeded,
      'Approved spenders should NOT be able to teleport — teleport is not a transfer.',
    ).to.be.false;

    expect(finalOwner.toLowerCase()).to.equal(
      ownerAddress.toLowerCase(),
    );
  }).timeout(DEFAULT_TIMEOUT);
});
