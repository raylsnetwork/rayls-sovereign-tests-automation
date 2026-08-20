/**
 * E2E access-control checks for `DvpErc721PNH.mint`, `burn`, and
 * `UpdateInfosAfterDvpWithdraw`. Each test asserts that an unprivileged EOA
 * cannot drive PNH-side state on the deployed mirror contract.
 */

import { expect } from 'chai';
import { ethers } from 'ethers';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../src/config/env-config';
import { submitTx, retry } from '../../../src/utils/common';
import { isNonceError, isTransientRpcError } from '../../../src/exceptions-and-errors/block-chain-exceptions';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { ERC721Wrapper } from '../../../src/entities/tokens/ERC721Wrapper';
import {
  ProductionErc721Dvp,
  ProductionErc721Dvp__factory,
  DvpErc721PNH,
  DvpErc721PNH__factory,
} from '../../../typechain-types';
import { createUserOperator } from '../../../src/utils/wallet-factory';

describe('E2E SECURITY: DvpErc721PNH access-control @security @erc721 @dvp', function () {
  this.retries(0);
  this.timeout(DEFAULT_TIMEOUT);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let nftWrapper: ERC721Wrapper<ProductionErc721Dvp>;
  let dvpErc721Pnh: DvpErc721PNH;
  let attacker: ethers.HDNodeWallet;

  // Pre-minted in `before` so the burn test has an existing target —
  // distinguishes a real auth-block from `ERC721NonexistentToken`.
  const BURN_TARGET_TOKEN_ID = 0xBEEFn;

  before(async function () {
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    nftWrapper = new ERC721Wrapper<ProductionErc721Dvp>(privacyNodes.A, ProductionErc721Dvp__factory);
    nftWrapper.setFields('dvp721-ac');
    await nftWrapper.deploy();
    await nftWrapper.activateOnPn();
    await nftWrapper.activateOnHub(privateHub);

    const cached = privateHub.getPNHContract<DvpErc721PNH>(nftWrapper.symbol);
    const pnhTokenAddress = await cached.getAddress();
    dvpErc721Pnh = DvpErc721PNH__factory.connect(pnhTokenAddress, privateHub.provider);

    attacker = createUserOperator(privateHub.provider);

    // Fund the attacker to send transactions. Wrap in nonce-retry: the funding
    // tx follows prior admin writes on the shared wallet and can momentarily
    // read a stale `getTransactionCount(pending)` (esp. right after a chain
    // restart), which surfaces as NONCE_EXPIRED.
    await retry(
      async () => {
        const fundTx = await privateHub.adminWallet.sendTransaction({
          to: attacker.address,
          // 0.1 ETH covers the handful of (mostly reverting) attacker txs with margin; the wallet is
          // a throwaway per run, so keep the per-run drain on a long-lived env low (was 1 ETH).
          value: ethers.parseEther('0.1'),
        });
        await fundTx.wait();
      },
      {
        attempts: 5,
        delayMs: 500,
        retryIf: (err) => isNonceError(err) || isTransientRpcError(err),
        onRetry: (_err, i) => LOGGER.log(`[TX RETRY] funding attacker EOA attempt ${i}/5`),
      },
    );

    LOGGER.log(`   PrivacyNode A           : ${privacyNodes.A.chainId}`);
    LOGGER.log(`   PNH chainId             : ${(await privateHub.provider.getNetwork()).chainId}`);
    LOGGER.log(`   DvpErc721PNH address    : ${pnhTokenAddress}`);
    LOGGER.log(`   Attacker EOA            : ${attacker.address}`);

    // Admin holds the implicit ADMIN role, which the access manager bitmap
    // accepts on every selector — so admin can prepare burn-test state.
    const dvpAsAdmin = dvpErc721Pnh.connect(privateHub.adminWallet);
    await submitTx(
      () => dvpAsAdmin.mint(
        privateHub.adminWallet.address,
        BURN_TARGET_TOKEN_ID,
        1,
        [],
        { gasLimit: GAS_LIMIT },
      ),
      `PNH admin setup mint dvp721-ac (burn target 0x${BURN_TARGET_TOKEN_ID.toString(16)})`,
    );
  });

  it('rejects mint from an unauthorized caller', async function () {
    const dvpAsAttacker = dvpErc721Pnh.connect(attacker);

    let exploitSucceeded = false;
    try {
      const tx = await dvpAsAttacker.mint(attacker.address, 0xCAFE, 1, [], { gasLimit: GAS_LIMIT });
      await tx.wait();
      exploitSucceeded = true;
    } catch (error: any) {
      LOGGER.log(`   mint reverted — ${error?.shortMessage ?? error?.message ?? 'unknown'}`);
    }

    expect(exploitSucceeded, 'unauthorized mint must revert').to.equal(false);
  });

  it('rejects burn from an unauthorized caller', async function () {
    const dvpAsAttacker = dvpErc721Pnh.connect(attacker);

    const ownerBefore = await dvpErc721Pnh.ownerOf(BURN_TARGET_TOKEN_ID);
    expect(ownerBefore.toLowerCase()).to.equal(privateHub.adminWallet.address.toLowerCase());

    let exploitSucceeded = false;
    try {
      const tx = await dvpAsAttacker.burn(BURN_TARGET_TOKEN_ID, { gasLimit: GAS_LIMIT });
      await tx.wait();
      exploitSucceeded = true;
    } catch (error: any) {
      LOGGER.log(`   burn reverted — ${error?.shortMessage ?? error?.message ?? 'unknown'}`);
    }

    expect(exploitSucceeded, 'unauthorized burn must revert').to.equal(false);

    const ownerAfter = await dvpErc721Pnh.ownerOf(BURN_TARGET_TOKEN_ID);
    expect(ownerAfter.toLowerCase()).to.equal(privateHub.adminWallet.address.toLowerCase());
  });

  it('rejects UpdateInfosAfterDvpWithdraw from an unauthorized caller', async function () {
    const dvpAsAttacker = dvpErc721Pnh.connect(attacker);

    let exploitSucceeded = false;
    try {
      const tx = await dvpAsAttacker.UpdateInfosAfterDvpWithdraw(
        0xDEAD,
        1,
        [],
        attacker.address,
        { gasLimit: GAS_LIMIT },
      );
      await tx.wait();
      exploitSucceeded = true;
    } catch (error: any) {
      LOGGER.log(`   UpdateInfosAfterDvpWithdraw reverted — ${error?.shortMessage ?? error?.message ?? 'unknown'}`);
    }

    expect(exploitSucceeded, 'unauthorized UpdateInfosAfterDvpWithdraw must revert').to.equal(false);
  });
});
