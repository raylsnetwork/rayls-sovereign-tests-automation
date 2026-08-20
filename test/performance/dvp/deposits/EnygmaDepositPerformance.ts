import { expect } from 'chai';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { DEFAULT_TIMEOUT, LOGGER } from '../../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import JsonReporter from '../../reporters/JsonReporter';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
  EnygmaV1,
  DvpTeleport,
} from '../../../../typechain-types';


// DVP_DEPOSIT_TOTAL=50 npx hardhat test test/performance/dvp/deposits/EnygmaDepositPerformance.ts

const totalDeposits = parseInt(process.env.DVP_DEPOSIT_TOTAL || '10');
const depositAmount = BigInt(10); // Amount per deposit

describe('Dvp EnygmaWrapper Deposit Performance Test', function () {
  const testTimeout = Math.max(30 * 60 * 1000, totalDeposits * 15 * 1000);
  this.timeout(testTimeout);

  LOGGER.log(`=== Dvp Enygma Deposit Performance Test ===`);
  LOGGER.log(`Total Deposits: ${totalDeposits}`);
  LOGGER.log(`Deposit Amount: ${depositAmount}`);
  LOGGER.log(`Test Timeout: ${testTimeout}ms`);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  let tokenOnPNA: ProductionEnygmaToken;
  let dvpTeleport : DvpTeleport;
  let enygmaToken: EnygmaWrapper<ProductionEnygmaToken>;

  async function sendSingleDeposit(
    depositNumber: number,
    nonce: number
  ): Promise<{ txHash: string }> {
    LOGGER.log(`Sending deposit ${depositNumber}/${totalDeposits}...`);
    try {
      const tx = await tokenOnPNA.depositToDvp(depositAmount, {
        gasLimit: 1_000_000,
        nonce: nonce
      });
      LOGGER.log(`Deposit ${depositNumber}: sent (${tx.hash})`);
      return { txHash: tx.hash };
    } catch (error) {
      LOGGER.error(`Deposit ${depositNumber} failed to send: ${error}`);
      return { txHash: '' };
    }
  }

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(1);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    // Deploy EnygmaWrapper token via entity wrapper on PN A
    enygmaToken = new EnygmaWrapper<ProductionEnygmaToken>(privacyNodes.A, ProductionEnygmaToken__factory);
    await enygmaToken.deployViaFactory();
    await enygmaToken.activateOnPn();
    await enygmaToken.activateOnHub(privateHub);
    const mintAmount = BigInt(totalDeposits) * depositAmount + BigInt(10);
    await enygmaToken.mintAndAwait(privateHub, {
      amount: mintAmount,
      toAddress: enygmaToken.userWallet.address,
    });
    // Get Dvp contract
    dvpTeleport = privateHub.getContract<DvpTeleport>('DvpTeleport');
  });

  it(`TPS for ${totalDeposits} sequential Enygma deposit transactions`, async function () {
      this.timeout(testTimeout);

      LOGGER.log(`Starting performance test for Dvp Enygma deposits`);

      const tokenAddressA = enygmaToken.address[privacyNodes.A.chainId];
      tokenOnPNA = await privacyNodes.A.getContractAt<ProductionEnygmaToken>(
        ProductionEnygmaToken__factory.name,
        tokenAddressA,
        enygmaToken.symbol
      );

      const initialTokenBalance = await tokenOnPNA.balanceOf(enygmaToken.userWallet.address);
      LOGGER.log(`Initial token balance: ${initialTokenBalance}`);

      const startBlockNumber = await privateHub.provider.getBlockNumber();
      LOGGER.log(`Monitoring settlements from block ${startBlockNumber}...`);

      LOGGER.log(`Sending ${totalDeposits} deposits sequentially...`);

      let successfulSends = 0;
      let failedSends = 0;
      const timeBetweenSends: number[] = [];

      // Get starting nonce for proper transaction sequencing
      let currentNonce = await privacyNodes.A.provider.getTransactionCount(enygmaToken.userWallet.address);

      // Start timing from first transaction
      const testStartTime = Date.now();
      LOGGER.log(`Test started at: ${formatTimestamp(new Date(testStartTime))}`);

      let previousSendTime = testStartTime;

      for (let i = 1; i <= totalDeposits; i++) {
        const currentSendTime = Date.now();

        // Calculate time between this send and the previous send (skip first iteration)
        if (i > 1) {
          const timeBetween = currentSendTime - previousSendTime;
          timeBetweenSends.push(timeBetween);
        }

        try {
          const result = await sendSingleDeposit(i, currentNonce);

          if (result.txHash !== '') {
            successfulSends++;
            currentNonce++;
          }

        } catch (error) {
          LOGGER.error(`Deposit ${i} failed to send: ${error}`);
          failedSends++;
          currentNonce++;
        }

        previousSendTime = Date.now();
      }

      const sendingEndTime = Date.now();
      const sendingDuration = (sendingEndTime - testStartTime) / 1000;
      const avgTimeBetweenSends = timeBetweenSends.length > 0 ? timeBetweenSends.reduce((a, b) => a + b, 0) / timeBetweenSends.length : 0;

      LOGGER.log(`Sending phase completed in ${sendingDuration.toFixed(2)}s`);
      LOGGER.log(`Successful sends: ${successfulSends}/${totalDeposits}`);
      LOGGER.log(`Failed sends: ${failedSends}`);
      LOGGER.log(`Average time between sends: ${avgTimeBetweenSends.toFixed(4)}ms`);

      if (successfulSends === 0) {
        throw new Error('No deposits were sent successfully');
      }

      LOGGER.log(`Waiting for all deposits to settle...`);

      // Track the last time we saw meaningful progress
      let lastProgressTime = testStartTime;
      let lastCommitmentCount = 0;
      let maxCommitmentsReached = 0;
      let actualCompletionTime = testStartTime;
      const maxInactivityTimeMs = 120 * 1000; // 2 minutes of no progress before giving up

      let allSettled = false;
      const pollingInterval = 2000;

      while (!allSettled) {
        try {
          // Check 1: Token balance (tokens should be burned)
          const currentTokenBalance = await tokenOnPNA.balanceOf(enygmaToken.userWallet.address);
          const tokensDepositedSoFar = initialTokenBalance - currentTokenBalance;
          const depositsCompletedByBalance = Number(tokensDepositedSoFar) / Number(depositAmount);

          // Check 2: Dvp Commitments events (proper settlement verification)
          const enygmaTokenAddress = await privateHub.getContract<EnygmaV1>(enygmaToken.symbol+'CC').getAddress();

          const commitmentsFilter = dvpTeleport.filters.Commitments(enygmaTokenAddress);
          const currentBlockNumber = await privateHub.provider.getBlockNumber();

          const logs = await dvpTeleport.queryFilter(
            commitmentsFilter,
            Math.max(0, startBlockNumber - 10),
            currentBlockNumber
          );

          // Count commitment events since we started
          const relevantCommitments = logs.filter((log: any) => {
            return log.args && log.args[3] && log.args[3].length > 0;
          });

          // Sum the number of commitments across all events (each event can include multiple commitments)
          const depositsCompletedByEvents = relevantCommitments.reduce((sum: number, log: any) => {
            const commitments = Array.isArray(log.args[3]) ? log.args[3] : [];
            return sum + commitments.length;
          }, 0);

          // Track when we last saw progress (increase in commitments count)
          if (depositsCompletedByEvents > lastCommitmentCount) {
            lastProgressTime = Date.now();
            lastCommitmentCount = depositsCompletedByEvents;
            actualCompletionTime = Date.now(); // Update completion time when we see progress
          }

          maxCommitmentsReached = Math.max(maxCommitmentsReached, depositsCompletedByEvents);

          const elapsedTime = Date.now() - testStartTime;
          const currentTPS = Math.min(depositsCompletedByBalance, depositsCompletedByEvents) / (elapsedTime / 1000);

          LOGGER.log(`Progress: Burned=${depositsCompletedByBalance}/${successfulSends}, Commitments=${depositsCompletedByEvents}/${successfulSends}, Elapsed: ${Math.round(elapsedTime / 1000)}s, TPS: ${currentTPS.toFixed(2)}`);

          // Check if all deposits are settled (both conditions must be met)
          if (depositsCompletedByBalance >= successfulSends && depositsCompletedByEvents >= successfulSends) {
            allSettled = true;
            break;
          }

          // Check for timeout due to inactivity
          const timeSinceLastProgress = Date.now() - lastProgressTime;
          if (timeSinceLastProgress > maxInactivityTimeMs && maxCommitmentsReached > 0) {
            LOGGER.log(`Stopping after ${Math.round(timeSinceLastProgress / 1000)}s of inactivity. Last progress: ${maxCommitmentsReached} commitments`);
            break;
          }

        } catch (e) {
          LOGGER.error(`Polling error: ${e}`);
        }

        // Wait before next check
        await new Promise(resolve => setTimeout(resolve, pollingInterval));
      }

      const testEndTime = Date.now();
      const totalPollingDuration = (testEndTime - testStartTime) / 1000;
      const effectiveDuration = (actualCompletionTime - testStartTime) / 1000;

      // Final verification - get actual settled deposits from Dvp commitments
      const finalTokenBalance = await tokenOnPNA.balanceOf(enygmaToken.userWallet.address);
      const actualTokensDeposited = initialTokenBalance - finalTokenBalance;
      const tokensBurnedCount = Number(actualTokensDeposited) / Number(depositAmount);

      // Use the actual settled commitments as the true success count
      const actualDepositsCompleted = maxCommitmentsReached;

      // Calculate metrics based on effective duration
      const TPS = actualDepositsCompleted / effectiveDuration;

      LOGGER.log(`=== Dvp Enygma Deposit Results ===`);
      LOGGER.log(`Effective Duration: ${effectiveDuration.toFixed(2)}s (last event processed)`);
      LOGGER.log(`Total Polling Duration: ${totalPollingDuration.toFixed(2)}s (including timeout wait)`);
      LOGGER.log(`Deposits completed: ${actualDepositsCompleted}/${successfulSends} (Dvp commitments)`);
      LOGGER.log(`Tokens burned: ${tokensBurnedCount}/${successfulSends} (balance reduction)`);
      LOGGER.log(`TPS: ${TPS.toFixed(2)} (based on effective duration)`);
      LOGGER.log(`Final token balance: ${finalTokenBalance} (deposited: ${actualTokensDeposited})`);

      const jsonReporter = new JsonReporter();
      const testData = {
        testType: 'Dvp EnygmaWrapper Deposit Performance Test',
        startTime: testStartTime,
        endTime: actualCompletionTime,
        actualEndTime: testEndTime,
        transactionCount: totalDeposits,
        actualTPS: TPS.toFixed(2),
        duration: effectiveDuration,
        effectiveDuration: effectiveDuration,
        totalPollingDuration: totalPollingDuration,
        successfulTransactions: actualDepositsCompleted,
        failedTransactions: totalDeposits - successfulSends,
        maxCommitmentsReached: maxCommitmentsReached,
        avgTimeBetweenSends: avgTimeBetweenSends,
        rpnCount: 1,
        rpcUrlA: privacyNodes.A.rpcUrl,
        methodology: `Send ${totalDeposits} Dvp deposit transactions sequentially. Timer starts at first send and effective completion time is when the last Dvp Commitments event was processed. TPS calculated as completed deposits divided by effective duration.`
      };

      jsonReporter.generateReport(testData);

      expect(successfulSends).to.be.greaterThan(0, 'Should send some deposits');
      expect(actualDepositsCompleted).to.be.greaterThan(0, 'Should complete some deposits');

      // Test is successful if:
      // 1. All deposits settled (ideal case), OR
      // 2. We made meaningful progress but timed out due to inactivity
      const meaningfulProgress = maxCommitmentsReached > 0 && actualDepositsCompleted > 0;
      expect(allSettled || meaningfulProgress, `Expected either complete settlement or meaningful progress. AllSettled: ${allSettled}, Progress: ${actualDepositsCompleted}/${successfulSends} deposits, ${maxCommitmentsReached} commitments`).to.be.true;
    });

  function formatTimestamp(date: Date): string {
    return date.toTimeString().substring(0, 8);
  }

});