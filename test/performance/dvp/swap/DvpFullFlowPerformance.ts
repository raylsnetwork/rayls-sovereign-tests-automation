import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { ERC721Wrapper } from '../../../../src/entities/tokens/ERC721Wrapper';
import { ERC1155Wrapper } from '../../../../src/entities/tokens/ERC1155Wrapper';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { generateRandomHash } from '../../../test-utils/helpers';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
  ProductionErc721Dvp__factory,
  ProductionErc1155Dvp__factory,
  ProductionErc1155Dvp,
  ProductionErc721Dvp,
} from '../../../../typechain-types';
import JsonReporter from '../../reporters/JsonReporter';
import { LOGGER } from '../../../../src/config/env-config';

// DVP_FLOW_ITERATIONS=1 DVP_NFT_TYPE=ERC721 npx hardhat test test/performance/dvp/swap/DvpFullFlowPerformance.ts
// DVP_FLOW_ITERATIONS=1 DVP_NFT_TYPE=ERC1155 npx hardhat test test/performance/dvp/swap/DvpFullFlowPerformance.ts

const totalIterations = parseInt(process.env.DVP_FLOW_ITERATIONS || '1');
const nftType = process.env.DVP_NFT_TYPE || 'ERC721'; // ERC721 or ERC1155

