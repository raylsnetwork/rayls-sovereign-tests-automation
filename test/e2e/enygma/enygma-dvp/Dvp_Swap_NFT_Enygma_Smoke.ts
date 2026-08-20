import { generateRandomHash } from '../../../test-utils/helpers';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { DEFAULT_TIMEOUT } from '../../../../src/config/env-config';
import { ERC721Wrapper } from '../../../../src/entities/tokens/ERC721Wrapper';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
  ProductionErc1155Dvp,
  ProductionErc1155Dvp__factory,
  ProductionErc721Dvp,
  ProductionErc721Dvp__factory,
} from '../../../../typechain-types';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { ERC1155Wrapper } from '../../../../src/entities/tokens/ERC1155Wrapper';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';

// Split out of Dvp_Consolidated_NFT_Enygma_Swaps.ts to unblock parallel execution.
// Heavy/regression swaps remain in that file under; lightweight @smoke swaps
// (single-deposit) live here and run in parallel workers.

describe('Dvp NFT-EnygmaWrapper Smoke Swaps', function () {
  this.retries(0);

  describe('NFT-Enygma single-deposit swap', function () {
    let privacyNodes: PrivacyNodeMap;
    let privateHub: PrivateHub;

    let enygmaToken: EnygmaWrapper<ProductionEnygmaToken>;
    let nft: ERC721Wrapper<ProductionErc721Dvp>;
    let singerAddressA = '';
    let singerAddressB = '';

    beforeEach(async function () {
      this.timeout(DEFAULT_TIMEOUT);
      const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
      privacyNodes = initializedNodes;
      privateHub = initializedPNH;
      enygmaToken = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
      nft = new ERC721Wrapper(privacyNodes.B, ProductionErc721Dvp__factory);
      singerAddressA = await enygmaToken.userWallet.getAddress();
      singerAddressB = await nft.userWallet.getAddress();
      await enygmaToken.deployViaFactory();
      await enygmaToken.activateOnPn();
      await enygmaToken.activateOnHub(privateHub);
      await nft.deploy();
      await nft.activateOnPn();
      await nft.activateOnHub(privateHub);
    });

    it('should perform NFT-EnygmaWrapper swap with single deposit @smoke @dvp @swap', async function () {
      const DEPOSIT_AMOUNT = BigInt(100);
      const CHANGE_AMOUNT = BigInt(10);
      const MINT_AMOUNT = DEPOSIT_AMOUNT + CHANGE_AMOUNT;
      const PAYMENT_AMOUNT = MINT_AMOUNT - CHANGE_AMOUNT;

      await enygmaToken.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: singerAddressA });
      const tokenId = await nft.mintAndAwait(privateHub, { toAddress: singerAddressB });

      await enygmaToken.depositEnygmaToDvp(MINT_AMOUNT, BigInt(0), privateHub);
      await nft.depositNftToDvp(privateHub, tokenId);

      const sharedId = generateRandomHash();
      const blockNumber = await privateHub.provider.getBlockNumber();
      await nft.swapForEnygma(privateHub, {
        nftId: tokenId, enygmaAmount: PAYMENT_AMOUNT, enygmaResourceId: enygmaToken.resourceId,
        enygmaPLChainId: privacyNodes.A.chainId, sharedId, validity: 0,
      });
      await enygmaToken.swapForERC721(privateHub, {
        nftId: tokenId, nftResourceId: nft.resourceId, enygmaAmount: PAYMENT_AMOUNT,
        nftPLChainId: privacyNodes.B.chainId, sharedId, validity: 0,
      });
      await privateHub.waitForSwapCompleted(sharedId, blockNumber);

      const nftOnA = await nft.forNode(privacyNodes.A, true, enygmaToken.userWallet);
      await nftOnA.withdrawNftFromDvp(privateHub, tokenId, singerAddressA);
      const enygmaOnB = await enygmaToken.forNode(privacyNodes.B, true, nft.userWallet);
      await enygmaOnB.withdrawEnygmaFromDvp(PAYMENT_AMOUNT, privateHub);
      await enygmaToken.withdrawEnygmaFromDvp(CHANGE_AMOUNT, privateHub);
    }).timeout(DEFAULT_TIMEOUT * 2);
  });

  describe('ERC1155-Enygma single-deposit swap', function () {
    let privacyNodes: PrivacyNodeMap;
    let privateHub: PrivateHub;
    let enygmaToken: EnygmaWrapper<ProductionEnygmaToken>;
    let erc1155: ERC1155Wrapper<ProductionErc1155Dvp>;
    const ERC1155_ID = BigInt(1);
    let singerAddressA = '';
    let singerAddressB = '';

    beforeEach(async function () {
      this.timeout(DEFAULT_TIMEOUT);
      const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
      privacyNodes = initializedNodes;
      privateHub = initializedPNH;
      enygmaToken = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
      erc1155 = new ERC1155Wrapper(privacyNodes.B, ProductionErc1155Dvp__factory);
      singerAddressA = enygmaToken.userWallet.address;
      singerAddressB = erc1155.userWallet.address;

      await enygmaToken.deployViaFactory();
      await enygmaToken.activateOnPn();
      await enygmaToken.activateOnHub(privateHub);
      await erc1155.deploy();
      await erc1155.activateOnPn();
      await erc1155.activateOnHub(privateHub);
    });

    it('should perform ERC1155-EnygmaWrapper swap with single deposit (no change) @smoke @dvp @swap @erc1155', async function () {
      const ERC1155_DEPOSIT_AMOUNT = BigInt(10);
      const ENYGMA_DEPOSIT_AMOUNT = BigInt(10);
      const ERC1155_MINT_AMOUNT = ERC1155_DEPOSIT_AMOUNT;
      const ENYGMA_MINT_AMOUNT = ENYGMA_DEPOSIT_AMOUNT;

      await enygmaToken.mintAndAwait(privateHub, { amount: ENYGMA_MINT_AMOUNT, toAddress: singerAddressA });
      await erc1155.mintAndAwait(privateHub, { toAddress: singerAddressB, tokenId: BigInt(ERC1155_ID), amount: ERC1155_MINT_AMOUNT });

      await enygmaToken.depositEnygmaToDvp(ENYGMA_MINT_AMOUNT, BigInt(0), privateHub);
      await erc1155.depositNftToDvp(privateHub, ERC1155_ID, ERC1155_MINT_AMOUNT);

      const sharedId = generateRandomHash();
      const swapBlockNumber = await privateHub.provider.getBlockNumber();
      await erc1155.swapForEnygma(privateHub, {
        nftId: ERC1155_ID, nftAmount: ERC1155_MINT_AMOUNT, data: '0x', enygmaAmount: ENYGMA_DEPOSIT_AMOUNT,
        enygmaResourceId: enygmaToken.resourceId, enygmaPLChainId: privacyNodes.A.chainId, sharedId, validity: 0,
      });
      await enygmaToken.swapForERC1155(privateHub, {
        nftId: ERC1155_ID, nftAmount: ERC1155_MINT_AMOUNT, nftResourceId: erc1155.resourceId,
        enygmaAmount: ENYGMA_DEPOSIT_AMOUNT, nftPLChainId: privacyNodes.B.chainId, sharedId, validity: 0,
      });
      await privateHub.waitForSwapCompleted(sharedId, swapBlockNumber);

      const erc1155OnA = await erc1155.forNode(privacyNodes.A, true, enygmaToken.userWallet);
      await erc1155OnA.withdrawNftFromDvp(privateHub, ERC1155_ID, ERC1155_MINT_AMOUNT, singerAddressA);
      const enygmaOnB = await enygmaToken.forNode(privacyNodes.B, true, erc1155.userWallet);
      await enygmaOnB.withdrawEnygmaFromDvp(ENYGMA_DEPOSIT_AMOUNT, privateHub);
    }).timeout(DEFAULT_TIMEOUT * 2);
  });
});
