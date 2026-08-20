import hre from 'hardhat';
import { expect } from 'chai';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
  ProductionErc721Dvp,
  ProductionErc721Dvp__factory,
  ProductionErc1155Dvp,
  ProductionErc1155Dvp__factory,
  TokenRegistryV1,
  PNTokenRegistryV1,
} from '../../../../typechain-types';
import { DEFAULT_TIMEOUT } from '../../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { ERC721Wrapper } from '../../../../src/entities/tokens/ERC721Wrapper';
import { ERC1155Wrapper } from '../../../../src/entities/tokens/ERC1155Wrapper';
import { cleanEnygmaDb } from '../../../../src/utils/db-utils';
import { cleanupFrozenTokens, freezeAndSync } from '../../../test-utils/freeze-helpers';

describe('E2E Tests: DvP Token Freeze Functionality', function () {
  const MINT_AMOUNT = 1000n;
  const TOKEN_ID = 1n;
  const TOKEN_AMOUNT = 100n;

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let enygmaOnPNA: EnygmaWrapper<ProductionEnygmaToken>;
  let nftOnPNB: ERC721Wrapper<ProductionErc721Dvp>;
  let nftTokenId: bigint;
  let erc11555OnPNB: ERC1155Wrapper<ProductionErc1155Dvp>;
  let tokenRegistry: TokenRegistryV1;
  let tokenRegistryOnA: PNTokenRegistryV1;
  let tokenRegistryOnB: PNTokenRegistryV1;

  // ---------------------------------------------------------------------------
  // "Ensure deposited" helpers (DVP pre-conditions)
  // withdraw and swap functionalities check lockedForDvp before reaching
  // EnygmaPNEvents freeze validation, so tokens must be deposited first.
  // ---------------------------------------------------------------------------

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    tokenRegistry = await privateHub.getTokenRegistryAsCompliance();
    // getFrozenTokenForParticipant (polled by freezeAndSync) is `restricted` — connect an ADMIN signer.
    tokenRegistryOnA = await privacyNodes.A.getPnTokenRegistry(privacyNodes.A.adminWallet);
    tokenRegistryOnB = await privacyNodes.B.getPnTokenRegistry(privacyNodes.B.adminWallet);

    await cleanEnygmaDb();

    // Enygma Setup
    enygmaOnPNA = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
    await enygmaOnPNA.deployViaFactory();
    await enygmaOnPNA.activateOnPn();
    await enygmaOnPNA.activateOnHub(privateHub);
    await enygmaOnPNA.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: enygmaOnPNA.userWallet.address });

    // Erc721Dvp Setup
    nftOnPNB = new ERC721Wrapper<ProductionErc721Dvp>(privacyNodes.B, ProductionErc721Dvp__factory);
    await nftOnPNB.deploy();
    await nftOnPNB.activateOnPn();
    await nftOnPNB.activateOnHub(privateHub);

    // Erc1155Dvp Setup
    erc11555OnPNB = new ERC1155Wrapper<ProductionErc1155Dvp>(privacyNodes.B, ProductionErc1155Dvp__factory);
    await erc11555OnPNB.deploy();
    await erc11555OnPNB.activateOnPn();
    await erc11555OnPNB.activateOnHub(privateHub);

    // Mint initial tokens
    nftTokenId = await nftOnPNB.mintAndAwait(privateHub, { toAddress: nftOnPNB.userWallet.address });
    await erc11555OnPNB.mintAndAwait(privateHub, {
      amount: TOKEN_AMOUNT,
      toAddress: erc11555OnPNB.userWallet.address,
      tokenId: TOKEN_ID,
    });

  });

  afterEach(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    // Each token lives on a single node; only check the chain it was deployed on.
    await cleanupFrozenTokens(tokenRegistry, [tokenRegistryOnA, tokenRegistryOnB], [
      { resourceId: enygmaOnPNA.resourceId,  chainIds: [privacyNodes.A.chainId] },
      { resourceId: nftOnPNB.resourceId,     chainIds: [privacyNodes.B.chainId] },
      { resourceId: erc11555OnPNB.resourceId, chainIds: [privacyNodes.B.chainId] },
    ]);
  });

  // Note: When the token is frozen, the revert must occur in EnygmaPNEvents at the Privacy Node level.

  describe('Enygma token', () => {
    it('Should revert depositToDvp when enygma token is frozen @smoke', async function () {
      await freezeAndSync(tokenRegistry, enygmaOnPNA.resourceId, [privacyNodes.A.chainId], [
        { replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId },
      ]);

      await expect(enygmaOnPNA.contract.depositToDvp(1n)).to.be.revertedWithCustomError(
        enygmaOnPNA.contract,
        'RaylsApp__HubNotActive'
      );
    }).timeout(DEFAULT_TIMEOUT);

    it('Should revert callWithdrawFromDvp when enygma token is frozen', async function () {
      await freezeAndSync(tokenRegistry, enygmaOnPNA.resourceId, [privacyNodes.A.chainId], [
        { replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId },
      ]);

      await expect(enygmaOnPNA.contract.callWithdrawFromDvp(1n)).to.be.revertedWithCustomError(
        enygmaOnPNA.contract,
        'RaylsApp__HubNotActive'
      );
    }).timeout(DEFAULT_TIMEOUT);

    it('Should revert swapWithDvpForERC721 when enygma token is frozen @smoke', async function () {
      await freezeAndSync(tokenRegistry, enygmaOnPNA.resourceId, [privacyNodes.A.chainId], [
        { replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId },
      ]);

      await expect(
        enygmaOnPNA.swapForERC721(privateHub, {
          nftId: nftTokenId,
          nftResourceId: nftOnPNB.resourceId,
          enygmaAmount: 1n,
          nftPLChainId: privacyNodes.B.chainId,
          sharedId: hre.ethers.ZeroHash,
          validity: 0,
        })
      ).to.be.revertedWithCustomError(enygmaOnPNA.contract, 'RaylsApp__HubNotActive');
    }).timeout(DEFAULT_TIMEOUT);
  });

  describe('ERC721 token', () => {
    it('Should revert depositIntoDvp when ERC721 token is frozen @smoke', async function () {
      await freezeAndSync(tokenRegistry, nftOnPNB.resourceId, [privacyNodes.B.chainId], [
        { replica: tokenRegistryOnB, chainId: privacyNodes.B.chainId },
      ]);

      await expect(
        nftOnPNB.depositNftToDvp(privateHub, nftTokenId)
      ).to.be.revertedWithCustomError(nftOnPNB.contract, 'RaylsApp__HubNotActive');
    }).timeout(DEFAULT_TIMEOUT);

    it('Should revert swapForEnygma when ERC721 token is frozen @smoke', async function () {
      await nftOnPNB.depositNftToDvp(privateHub, nftTokenId);

      await freezeAndSync(tokenRegistry, nftOnPNB.resourceId, [privacyNodes.B.chainId], [
        { replica: tokenRegistryOnB, chainId: privacyNodes.B.chainId },
      ]);

      await expect(
        nftOnPNB.swapForEnygma(privateHub, {
          nftId: TOKEN_ID,
          enygmaAmount: 1n,
          enygmaResourceId: enygmaOnPNA.resourceId,
          enygmaPLChainId: privacyNodes.A.chainId,
          sharedId: hre.ethers.ZeroHash,
          validity: 0,
        })
      ).to.be.revertedWithCustomError(nftOnPNB.contract, 'RaylsApp__HubNotActive');
    }).timeout(DEFAULT_TIMEOUT);

    it('Should revert withdrawFromDvp when ERC721 token is frozen', async function () {
      await freezeAndSync(tokenRegistry, nftOnPNB.resourceId, [privacyNodes.B.chainId], [
        { replica: tokenRegistryOnB, chainId: privacyNodes.B.chainId },
      ]);

      await expect(
        nftOnPNB.withdrawNftFromDvp(privateHub, nftTokenId, nftOnPNB.userWallet.address)
      ).to.be.revertedWithCustomError(nftOnPNB.contract, 'RaylsApp__HubNotActive');
    }).timeout(DEFAULT_TIMEOUT);
  });

  describe('ERC1155 token', () => {
    it('Should revert depositIntoDvp when ERC1155 token is frozen @smoke', async function () {
      await freezeAndSync(tokenRegistry, erc11555OnPNB.resourceId, [privacyNodes.B.chainId], [
        { replica: tokenRegistryOnB, chainId: privacyNodes.B.chainId },
      ]);

      await expect(
        erc11555OnPNB.depositNftToDvp(privateHub, TOKEN_ID, TOKEN_AMOUNT)
      ).to.be.revertedWithCustomError(erc11555OnPNB.contract, 'RaylsApp__HubNotActive');
    }).timeout(DEFAULT_TIMEOUT);

    it('Should revert swapForEnygma when ERC1155 token is frozen @smoke', async function () {
      await erc11555OnPNB.depositNftToDvp(privateHub, TOKEN_ID, TOKEN_AMOUNT);

      await freezeAndSync(tokenRegistry, erc11555OnPNB.resourceId, [privacyNodes.B.chainId], [
        { replica: tokenRegistryOnB, chainId: privacyNodes.B.chainId },
      ]);

      await expect(
        erc11555OnPNB.swapForEnygma(privateHub, {
          nftId: TOKEN_ID,
          nftAmount: TOKEN_AMOUNT,
          data: '0x',
          enygmaAmount: 1n,
          enygmaResourceId: enygmaOnPNA.resourceId,
          enygmaPLChainId: privacyNodes.A.chainId,
          sharedId: hre.ethers.ZeroHash,
          validity: 0,
        })
      ).to.be.revertedWithCustomError(erc11555OnPNB.contract, 'RaylsApp__HubNotActive');
    }).timeout(DEFAULT_TIMEOUT);

    it('Should revert withdrawFromDvp when ERC1155 token is frozen', async function () {
      // ERC1155Wrapper.withdrawNftFromDvp polls for lockedForDvp >= amount before calling the contract
      await freezeAndSync(tokenRegistry, erc11555OnPNB.resourceId, [privacyNodes.B.chainId], [
        { replica: tokenRegistryOnB, chainId: privacyNodes.B.chainId },
      ]);

      await expect(
        erc11555OnPNB.withdrawNftFromDvp(privateHub, TOKEN_ID, TOKEN_AMOUNT, erc11555OnPNB.userWallet.address)
      ).to.be.revertedWithCustomError(erc11555OnPNB.contract, 'RaylsApp__HubNotActive');
    }).timeout(DEFAULT_TIMEOUT);
  });
});
