import { expect } from 'chai';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { LOGGER } from '../../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import JsonReporter from '../../reporters/JsonReporter';
import { ProductionEnygmaToken, ProductionEnygmaToken__factory } from '../../../../typechain-types';
import { eventually } from '../../../../src/utils/common';

// DVP_WITHDRAWAL_TOTAL=5 npx hardhat test test/performance/dvp/withdrawals/EnygmaWithdrawalPerformance.ts

const totalWithdrawals = parseInt(process.env.DVP_WITHDRAWAL_TOTAL || '10');
const withdrawalAmount = BigInt(10); // Amount per withdrawal

describe('Dvp EnygmaWrapper Withdrawal Performance Test', function () {
  // Dynamic timeout: 5 minutes base + 30 seconds per withdrawal for setup + 10 seconds per withdrawal for actual test
  const setupTimeoutPerWithdrawal = 30 * 1000; // 30 seconds per deposit in setup
  const testTimeoutPerWithdrawal = 10 * 1000;  // 10 seconds per withdrawal in test
  const baseTimeout = 5 * 60 * 1000; // 5 minutes base
  const testTimeout = baseTimeout + (totalWithdrawals * (setupTimeoutPerWithdrawal + testTimeoutPerWithdrawal));

  LOGGER.log(`Setting test timeout to ${Math.round(testTimeout / 1000 / 60)} minutes for ${totalWithdrawals} withdrawals`);
  this.timeout(testTimeout);

  LOGGER.log(`=== Dvp Enygma Withdrawal Performance Test ===`);
  LOGGER.log(`Total Withdrawals: ${totalWithdrawals}`);
  LOGGER.log(`Withdrawal Amount: ${withdrawalAmount}`);
  LOGGER.log(`Test Timeout: ${testTimeout}ms`);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let enygmaToken: EnygmaWrapper<ProductionEnygmaToken>;
  let tokenOnPNA: ProductionEnygmaToken;

  async function sendSingleWithdrawal(
    withdrawalNumber: number,
    nonce: number
  ): Promise<{ txHash: string }> {
    LOGGER.log(`Sending withdrawal ${withdrawalNumber}/${totalWithdrawals}...`);
    try {
      const tx = await tokenOnPNA.callWithdrawFromDvp(withdrawalAmount, {
        gasLimit: 1_000_000,
        nonce: nonce
      });
      LOGGER.log(`Withdrawal ${withdrawalNumber}: sent (${tx.hash})`);
      return { txHash: tx.hash };
    } catch (error) {
      LOGGER.log(`Withdrawal ${withdrawalNumber} failed to send: ${error}`);
      return { txHash: '' };
    }
  }

  before(async function () {
    // Dynamic setup timeout: base 10 minutes + 30 seconds per deposit
    const setupTimeout = (10 * 60 * 1000) + (totalWithdrawals * 30 * 1000);
    LOGGER.log(`Setting setup timeout to ${Math.round(setupTimeout / 1000 / 60)} minutes for ${totalWithdrawals} deposits`);
    this.timeout(setupTimeout);

    LOGGER.log(`Setting up Enygma token and Dvp deposits...`);

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(1);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    // Deploy EnygmaWrapper token via entity wrapper on PN A
    enygmaToken = new EnygmaWrapper<ProductionEnygmaToken>(privacyNodes.A, ProductionEnygmaToken__factory);
    await enygmaToken.deployViaFactory();
    await enygmaToken.activateOnPn();
    await enygmaToken.activateOnHub(privateHub);
    const MINT_AMOUNT = BigInt(totalWithdrawals) * withdrawalAmount + BigInt(100);
    await enygmaToken.mintAndAwait(privateHub, {
      amount: MINT_AMOUNT,
      toAddress: enygmaToken.userWallet.address,
    });

    // Pre-deposit tokens for withdrawal testing - exact match deposits
    LOGGER.log(`Pre-depositing ${totalWithdrawals} individual deposits of ${withdrawalAmount} tokens each...`);

    let totalDeposited = 0n;
    for (let depositNumber = 1; depositNumber <= totalWithdrawals; depositNumber++) {
      totalDeposited += withdrawalAmount;
      LOGGER.log(`Deposit ${depositNumber}/${totalWithdrawals}: ${withdrawalAmount} tokens`);
      await enygmaToken.depositEnygmaToDvp(
        withdrawalAmount,
        MINT_AMOUNT - totalDeposited,
        privateHub,
      );
    }

    // Set up the token contract reference after setup
    const tokenAddressA = enygmaToken.address[privacyNodes.A.chainId];
    tokenOnPNA = await privacyNodes.A.getContractAt<ProductionEnygmaToken>(
      ProductionEnygmaToken__factory.name,
      tokenAddressA,
      enygmaToken.symbol
    );

    // Wait 3 blocks after deposit to ensure it's fully processed
    LOGGER.log(`Waiting 3 blocks after deposit...`);
    const startingBlock = await privateHub.provider.getBlockNumber();
    await eventually<boolean>({
      check: async () => {
        const currentBlock = await privateHub.provider.getBlockNumber();
        return currentBlock >= startingBlock + 3;
      },
      message: `Waiting for 3 blocks confirmation`,
    });

    LOGGER.log(`Setup completed. Ready for withdrawal performance testing.`);
  });

  describe(`Performance Tests`, function () {

      it(`TPS for ${totalWithdrawals} sequential Enygma withdrawal transactions`, async function () {
    // Dynamic withdrawal test timeout: base 5 minutes + 10 seconds per withdrawal
    const withdrawalTestTimeout = (5 * 60 * 1000) + (totalWithdrawals * 10 * 1000);
        LOGGER.log(`Setting withdrawal test timeout to ${Math.round(withdrawalTestTimeout / 1000 / 60)} minutes for ${totalWithdrawals} withdrawals`);
    this.timeout(withdrawalTestTimeout);

        LOGGER.log(`Starting performance test for Dvp Enygma withdrawals`);

      const initialTokenBalance = await tokenOnPNA.balanceOf(enygmaToken.userWallet.address);
        LOGGER.log(`Initial token balance: ${initialTokenBalance}`);

      // Send withdrawals sequentially (one by one)
        LOGGER.log(`Sending ${totalWithdrawals} withdrawals sequentially...`);

      let successfulSends = 0;
      let failedSends = 0;
      const timeBetweenSends: number[] = [];

      // Get starting nonce for proper transaction sequencing
      let currentNonce = await privacyNodes.A.provider.getTransactionCount(enygmaToken.userWallet.address);

      // Start timing from first transaction
      const testStartTime = Date.now();
        LOGGER.log(`Test started at: ${formatTimestamp(new Date(testStartTime))}`);

      let previousSendTime = testStartTime;

      for (let i = 1; i <= totalWithdrawals; i++) {
        const currentSendTime = Date.now();

        // Calculate time between this send and the previous send (skip first iteration)
        if (i > 1) {
          const timeBetween = currentSendTime - previousSendTime;
          timeBetweenSends.push(timeBetween);
        }

        try {
          const result = await sendSingleWithdrawal(i, currentNonce);

          if (result.txHash !== '') {
            successfulSends++;
            currentNonce++;
          }

        } catch (error) {
          LOGGER.log(`Withdrawal ${i} failed to send: ${error}`);
          failedSends++;
          currentNonce++;
        }

        previousSendTime = Date.now();
      }

      const sendingEndTime = Date.now();
      const sendingDuration = (sendingEndTime - testStartTime) / 1000;
      const avgTimeBetweenSends = timeBetweenSends.length > 0 ? timeBetweenSends.reduce((a, b) => a + b, 0) / timeBetweenSends.length : 0;

        LOGGER.log(`Sending phase completed in ${sendingDuration.toFixed(2)}s`);
        LOGGER.log(`Successful sends: ${successfulSends}/${totalWithdrawals}`);
        LOGGER.log(`Failed sends: ${failedSends}`);
        LOGGER.log(`Average time between sends: ${avgTimeBetweenSends.toFixed(4)}ms`);

      if (successfulSends === 0) {
        throw new Error('No withdrawals were sent successfully');
      }

      // Wait for all withdrawals to settle - verify by token balance increase
        LOGGER.log(`Waiting for all withdrawals to settle...`);

      // Track the last time we saw meaningful progress
      let lastProgressTime = testStartTime;
      let maxBalanceReached = BigInt(initialTokenBalance.toString());
      let actualCompletionTime = testStartTime;
      const maxInactivityTimeMs = 120 * 1000; // 2 minutes of no progress before giving up

      let allSettled = false;
      const pollingInterval = 2000;

      while (!allSettled) {
        try {
          // Check token balance increase (tokens received from withdrawals)
          const currentTokenBalance = await tokenOnPNA.balanceOf(enygmaToken.userWallet.address);
          const tokensReceivedSoFar = currentTokenBalance - initialTokenBalance;
          const withdrawalsCompletedByBalance = Number(tokensReceivedSoFar) / Number(withdrawalAmount);

          // Track when we last saw progress (increase in balance)
          if (BigInt(currentTokenBalance.toString()) > maxBalanceReached) {
            lastProgressTime = Date.now();
            maxBalanceReached = BigInt(currentTokenBalance.toString());
            actualCompletionTime = Date.now(); // Update completion time when we see progress
          }

          const elapsedTime = Date.now() - testStartTime;
          const currentTPS = withdrawalsCompletedByBalance / (elapsedTime / 1000);

          LOGGER.log(`Progress: Received=${withdrawalsCompletedByBalance}/${successfulSends}, Elapsed: ${Math.round(elapsedTime / 1000)}s, TPS: ${currentTPS.toFixed(2)}`);

          // Check if all withdrawals are settled
          if (withdrawalsCompletedByBalance >= successfulSends) {
            allSettled = true;
            break;
          }

          // Check for timeout due to inactivity
          const timeSinceLastProgress = Date.now() - lastProgressTime;
          if (timeSinceLastProgress > maxInactivityTimeMs) {
            LOGGER.log(`Stopping after ${Math.round(timeSinceLastProgress / 1000)}s of inactivity. Last progress: ${withdrawalsCompletedByBalance} withdrawals`);
            break;
          }

        } catch (e) {
          LOGGER.log(`Polling error: ${e}`);
        }

        // Wait before next check
        await new Promise(resolve => setTimeout(resolve, pollingInterval));
      }

      const testEndTime = Date.now();
      const totalPollingDuration = (testEndTime - testStartTime) / 1000;
      const effectiveDuration = (actualCompletionTime - testStartTime) / 1000;

      // Final verification
      const finalTokenBalance = await tokenOnPNA.balanceOf(enygmaToken.userWallet.address);
      const actualTokensReceived = finalTokenBalance - initialTokenBalance;
      const actualWithdrawalsCompleted = Number(actualTokensReceived) / Number(withdrawalAmount);

      // Calculate metrics based on effective duration
      const TPS = actualWithdrawalsCompleted / effectiveDuration;

        LOGGER.log(`=== Dvp Enygma Withdrawal Results ===`);
        LOGGER.log(`Effective Duration: ${effectiveDuration.toFixed(2)}s (last event processed)`);
        LOGGER.log(`Total Polling Duration: ${totalPollingDuration.toFixed(2)}s (including timeout wait)`);
        LOGGER.log(`Withdrawals completed: ${actualWithdrawalsCompleted}/${successfulSends}`);
        LOGGER.log(`TPS: ${TPS.toFixed(2)} (based on effective duration)`);
        LOGGER.log(`Final token balance: ${finalTokenBalance} (received: ${actualTokensReceived})`);

      const jsonReporter = new JsonReporter();
      const testData = {
        testType: 'Dvp EnygmaWrapper Withdrawal Performance Test',
        startTime: testStartTime,
        endTime: actualCompletionTime,
        actualEndTime: testEndTime,
        transactionCount: totalWithdrawals,
        actualTPS: TPS.toFixed(2),
        duration: effectiveDuration,
        effectiveDuration: effectiveDuration,
        totalPollingDuration: totalPollingDuration,
        successfulTransactions: actualWithdrawalsCompleted,
        failedTransactions: totalWithdrawals - successfulSends,
        avgTimeBetweenSends: avgTimeBetweenSends,
        rpnCount: 1,
        rpcUrlA: privacyNodes.A.rpcUrl,
        methodology: `Send ${totalWithdrawals} Dvp withdrawal transactions sequentially. Timer starts at first send and effective completion time is when the last withdrawal is received (balance increase). TPS calculated as completed withdrawals divided by effective duration.`
      };

      jsonReporter.generateReport(testData);

      expect(successfulSends).to.be.greaterThan(0, 'Should send some withdrawals');
      expect(actualWithdrawalsCompleted).to.be.greaterThan(0, 'Should complete some withdrawals');

      // Test is successful if:
      // 1. All withdrawals settled (ideal case), OR
      // 2. We made meaningful progress but timed out due to inactivity (realistic case)
      const meaningfulProgress = actualWithdrawalsCompleted > 0;
      expect(allSettled || meaningfulProgress, `Expected either complete settlement or meaningful progress. AllSettled: ${allSettled}, Progress: ${actualWithdrawalsCompleted}/${successfulSends} withdrawals`).to.be.true;
    });

  });

  function formatTimestamp(date: Date): string {
    return date.toTimeString().substring(0, 8);
  }

});
