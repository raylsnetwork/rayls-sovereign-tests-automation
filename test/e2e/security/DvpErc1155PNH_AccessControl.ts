/**
 * E2E access-control checks for `DvpErc1155PNH.mint`, `burn`, and
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
import { ERC1155Wrapper } from '../../../src/entities/tokens/ERC1155Wrapper';
import {
  ProductionErc1155Dvp,
  ProductionErc1155Dvp__factory,
  DvpErc1155PNH,
  DvpErc1155PNH__factory,
} from '../../../typechain-types';
import { createUserOperator } from '../../../src/utils/wallet-factory';

describe('E2E SECURITY: DvpErc1155PNH access-control @security @erc1155 @dvp', function () {
  this.retries(0);
  this.timeout(DEFAULT_TIMEOUT);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let nftWrapper: ERC1155Wrapper<ProductionErc1155Dvp>;
  let dvpErc1155Pnh: DvpErc1155PNH;
  let attacker: ethers.HDNodeWallet;

  // Pre-minted in `before` so the burn test has an existing balance —
  // distinguishes a real auth-block from `ERC1155InsufficientBalance`.
  const BURN_TARGET_TOKEN_ID = 0xBEEFn;
  const BURN_TARGET_AMOUNT   = 1000n;

  before(async function () {
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    nftWrapper = new ERC1155Wrapper<ProductionErc1155Dvp>(privacyNodes.A, ProductionErc1155Dvp__factory);
    nftWrapper.setFields('dvp1155-ac');
    await nftWrapper.deploy();
    await nftWrapper.activateOnPn();
    await nftWrapper.activateOnHub(privateHub);

    const cached = privateHub.getPNHContract<DvpErc1155PNH>(nftWrapper.symbol);
    const pnhTokenAddress = await cached.getAddress();
    dvpErc1155Pnh = DvpErc1155PNH__factory.connect(pnhTokenAddress, privateHub.provider);

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
    LOGGER.log(`   DvpErc1155PNH address   : ${pnhTokenAddress}`);
    LOGGER.log(`   Attacker EOA            : ${attacker.address}`);

    // Admin holds the implicit ADMIN role, which the access manager bitmap
    // accepts on every selector — so admin can prepare burn-test state.
    const dvpAsAdmin = dvpErc1155Pnh.connect(privateHub.adminWallet);
    await submitTx(
      () => dvpAsAdmin.mint(
        privateHub.adminWallet.address,
        BURN_TARGET_TOKEN_ID,
        BURN_TARGET_AMOUNT,
        '0x',
        1,
        [],
        { gasLimit: GAS_LIMIT },
      ),
      `PNH admin setup mint dvp1155-ac (burn target 0x${BURN_TARGET_TOKEN_ID.toString(16)})`,
    );
  });

  it('rejects mint from an unauthorized caller', async function () {
    const dvpAsAttacker = dvpErc1155Pnh.connect(attacker);

    let exploitSucceeded = false;
    try {
      const tx = await dvpAsAttacker.mint(attacker.address, 0xCAFE, 1_000_000, '0x', 1, [], { gasLimit: GAS_LIMIT });
      await tx.wait();
      exploitSucceeded = true;
    } catch (error: any) {
      LOGGER.log(`   mint reverted — ${error?.shortMessage ?? error?.message ?? 'unknown'}`);
    }

    expect(exploitSucceeded, 'unauthorized mint must revert').to.equal(false);
  });

  it('rejects burn from an unauthorized caller', async function () {
    const dvpAsAttacker = dvpErc1155Pnh.connect(attacker);

    const balanceBefore = await dvpErc1155Pnh.balanceOf(privateHub.adminWallet.address, BURN_TARGET_TOKEN_ID);
    expect(balanceBefore).to.equal(BURN_TARGET_AMOUNT);

    let exploitSucceeded = false;
    try {
      const tx = await dvpAsAttacker.burn(
        privateHub.adminWallet.address,
        BURN_TARGET_TOKEN_ID,
        BURN_TARGET_AMOUNT,
        { gasLimit: GAS_LIMIT },
      );
      await tx.wait();
      exploitSucceeded = true;
    } catch (error: any) {
      LOGGER.log(`   burn reverted — ${error?.shortMessage ?? error?.message ?? 'unknown'}`);
    }

    expect(exploitSucceeded, 'unauthorized burn must revert').to.equal(false);

    const balanceAfter = await dvpErc1155Pnh.balanceOf(privateHub.adminWallet.address, BURN_TARGET_TOKEN_ID);
    expect(balanceAfter).to.equal(BURN_TARGET_AMOUNT);
  });

  it('rejects UpdateInfosAfterDvpWithdraw from an unauthorized caller', async function () {
    const dvpAsAttacker = dvpErc1155Pnh.connect(attacker);

    let exploitSucceeded = false;
    try {
      const tx = await dvpAsAttacker.UpdateInfosAfterDvpWithdraw(
        [0xDEADn],
        [0n],
        99,
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