describe('Dvp Full Flow Performance Test', function () {
  const testTimeout = (30 * 60 * 1000) + (totalIterations * 5 * 60 * 1000);
  this.timeout(testTimeout);

  LOGGER.log(`=== Dvp Full Flow Performance Test ===`);
  LOGGER.log(`Total Iterations: ${totalIterations}`);
  LOGGER.log(`NFT Type: ${nftType}`);
  LOGGER.log(`Test Timeout: ${Math.round(testTimeout / 1000 / 60)} minutes`);

  const DEPOSIT_AMOUNT = 100n;
  const AMOUNT_OF_DEPOSITS = 1n;
  const MINT_AMOUNT = DEPOSIT_AMOUNT * AMOUNT_OF_DEPOSITS;
  const PAYMENT_AMOUNT = MINT_AMOUNT;
  const NFT_ID = 1n; // For ERC1155

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let enygma: EnygmaWrapper<ProductionEnygmaToken>;
  let nft: ERC721Wrapper<ProductionErc721Dvp> | ERC1155Wrapper<ProductionErc1155Dvp>;
  let erc721TokenId: bigint;

  beforeEach(async function() {
    this.timeout(5 * 60 * 1000);

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    enygma = new EnygmaWrapper<ProductionEnygmaToken>(privacyNodes.A, ProductionEnygmaToken__factory);
    if (nftType === 'ERC1155') {
      nft = new ERC1155Wrapper(privacyNodes.B, ProductionErc1155Dvp__factory);
      nft.uri = 'https://example.com/nft-metadata';
    } else {
      nft = new ERC721Wrapper(privacyNodes.B, ProductionErc721Dvp__factory);
    }

    LOGGER.log(`Setting up new tokens for iteration (${nftType})`);
    await enygma.deployViaFactory();
    await enygma.activateOnPn();
    await enygma.activateOnHub(privateHub);
    await nft.deploy();
    await nft.activateOnPn();
    await nft.activateOnHub(privateHub);

    await enygma.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: enygma.userWallet.address });

    if (nftType === 'ERC1155') {
      await (nft as ERC1155Wrapper<any>).mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: nft.userWallet.address, tokenId: NFT_ID });
    } else {
      erc721TokenId = await (nft as ERC721Wrapper<any>).mintAndAwait(privateHub, { toAddress: nft.userWallet.address });
    }
  });

  describe(`Performance Tests`, function () {

    it(`Full flow timing for ${totalIterations} iteration(s): deposit -> swap -> withdrawal`, async function () {
      this.timeout(testTimeout);

      LOGGER.log(`Starting Dvp full flow performance test`);

      const flowTimings = [];
      let totalFlowTime = 0;
      let successfulFlows = 0;
      let failedFlows = 0;

      for (let iteration = 1; iteration <= totalIterations; iteration++) {
        LOGGER.log(`\n=== Starting Flow Iteration ${iteration}/${totalIterations} ===`);

        try {
          // Start measuring from first deposit
          const flowStartTime = Date.now();
          LOGGER.log(`Flow ${iteration}: Starting timer at ${formatTimestamp(new Date(flowStartTime))}`);

          // Step 1: Deposit EnygmaWrapper tokens
          LOGGER.log(`Flow ${iteration}: Step 1 - Depositing ${MINT_AMOUNT} enygmas`);
          const depositStart = Date.now();
          await enygma.depositEnygmaToDvp(MINT_AMOUNT, 0n, privateHub);
          const depositDuration = Date.now() - depositStart;
          LOGGER.log(`Flow ${iteration}: Deposit completed in ${(depositDuration / 1000).toFixed(2)}s`);

          // Step 2: Deposit NFT
          LOGGER.log(`Flow ${iteration}: Step 2 - Depositing ${nftType}`);
          const nftDepositStart = Date.now();

          if (nftType === 'ERC1155') {
            await (nft as ERC1155Wrapper<any>).depositNftToDvp(privateHub, NFT_ID, MINT_AMOUNT);
          } else {
            await (nft as ERC721Wrapper<any>).depositNftToDvp(privateHub, erc721TokenId);
          }

          const nftDepositDuration = Date.now() - nftDepositStart;
          LOGGER.log(`Flow ${iteration}: ${nftType} deposit completed in ${(nftDepositDuration / 1000).toFixed(2)}s`);

          // Step 3: Perform swap
          LOGGER.log(`Flow ${iteration}: Step 3 - Swapping ${nftType} for ${PAYMENT_AMOUNT} enygmas`);
          const swapStart = Date.now();

          const sharedId = generateRandomHash();
          const swapBlockNumber = await privateHub.provider.getBlockNumber();
          if (nftType === 'ERC1155') {
            await (nft as ERC1155Wrapper<ProductionErc1155Dvp>).swapForEnygma(privateHub, {
              nftId: NFT_ID, nftAmount: MINT_AMOUNT, data: '0x', enygmaAmount: PAYMENT_AMOUNT,
              enygmaResourceId: enygma.resourceId, enygmaPLChainId: privacyNodes.A.chainId, sharedId,
              validity: 0,
            });
            await enygma.swapForERC1155(privateHub, {
              nftId: NFT_ID, nftAmount: MINT_AMOUNT, nftResourceId: nft.resourceId,
              enygmaAmount: PAYMENT_AMOUNT, nftPLChainId: privacyNodes.B.chainId, sharedId,
              validity: 0,
            });
          } else {
            await (nft as ERC721Wrapper<ProductionErc721Dvp>).swapForEnygma(privateHub, {
              nftId: erc721TokenId, enygmaAmount: PAYMENT_AMOUNT,
              enygmaResourceId: enygma.resourceId, enygmaPLChainId: privacyNodes.A.chainId, sharedId,
              validity: 0,
            });
            await enygma.swapForERC721(privateHub, {
              nftId: erc721TokenId, nftResourceId: nft.resourceId,
              enygmaAmount: PAYMENT_AMOUNT, nftPLChainId: privacyNodes.B.chainId, sharedId,
              validity: 0,
            });
          }
          await privateHub.waitForSwapCompleted(sharedId, swapBlockNumber);

          const swapDuration = Date.now() - swapStart;
          LOGGER.log(`Flow ${iteration}: Swap completed in ${(swapDuration / 1000).toFixed(2)}s`);

          // Step 4: Withdraw NFT (PN A gets the NFT)
          LOGGER.log(`Flow ${iteration}: Step 4 - Withdrawing ${nftType} for PN A`);
          const nftWithdrawStart = Date.now();

          if (nftType === 'ERC1155') {
            const nftOnA = await (nft as ERC1155Wrapper<any>).forNode(privacyNodes.A, true, enygma.userWallet);
            await nftOnA.withdrawNftFromDvp(privateHub, NFT_ID, MINT_AMOUNT, enygma.userWallet.address);
          } else {
            const nftOnA = await (nft as ERC721Wrapper<any>).forNode(privacyNodes.A, true, enygma.userWallet);
            await nftOnA.withdrawNftFromDvp(privateHub, erc721TokenId, enygma.userWallet.address);
          }

          const nftWithdrawDuration = Date.now() - nftWithdrawStart;
          LOGGER.log(`Flow ${iteration}: ${nftType} withdrawal completed in ${(nftWithdrawDuration / 1000).toFixed(2)}s`);

          // Step 5: Withdraw all tokens for PN B
          LOGGER.log(`Flow ${iteration}: Step 5 - Withdrawing ${PAYMENT_AMOUNT} enygmas for PN B`);
          const paymentWithdrawStart = Date.now();
          const enygmaOnB = await enygma.forNode(privacyNodes.B, true, nft.userWallet);
          await enygmaOnB.withdrawEnygmaFromDvp(PAYMENT_AMOUNT, privateHub);
          const paymentWithdrawDuration = Date.now() - paymentWithdrawStart;
          LOGGER.log(`Flow ${iteration}: Token withdrawal completed in ${(paymentWithdrawDuration / 1000).toFixed(2)}s`);

          // End timing at last withdrawal completion
          const flowEndTime = Date.now();
          const flowTotalDuration = flowEndTime - flowStartTime;

          LOGGER.log(`Flow ${iteration}: COMPLETED in ${(flowTotalDuration / 1000).toFixed(2)}s total`);
          LOGGER.log(`Flow ${iteration}: Breakdown - Deposit: ${(depositDuration / 1000).toFixed(2)}s, ${nftType} Deposit: ${(nftDepositDuration / 1000).toFixed(2)}s, Swap: ${(swapDuration / 1000).toFixed(2)}s, ${nftType} Withdraw: ${(nftWithdrawDuration / 1000).toFixed(2)}s, Token Withdraw: ${(paymentWithdrawDuration / 1000).toFixed(2)}s`);

          flowTimings.push({
            iteration,
            totalDuration: flowTotalDuration / 1000,
            depositDuration: depositDuration / 1000,
            nftDepositDuration: nftDepositDuration / 1000,
            swapDuration: swapDuration / 1000,
            nftWithdrawDuration: nftWithdrawDuration / 1000,
            tokenWithdrawDuration: paymentWithdrawDuration / 1000,
            startTime: flowStartTime,
            endTime: flowEndTime
          });

          totalFlowTime += flowTotalDuration;
          successfulFlows++;

        } catch (error) {
          LOGGER.log(`Flow ${iteration}: FAILED - ${error}`);
          failedFlows++;
        }

        // Reset tokens for next iteration if not the last one
        if (iteration < totalIterations) {
          LOGGER.log(`Flow ${iteration}: Resetting for next iteration...`);
          enygma = new EnygmaWrapper<ProductionEnygmaToken>(privacyNodes.A, ProductionEnygmaToken__factory);
          if (nftType === 'ERC1155') {
            nft = new ERC1155Wrapper(privacyNodes.B, ProductionErc1155Dvp__factory);
            nft.uri = 'https://example.com/nft-metadata';
          } else {
            nft = new ERC721Wrapper(privacyNodes.B, ProductionErc721Dvp__factory);
          }
          await enygma.deployViaFactory();
          await enygma.activateOnPn();
          await enygma.activateOnHub(privateHub);
          await (nft as any).deploy();
          await (nft as any).activateOnPn();
          await (nft as any).activateOnHub(privateHub);
          await enygma.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: enygma.userWallet.address });
          if (nftType === 'ERC1155') {
            await (nft as ERC1155Wrapper<any>).mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: nft.userWallet.address, tokenId: NFT_ID });
          } else {
            erc721TokenId = await (nft as ERC721Wrapper<any>).mintAndAwait(privateHub, { toAddress: nft.userWallet.address });
          }
        }
      }

      // Calculate statistics
      const avgFlowTime = successfulFlows > 0 ? totalFlowTime / successfulFlows / 1000 : 0;
      const minFlowTime = flowTimings.length > 0 ? Math.min(...flowTimings.map(f => f.totalDuration)) : 0;
      const maxFlowTime = flowTimings.length > 0 ? Math.max(...flowTimings.map(f => f.totalDuration)) : 0;

      LOGGER.log(`\n=== Dvp Full Flow Performance Results ===`);
      LOGGER.log(`Total Iterations: ${totalIterations}`);
      LOGGER.log(`Successful Flows: ${successfulFlows}`);
      LOGGER.log(`Failed Flows: ${failedFlows}`);
      LOGGER.log(`Success Rate: ${((successfulFlows / totalIterations) * 100).toFixed(2)}%`);
      LOGGER.log(`Average Flow Time: ${avgFlowTime.toFixed(2)}s`);
      LOGGER.log(`Min Flow Time: ${minFlowTime.toFixed(2)}s`);
      LOGGER.log(`Max Flow Time: ${maxFlowTime.toFixed(2)}s`);
      LOGGER.log(`Total Test Duration: ${(totalFlowTime / 1000).toFixed(2)}s`);

      const jsonReporter = new JsonReporter();
      const testData = {
        testType: `Dvp Full Flow Performance Test (Enygma ↔ ${nftType})`,
        startTime: flowTimings.length > 0 ? flowTimings[0].startTime : Date.now(),
        endTime: flowTimings.length > 0 ? flowTimings[flowTimings.length - 1].endTime : Date.now(),
        rpcUrlA: privacyNodes.A.rpcUrl,
        rpnCount: 2,
        methodology: `Measure end-to-end timing for complete Dvp flow: deposit tokens -> deposit NFT -> swap -> withdraw NFT -> withdraw tokens. Timer starts at first deposit and ends at last withdrawal completion.`,
        totalFlowDuration: avgFlowTime,
        stepBreakdown: flowTimings.length > 0 ? {
          depositDuration: flowTimings.reduce((s, f) => s + f.depositDuration, 0) / flowTimings.length,
          nftDepositDuration: flowTimings.reduce((s, f) => s + f.nftDepositDuration, 0) / flowTimings.length,
          swapDuration: flowTimings.reduce((s, f) => s + f.swapDuration, 0) / flowTimings.length,
          nftWithdrawDuration: flowTimings.reduce((s, f) => s + f.nftWithdrawDuration, 0) / flowTimings.length,
          tokenWithdrawDuration: flowTimings.reduce((s, f) => s + f.tokenWithdrawDuration, 0) / flowTimings.length
        } : null,
        configuration: {
          depositAmount: DEPOSIT_AMOUNT.toString(),
          mintAmount: MINT_AMOUNT.toString(),
          paymentAmount: PAYMENT_AMOUNT.toString(),
          tokenTypes: {
            fungible: 'EnygmaWrapper',
            nonFungible: nftType
          }
        }
      };

      jsonReporter.generateReport(testData, `enygma-performance_${new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '')}.json`);

      if (successfulFlows === 0) {
        throw new Error('No flows completed successfully');
      }

      LOGGER.log(`Performance test completed successfully with ${successfulFlows}/${totalIterations} successful flows`);
    });

  });

  function formatTimestamp(date: Date): string {
    return date.toTimeString().substring(0, 8);
  }

});