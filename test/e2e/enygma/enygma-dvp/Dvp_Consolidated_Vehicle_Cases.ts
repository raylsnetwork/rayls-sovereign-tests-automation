import { generateRandomHash } from '../../../test-utils/helpers';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import {
  shouldCrossTransferEnygma,
} from '../../../../src/flows/tokens/token-flows';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
  ProductionErc721Dvp,
  ProductionErc721Dvp__factory,
  ProductionErc1155Dvp,
  ProductionErc1155Dvp__factory,
} from '../../../../typechain-types';
import { ERC721Wrapper } from '../../../../src/entities/tokens/ERC721Wrapper';
import { ERC1155Wrapper } from '../../../../src/entities/tokens/ERC1155Wrapper';
import { DEFAULT_TIMEOUT, LOGGER } from '../../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { EnygmaCrossTransfer } from '../../../../src/types';

describe('Dvp Vehicle Case Tests', function () {

  describe('ERC721 Vehicle Case (Zero-Value Cross-Chain Swaps) @smoke', function () {
    const PAYMENT_AMOUNT = BigInt(0); // Zero value swaps
    const MINT_AMOUNT = BigInt(10);

    let enygma: EnygmaWrapper<ProductionEnygmaToken>;
    let nft: ERC721Wrapper<ProductionErc721Dvp>;
    let privateHub : PrivateHub;
    let privacyNodes : PrivacyNodeMap;

    beforeEach(async function () {
      this.timeout(DEFAULT_TIMEOUT);
      const {initializedNodes,
        initializedPNH} = await initializePrivacyNodesAndPnh(3);
        privacyNodes = initializedNodes;
        privateHub = initializedPNH;

      // Fresh token setup for each test
      enygma = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
      nft = new ERC721Wrapper(privacyNodes.B,ProductionErc721Dvp__factory);
      await enygma.deployViaFactory();
      await enygma.activateOnPn();
      await enygma.activateOnHub(privateHub);
      await nft.deploy();
      await nft.activateOnPn();
      await nft.activateOnHub(privateHub);
    });

    it('should perform ERC721 vehicle case: B→A→C zero-value swaps with cross-chain transfers @regression @dvp @vehicle @erc721', async function () {
      // Setup: Mint tokens
      await enygma.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: enygma.userWallet.address });
      const tokenId = await nft.mintAndAwait(privateHub, { toAddress: nft.userWallet.address });

      // Setup: Deposit NFT from PN B to Dvp
      await nft.depositNftToDvp(privateHub, tokenId);

      // First Swap: NFT (from PN B) for 0 Enygmas (from PN A) - Zero Value Swap
      const sharedId1 = generateRandomHash();
      const blockNumber1 = await privateHub.provider.getBlockNumber();
      await nft.swapForEnygma(privateHub, {
        nftId: tokenId, enygmaAmount: PAYMENT_AMOUNT, enygmaResourceId: enygma.resourceId,
        enygmaPLChainId: privacyNodes.A.chainId, sharedId: sharedId1, validity: 0,
      });

      await enygma.swapForERC721(privateHub, {
        nftId: tokenId, nftResourceId: nft.resourceId, enygmaAmount: PAYMENT_AMOUNT,
        nftPLChainId: privacyNodes.B.chainId, sharedId: sharedId1, validity: 0,
      });
      await privateHub.waitForSwapCompleted(sharedId1, blockNumber1);

      // PN A withdraws the NFT (vehicle now on PN A)
      const nftOnA = await nft.forNode(privacyNodes.A, true, enygma.userWallet);
      await nftOnA.withdrawNftFromDvp(privateHub, tokenId, nft.userWallet.address);

      // Cross-chain transfer: Send Enygmas from PN A to PN C
      const transfer: EnygmaCrossTransfer = {
        destinationAddresses: [enygma.userWallet.address],
        amounts: [MINT_AMOUNT],
        destinationChainIds: [privacyNodes.C.chainId],
        programData: [[]],
      };

      const expectedBalances = {
        [privacyNodes.C.chainId]: MINT_AMOUNT,
      };

      const destinations = [privacyNodes.C];

      await shouldCrossTransferEnygma(transfer, 1, expectedBalances, privateHub, privacyNodes.A, destinations, enygma);

      // Create wrappers pointed at the PNs where tokens now live
      const enygmaOnC = await enygma.forNode(privacyNodes.C);

      // Setup: Deposit NFT from PN A to Dvp for second swap
      await nftOnA.depositNftToDvp(privateHub, tokenId);

      // Second Swap: NFT (from PN A) for 0 Enygmas (from PN C) - Zero Value Swap
      const sharedId2 = generateRandomHash();
      const blockNumber2 = await privateHub.provider.getBlockNumber();
      await nftOnA.swapForEnygma(privateHub, {
        nftId: tokenId, enygmaAmount: PAYMENT_AMOUNT, enygmaResourceId: enygma.resourceId,
        enygmaPLChainId: privacyNodes.C.chainId, sharedId: sharedId2, validity: 0,
      });

      await enygmaOnC.swapForERC721(privateHub, {
        nftId: tokenId, nftResourceId: nft.resourceId, enygmaAmount: PAYMENT_AMOUNT,
        nftPLChainId: privacyNodes.A.chainId, sharedId: sharedId2, validity: 0,
      });
      await privateHub.waitForSwapCompleted(sharedId2, blockNumber2);

      // PN C withdraws the NFT (vehicle ends up on PN C)
      const nftOnC = await nftOnA.forNode(privacyNodes.C, true, enygma.userWallet);
      await nftOnC.withdrawNftFromDvp(privateHub, tokenId, nft.userWallet.address);

      LOGGER.log('✅ ERC721 Vehicle Case completed: NFT traveled B → A → C through zero-value swaps');
    }).timeout(15 * 60 * 1000); // Extended timeout for complex multi-PL flow
  });

  describe('ERC1155 Vehicle Case (Free & Paid Cross-Chain Swaps)', function () {
    const ZERO_ENYGMA_PAYMENT_AMOUNT = BigInt(0);
    const TEN_ENYGMA_PAYMENT_AMOUNT = BigInt(10);
    const MINT_ENYGMA_AMOUNT = BigInt(100);
    const NFT_ID = BigInt(1);
    const MINT_NFT_AMOUNT = BigInt(10);

    let enygma: EnygmaWrapper<ProductionEnygmaToken>;
    let erc1155: ERC1155Wrapper<ProductionErc1155Dvp>;
    let privateHub: PrivateHub;
    let raylsNode: PrivacyNodeMap;

    beforeEach(async function () {
      this.timeout(DEFAULT_TIMEOUT);
      const {initializedNodes,
        initializedPNH} = await initializePrivacyNodesAndPnh(3);
      raylsNode = initializedNodes;
      privateHub = initializedPNH;

      enygma = new EnygmaWrapper(raylsNode.A, ProductionEnygmaToken__factory);
      erc1155 = new ERC1155Wrapper(raylsNode.B, ProductionErc1155Dvp__factory);
      await enygma.deployViaFactory();
      await enygma.activateOnPn();
      await enygma.activateOnHub(privateHub);
      await erc1155.deploy();
      await erc1155.activateOnPn();
      await erc1155.activateOnHub(privateHub);
    });

    it('should perform ERC1155 vehicle case: free swap + cross-transfer + paid swap @regression @dvp @vehicle @erc1155', async function () {
      // Setup: Mint tokens
      await enygma.mintAndAwait(privateHub, { amount: MINT_ENYGMA_AMOUNT, toAddress: enygma.userWallet.address });
      await erc1155.mintAndAwait(privateHub, { toAddress: erc1155.userWallet.address, tokenId: NFT_ID, amount: MINT_NFT_AMOUNT });

      // Setup: Deposit ERC1155 from PN B to Dvp
      await erc1155.depositNftToDvp(privateHub, NFT_ID, MINT_NFT_AMOUNT);

      // First Swap: ERC1155 (from PN B) for 0 Enygmas (from PN A) - Free Swap
      const sharedId1 = generateRandomHash();
      const blockNumber1 = await privateHub.provider.getBlockNumber();
      await erc1155.swapForEnygma(privateHub, {
        nftId: NFT_ID, nftAmount: MINT_NFT_AMOUNT, data: '0x', enygmaAmount: ZERO_ENYGMA_PAYMENT_AMOUNT,
        enygmaResourceId: enygma.resourceId, enygmaPLChainId: raylsNode.A.chainId, sharedId: sharedId1,
        validity: 0,
      });
      await enygma.swapForERC1155(privateHub, {
        nftId: NFT_ID, nftAmount: MINT_NFT_AMOUNT, nftResourceId: erc1155.resourceId,
        enygmaAmount: ZERO_ENYGMA_PAYMENT_AMOUNT, nftPLChainId: raylsNode.B.chainId, sharedId: sharedId1,
        validity: 0,
      });
      await privateHub.waitForSwapCompleted(sharedId1, blockNumber1);

      // PN A withdraws the ERC1155 (vehicle now on PN A)
      const erc1155OnA = await erc1155.forNode(raylsNode.A, true, enygma.userWallet);
      await erc1155OnA.withdrawNftFromDvp(privateHub, NFT_ID, MINT_NFT_AMOUNT, erc1155.userWallet.address);

      // Cross-chain transfer: Send half of Enygmas from PN A to PN C
      const transfer: EnygmaCrossTransfer = {
        destinationAddresses: [enygma.userWallet.address],
        amounts: [MINT_ENYGMA_AMOUNT / BigInt(2)],
        destinationChainIds: [raylsNode.C.chainId],
        programData: [[]],
      };

      const expectedBalances = {
        [raylsNode.C.chainId]: MINT_ENYGMA_AMOUNT / BigInt(2),
      };

      const destinations = [raylsNode.C];

      await shouldCrossTransferEnygma(transfer, 1, expectedBalances, privateHub, raylsNode.A, destinations, enygma);

      // Create wrappers pointed at the PNs where tokens now live
      const enygmaOnC = await enygma.forNode(raylsNode.C);

      // Setup: Deposit ERC1155 from PN A to Dvp for second swap
      await erc1155OnA.depositNftToDvp(privateHub, NFT_ID, MINT_NFT_AMOUNT);

      // Setup: Deposit some Enygmas from PN C to Dvp to ensure EnygmaWrapper bridge is active
      await enygmaOnC.depositEnygmaToDvp(
        TEN_ENYGMA_PAYMENT_AMOUNT,
        MINT_ENYGMA_AMOUNT / BigInt(2) - TEN_ENYGMA_PAYMENT_AMOUNT,
        privateHub,
      );

      // Second Swap: ERC1155 (from PN A) for 10 Enygmas (from PN C) - Paid Swap
      const sharedId2 = generateRandomHash();
      const blockNumber2 = await privateHub.provider.getBlockNumber();
      await erc1155OnA.swapForEnygma(privateHub, {
        nftId: NFT_ID, nftAmount: MINT_NFT_AMOUNT, data: '0x', enygmaAmount: TEN_ENYGMA_PAYMENT_AMOUNT,
        enygmaResourceId: enygma.resourceId, enygmaPLChainId: raylsNode.C.chainId, sharedId: sharedId2,
        validity: 0,
      });
      await enygmaOnC.swapForERC1155(privateHub, {
        nftId: NFT_ID, nftAmount: MINT_NFT_AMOUNT, nftResourceId: erc1155.resourceId,
        enygmaAmount: TEN_ENYGMA_PAYMENT_AMOUNT, nftPLChainId: raylsNode.A.chainId, sharedId: sharedId2,
        validity: 0,
      });
      await privateHub.waitForSwapCompleted(sharedId2, blockNumber2);

      // PN C withdraws the ERC1155 (vehicle ends up on PN C)
      const erc1155OnC = await erc1155OnA.forNode(raylsNode.C, true, enygma.userWallet);
      await erc1155OnC.withdrawNftFromDvp(privateHub, NFT_ID, MINT_NFT_AMOUNT, erc1155.userWallet.address);

      // PN A withdraws the Enygmas received from the paid swap
      const enygmaOnA = await enygmaOnC.forNode(raylsNode.A, true);
      await enygmaOnA.withdrawEnygmaFromDvp(
        TEN_ENYGMA_PAYMENT_AMOUNT,
        privateHub,
      );

      LOGGER.log('✅ ERC1155 Vehicle Case completed: ERC1155 traveled B → A → C through free + paid swaps');
    }).timeout(15 * 60 * 1000); // Extended timeout for complex multi-PL flow
  });
});
