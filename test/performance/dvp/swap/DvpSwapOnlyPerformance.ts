import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { ERC721Wrapper } from '../../../../src/entities/tokens/ERC721Wrapper';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { generateRandomHash } from '../../../test-utils/helpers';
import JsonReporter from '../../reporters/JsonReporter';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
  ProductionErc721Dvp,
  DvpTeleport,
  ProductionErc721Dvp__factory,
} from '../../../../typechain-types';
import { LOGGER } from '../../../../src/config/env-config';
import { eventually } from '../../../../src/utils/common';

// DVP_SWAP_COUNT=5 npx hardhat test test/performance/dvp/swap/DvpSwapOnlyPerformance.ts

describe('Dvp Swap Only Performance Test', function () {
  this.timeout(60 * 60 * 1000); // 1 hour timeout

  // Test configuration
  const totalSwaps = process.env.DVP_SWAP_COUNT ? parseInt(process.env.DVP_SWAP_COUNT) : 3;
  const swapAmount = 10; // Amount of enygma tokens per swap
  const testTimeout = 60 * 60 * 1000; // 1 hour for the entire test

  LOGGER.log(`=== Dvp Swap Only Performance Test Configuration ===`);
  LOGGER.log(`Total Swaps: ${totalSwaps}`);
  LOGGER.log(`Swap Amount: ${swapAmount}`);
  LOGGER.log(`Test Timeout: ${Math.round(testTimeout / 1000 / 60)} minutes`);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  // Arrays to hold separate resources for each swap (isolated resources)
  let enygmaTokens: EnygmaWrapper<ProductionEnygmaToken>[] = [];
  let nftCollections: ERC721Wrapper<ProductionErc721Dvp>[] = [];

  let dvpTeleport: DvpTeleport;

interface SwapExecution {
  id: number;
  nftId: number;
  sharedId: string;
  enygmaToken: EnygmaWrapper<ProductionEnygmaToken>;    // Dedicated enygma token for this swap
  nftCollection: ERC721Wrapper<ProductionErc721Dvp>; // Dedicated NFT collection for this swap
  startTime: number;
  executionTime?: number; // When both sides (2/2) executed
  executionDuration?: number; // Time from start to 2/2 execution
}

  async function sendNftSideSwap(
    swapNumber: number,
    nftId: number,
    enygmaAmount: number,
    sharedId: string,
    nonce: number,
    enygmaToken: EnygmaWrapper<ProductionEnygmaToken>,
    nftCollection: ERC721Wrapper<ProductionErc721Dvp>
  ): Promise<{ txHash: string }> {
    LOGGER.log(`Sending NFT-side swap ${swapNumber}/${totalSwaps} (${nftCollection.symbol} NFT ${nftId} for ${enygmaAmount} ${enygmaToken.symbol})...`);
    try {
      // Get the specific NFT contract for this swap
      const nftAddress = nftCollection.address[privacyNodes.B.chainId];
      const nftContract = await privacyNodes.B.getContractAt<ProductionErc721Dvp>(
        'ProductionErc721Dvp',
        nftAddress,
        nftCollection.symbol
      );

      // Send NFT side transaction without waiting for confirmation
      const tx = await nftContract.swapWithDvpForEnygma(
        nftId,
        enygmaAmount,
        enygmaToken.resourceId,
        privacyNodes.A.chainId,
        sharedId,
        0,
        {
          gasLimit: 1_000_000,
          nonce: nonce
        }
      );

      LOGGER.log(`NFT-side swap ${swapNumber}: sent (${tx.hash})`);
      return { txHash: tx.hash };

    } catch (error) {
      LOGGER.error(`NFT-side swap ${swapNumber} failed to send: ${error}`);
      return { txHash: '' };
    }
  }

  async function sendEnygmaSideSwap(
    swapNumber: number,
    nftId: number,
    enygmaAmount: number,
    sharedId: string,
    nonce: number,
    enygmaToken: EnygmaWrapper<ProductionEnygmaToken>,
    nftCollection: ERC721Wrapper<ProductionErc721Dvp>
  ): Promise<{ txHash: string }> {
    LOGGER.log(`Sending Enygma-side swap ${swapNumber}/${totalSwaps} (${enygmaAmount} ${enygmaToken.symbol} for ${nftCollection.symbol} NFT ${nftId})...`);
    try {
      // Get the specific EnygmaWrapper token contract for this swap
      const tokenAddress = enygmaToken.address[privacyNodes.A.chainId];
      const tokenContract = await privacyNodes.A.getContractAt<ProductionEnygmaToken>(
        'ProductionEnygmaToken',
        tokenAddress,
        enygmaToken.symbol
      );

      // Send EnygmaWrapper side transaction without waiting for confirmation
      const tx = await tokenContract.swapWithDvpForERC721(
        nftId,
        nftCollection.resourceId,
        enygmaAmount,
        privacyNodes.B.chainId,
        sharedId,
        0,
        {
          gasLimit: 1_000_000,
          nonce: nonce
        }
      );

      LOGGER.log(`Enygma-side swap ${swapNumber}: sent (${tx.hash})`);
      return { txHash: tx.hash };

    } catch (error) {
      LOGGER.error(`Enygma-side swap ${swapNumber} failed to send: ${error}`);
      return { txHash: '' };
    }
  }

  before(async function () {
    this.timeout(30 * 60 * 1000); // 30 minutes for setup

    LOGGER.log(`Setting up test environment with ${totalSwaps} isolated resource pairs...`);

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    // Create separate token/NFT pairs for each swap to avoid resource conflicts
    for (let i = 1; i <= totalSwaps; i++) {
      LOGGER.log(`Setting up resource pair ${i}/${totalSwaps}...`);

      // Create unique token/NFT wrappers for this swap
      const enygmaToken = new EnygmaWrapper<ProductionEnygmaToken>(privacyNodes.A,ProductionEnygmaToken__factory);
      const nftCollection = new ERC721Wrapper<ProductionErc721Dvp>(privacyNodes.B, ProductionErc721Dvp__factory);

      enygmaTokens.push(enygmaToken);
      nftCollections.push(nftCollection);

      // Register and activate tokens for this specific resource pair
      await enygmaToken.deployViaFactory();
      await enygmaToken.activateOnPn();
      await enygmaToken.activateOnHub(privateHub);
      await nftCollection.deploy();
      await nftCollection.activateOnPn();
      await nftCollection.activateOnHub(privateHub);

      // Mint tokens for this specific swap (just what's needed + small buffer)
      const tokensToMint = BigInt(swapAmount + 5);
      LOGGER.log(`Minting ${tokensToMint} ${enygmaToken.symbol} tokens...`);
      await enygmaToken.mintAndAwait(privateHub, { amount: tokensToMint, toAddress: enygmaToken.userWallet.address });

      // Mint one NFT for this swap
      LOGGER.log(`Minting NFT 1 for ${nftCollection.symbol}...`);
      await nftCollection.mintAndAwait(privateHub, { toAddress: nftCollection.userWallet.address });

      // Deposit enygma tokens for this swap
      LOGGER.log(`Depositing ${swapAmount} ${enygmaToken.symbol} tokens...`);
      await enygmaToken.depositEnygmaToDvp(BigInt(swapAmount), BigInt(0), privateHub);

      // Deposit NFT for this swap
      LOGGER.log(`Depositing ${nftCollection.symbol} NFT to Dvp...`);
      await nftCollection.depositNftToDvp(privateHub, nftCollection.currentTokenId);

      // Wait additional blocks for cross-chain processing
      const startBlock = await privateHub.provider.getBlockNumber();
      await eventually<boolean>({
        check: async () => {
          const currentBlock = await privateHub.provider.getBlockNumber();
          return currentBlock >= startBlock + 3;
        },
        message: `Waiting for +3 blocks after ${nftCollection.symbol} NFT deposit`,
      });

      LOGGER.log(`Resource pair ${i} (${enygmaToken.symbol} ↔ ${nftCollection.symbol}) setup complete`);
      LOGGER.log(`  Enygma ResourceId: ${enygmaToken.resourceId}`);
      LOGGER.log(`  NFT ResourceId: ${nftCollection.resourceId}`);
    }

    LOGGER.log(`All ${totalSwaps} isolated resource pairs setup completed successfully!`);

    // Get Dvp teleport contract for monitoring
    dvpTeleport = privateHub.getContract<DvpTeleport>('DvpTeleport');
  });

  // Maps `sharedId` -> the SwapCompleted/SwapInitiated event scan results.
  // Both events index `sharedId` as topic 1, so we can server-side filter.
  async function classifySwap(
    teleport: DvpTeleport,
    sharedId: string,
    fromBlock: number,
  ): Promise<'completed' | 'initiated' | 'none'> {
    const completed = await teleport.queryFilter(
      teleport.filters.SwapCompleted(sharedId),
      fromBlock,
    );
    if (completed.length > 0) return 'completed';

    const initiated = await teleport.queryFilter(
      teleport.filters.SwapInitiated(sharedId),
      fromBlock,
    );
    return initiated.length > 0 ? 'initiated' : 'none';
  }

  it(`TPS for ${totalSwaps} batched Dvp swap transactions with isolated resources`, async function () {
    this.timeout(testTimeout);

    LOGGER.log(`Starting Dvp batch swap performance test with isolated resources`);

    const swapExecutions: SwapExecution[] = [];

    // Pre-generate all shared IDs and swap data with isolated resources
    LOGGER.log(`Preparing ${totalSwaps} swap transactions with isolated resources...`);
    for (let i = 1; i <= totalSwaps; i++) {
      const sharedId = generateRandomHash();
      swapExecutions.push({
        id: i,
        nftId: 1, // Each collection has NFT ID 1
        sharedId: sharedId,
        enygmaToken: enygmaTokens[i-1],    // Dedicated enygma token
        nftCollection: nftCollections[i-1], // Dedicated NFT collection
        startTime: 0 // Will be set during batch sending
      });
    }

    // Log resource assignments for debugging
    const resourceSummary = swapExecutions.map(s => `${s.id}:[${s.enygmaToken.symbol}↔${s.nftCollection.symbol}]`).join(', ');
    LOGGER.log(`Resource assignments: [${resourceSummary}]`);

    // Log detailed resource IDs for first swap to debug potential conflicts
    LOGGER.log(`Swap 1 detailed info:`);
    LOGGER.log(`  SharedId: ${swapExecutions[0].sharedId}`);
    LOGGER.log(`  Enygma ResourceId: ${swapExecutions[0].enygmaToken.resourceId}`);
    LOGGER.log(`  NFT ResourceId: ${swapExecutions[0].nftCollection.resourceId}`);

    let successfulNftSides = 0;
    let successfulEnygmaSides = 0;
    let failedNftSides = 0;
    let failedEnygmaSides = 0;

    // Capture the Hub block height before sending so event scans only see this
    // run's events. SwapInitiated and SwapCompleted both have `sharedId` as the
    // first indexed topic, so server-side filtering is exact.
    const eventScanFromBlock = await privateHub.provider.getBlockNumber();

    // Start timing from first batch
    const testStartTime = Date.now();
    LOGGER.log(`Test started at: ${formatTimestamp(new Date(testStartTime))}`);

    // BATCH 1: Send all NFT-side swaps
    LOGGER.log(`Sending batch 1: ${totalSwaps} NFT-side swap transactions...`);
    let nftNonce = await privacyNodes.B.provider.getTransactionCount(nftCollections[0].userWallet.address);

    for (let i = 0; i < totalSwaps; i++) {
      const swap = swapExecutions[i];
      swap.startTime = Date.now(); // Set start time for first transaction of the pair

      try {
        const result = await sendNftSideSwap(
          swap.id,
          swap.nftId,
          swapAmount,
          swap.sharedId,
          nftNonce,
          swap.enygmaToken,
          swap.nftCollection
        );
        if (result.txHash !== '') {
          successfulNftSides++;
          nftNonce++;
        }
      } catch (error) {
        LOGGER.error(`NFT-side swap ${swap.id} failed: ${error}`);
        failedNftSides++;
        nftNonce++;
      }
    }

    const nftBatchEndTime = Date.now();
    const nftBatchDuration = (nftBatchEndTime - testStartTime) / 1000;
    LOGGER.log(`NFT-side batch completed in ${nftBatchDuration.toFixed(2)}s`);
    LOGGER.log(`Successful NFT-side sends: ${successfulNftSides}/${totalSwaps}`);

    // BATCH 2: Send all EnygmaWrapper-side swaps
    LOGGER.log(`Sending batch 2: ${totalSwaps} Enygma-side swap transactions...`);
    let enygmaNonce = await privacyNodes.A.provider.getTransactionCount(enygmaTokens[0].userWallet.address);

    for (let i = 0; i < totalSwaps; i++) {
      const swap = swapExecutions[i];

      try {
        const result = await sendEnygmaSideSwap(
          swap.id,
          swap.nftId,
          swapAmount,
          swap.sharedId,
          enygmaNonce,
          swap.enygmaToken,
          swap.nftCollection
        );
        if (result.txHash !== '') {
          successfulEnygmaSides++;
          enygmaNonce++;
        }
      } catch (error) {
        LOGGER.error(`Enygma-side swap ${swap.id} failed: ${error}`);
        failedEnygmaSides++;
        enygmaNonce++;
      }

    }

    const enygmaBatchEndTime = Date.now();
    const enygmaBatchDuration = (enygmaBatchEndTime - testStartTime) / 1000;
    const totalBatchingTime = (enygmaBatchEndTime - testStartTime) / 1000;

    LOGGER.log(`Both batches completed in ${totalBatchingTime.toFixed(2)}s`);
    LOGGER.log(`Successful NFT-side sends: ${successfulNftSides}/${totalSwaps}`);
    LOGGER.log(`Successful Enygma-side sends: ${successfulEnygmaSides}/${totalSwaps}`);

    // Calculate expected number of successful swaps
    const expectedSwaps = Math.min(successfulNftSides, successfulEnygmaSides);
    if (expectedSwaps === 0) {
      throw new Error('No complete swaps were executed successfully');
    }

    // Monitor for swap completion (both sides confirmed)
    LOGGER.log(`Monitoring for completion of ${expectedSwaps} swaps (waiting for both sides to confirm)...`);

    let completedSwaps = 0;
    let lastProgressTime = testStartTime;
    let actualCompletionTime = testStartTime;
    const maxInactivityTimeMs = 120 * 1000; // 2 minutes of no progress before giving up

    let allSwapsExecuted = false;
    const pollingInterval = 2000; // Check every 2 seconds

    while (!allSwapsExecuted && completedSwaps < expectedSwaps) {
      try {
        // Check for completion of pending swaps by querying DvpTeleport.SwapCompleted
        // events filtered server-side by sharedId. Presence of one such event means
        // the responder side has settled, i.e. the old "2/2 executions" condition.
        for (const swap of swapExecutions) {
          if (!swap.executionTime) {
            const completedEvents = await dvpTeleport.queryFilter(
              dvpTeleport.filters.SwapCompleted(swap.sharedId),
              eventScanFromBlock,
            );

            if (completedEvents.length > 0) {
              const executionTime = Date.now();
              swap.executionTime = executionTime;
              swap.executionDuration = executionTime - swap.startTime;
              completedSwaps++;

              actualCompletionTime = executionTime;
              lastProgressTime = executionTime;

              LOGGER.log(`Swap ${swap.id} (${swap.enygmaToken.symbol}↔${swap.nftCollection.symbol}): Both sides confirmed in ${(swap.executionDuration / 1000).toFixed(4)}s`);
            }
          }
        }

        const elapsedTime = Date.now() - testStartTime;
        const currentTPS = completedSwaps / (elapsedTime / 1000);

        // Show execution status summary every 15 seconds
        if (Math.floor(elapsedTime / 15000) > Math.floor((elapsedTime - pollingInterval) / 15000)) {
          const executionSummary = await Promise.all(
            swapExecutions.map(async (swap) => {
              if (swap.executionTime) return `${swap.id}:✓`;
              const state = await classifySwap(dvpTeleport, swap.sharedId, eventScanFromBlock);
              switch (state) {
                case 'completed': return `${swap.id}:2/2`;
                case 'initiated': return `${swap.id}:1/2`;
                case 'none':      return `${swap.id}:0/2`;
              }
            })
          );
          LOGGER.log(`Execution status: [${executionSummary.join(', ')}]`);
        }

        LOGGER.log(`Progress: ${completedSwaps}/${expectedSwaps} swaps completed (both sides confirmed), Elapsed: ${Math.round(elapsedTime / 1000)}s, TPS: ${currentTPS.toFixed(2)}`);

        // Check if all expected swaps are executed (2/2)
        if (completedSwaps >= expectedSwaps) {
          allSwapsExecuted = true;
          break;
        }

        // Check for timeout condition
        if (Date.now() - lastProgressTime > maxInactivityTimeMs) {
          const inactivityTime = Math.round((Date.now() - lastProgressTime) / 1000);
          LOGGER.log(`Stopping after ${inactivityTime}s of inactivity. Completed: ${completedSwaps} swaps`);
          break;
        }

        // Wait before next polling cycle
        await new Promise(resolve => setTimeout(resolve, pollingInterval));

      } catch (error) {
        LOGGER.error(`Error during execution monitoring: ${error}`);
        await new Promise(resolve => setTimeout(resolve, pollingInterval));
      }
    }

    // Performance calculations
    const effectiveDuration = (actualCompletionTime - testStartTime) / 1000;
    const totalPollingDuration = (Date.now() - testStartTime) / 1000;
    const TPS = completedSwaps / effectiveDuration;

    // Calculate swap execution statistics
    const completedExecutionDurations = swapExecutions
      .filter(s => s.executionDuration !== undefined)
      .map(s => s.executionDuration!);

    const avgExecutionDuration = completedExecutionDurations.length > 0 ?
      completedExecutionDurations.reduce((a, b) => a + b, 0) / completedExecutionDurations.length : 0;
    const minExecutionDuration = completedExecutionDurations.length > 0 ? Math.min(...completedExecutionDurations) : 0;
    const maxExecutionDuration = completedExecutionDurations.length > 0 ? Math.max(...completedExecutionDurations) : 0;

    // Log results
    LOGGER.log(`=== Dvp Swap Performance Results (Both Sides Confirmed Verification) ===`);
    LOGGER.log(`Total batching time: ${totalBatchingTime.toFixed(2)}s (${successfulNftSides} NFT + ${successfulEnygmaSides} Enygma sides sent)`);
    LOGGER.log(`Effective Duration: ${effectiveDuration.toFixed(2)}s (last swap both sides confirmed)`);
    LOGGER.log(`Total Polling Duration: ${totalPollingDuration.toFixed(2)}s (including timeout wait)`);
    LOGGER.log(`Swaps completed (both sides confirmed): ${completedSwaps}/${expectedSwaps}`);
    LOGGER.log(`TPS: ${TPS.toFixed(2)} (based on effective duration)`);
    LOGGER.log(`Average execution time: ${(avgExecutionDuration / 1000).toFixed(4)}s`);
    LOGGER.log(`Execution time range: ${(minExecutionDuration / 1000).toFixed(4)}s - ${(maxExecutionDuration / 1000).toFixed(4)}s`);

    // Generate simplified performance report
    const performanceData = {
      testType: 'Dvp Swap Performance Test',
      startTime: testStartTime,
      endTime: actualCompletionTime,
      transactionCount: totalSwaps,
      actualTPS: TPS.toFixed(2),
      duration: effectiveDuration,
      totalPollingDuration: totalPollingDuration,
      successfulTransactions: completedSwaps,
      failedTransactions: totalSwaps - Math.min(successfulNftSides, successfulEnygmaSides),
      avgExecutionTime: avgExecutionDuration / 1000,
      totalBatchingTime: totalBatchingTime,
      rpnCount: 2,
      rpcUrlA: privacyNodes.A.rpcUrl,
      rpcUrlB: privacyNodes.B.rpcUrl,
      methodology: `This test measures how quickly the Dvp system can process atomic swaps between digital assets. Each swap involves two parties: one sending an NFT and another sending Enygma tokens. We send ${totalSwaps} swap requests in batches and measure completion when both parties' transactions have been successfully processed by the system. The timer starts when we begin sending swap requests and stops when the last swap shows "both sides confirmed" status, indicating that both the NFT sender and token sender have successfully committed to their exchange.`
    };

    const reporter = new JsonReporter();
    await reporter.generateReport(performanceData);
  });

  function formatTimestamp(date: Date): string {
    return date.toTimeString().substring(0, 8);
  }

});
