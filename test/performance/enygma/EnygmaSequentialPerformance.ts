import { expect } from 'chai';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { EnygmaWrapper } from '../../../src/entities/tokens/EnygmaWrapper';
import { DEFAULT_TIMEOUT, LOGGER } from '../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { shouldCrossTransferEnygma } from '../../../src/flows/tokens/token-flows';
import { eventually } from '../../../src/utils/common';
import { shortHex } from '../../../src/utils/formatters';
import JsonReporter from '../reporters/JsonReporter';
import { ProductionEnygmaToken, ProductionEnygmaToken__factory } from '../../../typechain-types';
import { EnygmaCrossTransfer } from '../../../src/types';


// A→B EnygmaWrapper Sequential Performance Test - Real User Simulation
// User sends N transactions one after another, waiting for each to complete
// SEQUENTIAL_TRANSACTIONS=4000 npx hardhat test test/performance/enygma/EnygmaSequentialPerformance.ts

const numberOfTransactions = parseInt(process.env.SEQUENTIAL_TRANSACTIONS || '10');
const amountPerTx = BigInt(1);

describe('Sequential User Behavior Test', function () {
  const testTimeout = Math.max(30 * 60 * 1000, numberOfTransactions * 60 * 1000);
  this.timeout(testTimeout);
  LOGGER.log(`=== Scenario 1: Sequential User Test ===`);
  LOGGER.log(`Number of Transactions: ${numberOfTransactions}`);
  LOGGER.log(`Amount Per Transfer: ${amountPerTx}`);
  LOGGER.log(`Test Timeout: ${testTimeout}ms`);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let enygmaToken: EnygmaWrapper<ProductionEnygmaToken>;

  let tokenOnPNA: ProductionEnygmaToken;
  let tokenOnPNB: ProductionEnygmaToken;

  async function sendSingleTransfer(
    txNumber: number,
    nonce: number
  ): Promise<{ txHash: string }> {
    LOGGER.log(`User sending transaction ${txNumber}/${numberOfTransactions}...`);

    // User sends the transaction with explicit nonce (no waiting)
    const tx = await tokenOnPNA.crossTransfer(
      [enygmaToken.userWallet.address],
      [amountPerTx],
      [privacyNodes.B.chainId],
      [[]],
      {
        gasLimit: 5000000,
        nonce: nonce  // Use explicit nonce to avoid conflicts
      }
    );

    LOGGER.log(`Transaction ${txNumber}: sent (${tx.hash})`);

    return { txHash: tx.hash };
  }

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    // Deploy EnygmaWrapper token via entity wrapper on PN A
    enygmaToken = new EnygmaWrapper<ProductionEnygmaToken>(privacyNodes.A, ProductionEnygmaToken__factory);
    await enygmaToken.deployViaFactory();
    await enygmaToken.activateOnPn();
    await enygmaToken.activateOnHub(privateHub);
    await enygmaToken.mintAndAwait(privateHub, {
      amount: BigInt(numberOfTransactions) * amountPerTx + BigInt(10),
      toAddress: enygmaToken.userWallet.address,
    });
  });

    it(`Should transfer ${amountPerTx} token to PN B for warmup (Transfer #1)`, async function () {
      const transfer: EnygmaCrossTransfer = {
        destinationAddresses: [enygmaToken.userWallet.address],
        amounts: [amountPerTx],
        destinationChainIds: [privacyNodes.B.chainId],
        programData: [[]]
      };

      const expectedBalances = {
        [privacyNodes.B.chainId]: amountPerTx
      };

      const destinations = [privacyNodes.B];

      await shouldCrossTransferEnygma(
        transfer,
        1,
        expectedBalances,
        privateHub,
        privacyNodes.A,
        destinations,
        enygmaToken
      )
    }).timeout(DEFAULT_TIMEOUT);

    it(`Should transfer back ${amountPerTx} token to PN A (Transfer #2)`, async function () {
      const transfer: EnygmaCrossTransfer = {
        destinationAddresses: [enygmaToken.userWallet.address],
        amounts: [amountPerTx],
        destinationChainIds: [privacyNodes.A.chainId],
        programData: [[]]
      };

      const expectedBalances = {
        [privacyNodes.A.chainId]: BigInt(numberOfTransactions) * amountPerTx + BigInt(10)
      };

      const destinations = [privacyNodes.A];

      await shouldCrossTransferEnygma(
        transfer,
        2,
        expectedBalances,
        privateHub,
        privacyNodes.B,
        destinations,
        enygmaToken
      )
    }).timeout(DEFAULT_TIMEOUT);

  it(`Simulates user sending ${numberOfTransactions} transactions sequentially`, async function () {
      this.timeout(testTimeout);

      const N = numberOfTransactions;

    LOGGER.log(`=== User Sending ${N} Transactions One by One ===`);

      const tokenAddressA = enygmaToken.address[privacyNodes.A.chainId];
      const tokenAddressB = enygmaToken.address[privacyNodes.B.chainId];
      tokenOnPNA = await privacyNodes.A.getContractAt<ProductionEnygmaToken>(
        ProductionEnygmaToken__factory.name,
        tokenAddressA,
        enygmaToken.symbol
      );
      tokenOnPNB = await privacyNodes.B.getContractAt<ProductionEnygmaToken>(
        ProductionEnygmaToken__factory.name,
        tokenAddressB,
        enygmaToken.symbol
      );

      // Get initial balances
      const startBalanceA = await tokenOnPNA.balanceOf(enygmaToken.userWallet.address);
      const startBalanceB = await tokenOnPNB.balanceOf(enygmaToken.userWallet.address);

    LOGGER.log(`Initial balances: A=${startBalanceA}, B=${startBalanceB}`);

      // Track sent transactions
      const sentTransactions: Array<{ txHash: string }> = [];
      const sendTimings: number[] = [];

      // Get starting nonce for proper transaction sequencing
      let currentNonce = await privacyNodes.A.provider.getTransactionCount(enygmaToken.userWallet.address);

      // Start timing from first transaction
      const testStartTime = Date.now();
    LOGGER.log(`User sending ${N} transactions...`);

      let previousSendTime = testStartTime;

      for (let i = 1; i <= N; i++) {
        const sendStartTime = Date.now();

        try {
          const result = await sendSingleTransfer(i, currentNonce);
          const sendEndTime = Date.now();

          sentTransactions.push({ txHash: result.txHash });

          // Calculate time since previous send completed (skip first iteration)
          if (i > 1) {
            const timeBetweenSends = sendStartTime - previousSendTime;
            sendTimings.push(timeBetweenSends);
          }

          previousSendTime = sendEndTime;
          currentNonce++;
        } catch (error) {
          LOGGER.error(`Transaction ${i} failed to send: ${error}`);
          const sendEndTime = Date.now();

          sentTransactions.push({ txHash: '' });

          if (i > 1) {
            const timeBetweenSends = sendStartTime - previousSendTime;
            sendTimings.push(timeBetweenSends);
          }

          previousSendTime = sendEndTime;
          currentNonce++;
        }
      }

      const successfulSends = sentTransactions.filter(tx => tx.txHash !== '').length;

      // Calculate and report average time between sends
      const avgTimeBetweenSends = sendTimings.length > 0 ?
        sendTimings.reduce((a, b) => a + b, 0) / sendTimings.length : 0;

    LOGGER.log(`Successful sends: ${successfulSends}/${N}`);
    LOGGER.log(`Average time between sends: ${avgTimeBetweenSends.toFixed(4)}ms`);

      // Wait for all transactions to settle
    LOGGER.log(`Waiting for all transactions to settle...`);
      const expectedFinalBalance = BigInt(startBalanceB) + BigInt(successfulSends) * amountPerTx;

      await eventually<boolean>({
        check: async (): Promise<boolean> => {
          const currentBalance = await tokenOnPNB.balanceOf(enygmaToken.userWallet.address);
          const received = currentBalance - startBalanceB;
          LOGGER.log(`Progress: ${received}/${BigInt(successfulSends)} tokens received`);
          return currentBalance >= expectedFinalBalance;
        },
        interval: 2000,
        attempts: 300,
        message: `Waiting for Enygma sequential settlement: balance B → ${expectedFinalBalance} for ${shortHex(enygmaToken.userWallet.address)} (${successfulSends} sends)`,
        tolerateErrors: true,
      });

      const testEndTime = Date.now();
      const duration = (testEndTime - testStartTime) / 1000;

      // Final verification
      const finalBalanceA = await tokenOnPNA.balanceOf(enygmaToken.userWallet.address);
      const finalBalanceB = await tokenOnPNB.balanceOf(enygmaToken.userWallet.address);
      const actualReceived = finalBalanceB - startBalanceB;

      // Calculate metrics
      const TPS = Number(actualReceived) / duration;

    LOGGER.log(`=== Results ===`);
    LOGGER.log(`Duration: ${duration.toFixed(2)}s`);
    LOGGER.log(`Tokens received: ${actualReceived}/${successfulSends}`);
    LOGGER.log(`TPS: ${TPS.toFixed(2)}`);
    LOGGER.log(`Final balances: A=${finalBalanceA}, B=${finalBalanceB}`);

      const jsonReporter = new JsonReporter();
      const testData = {
        testType: '[Scenario 1] Sequential Transactions Performance Test',
        startTime: testStartTime,
        endTime: testEndTime,
        transactionCount: N,
        actualTPS: TPS.toFixed(2),
        duration: duration,
        successfulTransactions: Number(actualReceived),
        failedTransactions: N - successfulSends,
        avgTimeBetweenSends: avgTimeBetweenSends,
        rpnCount: 2,
        rpcUrlA: privacyNodes.A.rpcUrl,
        methodology: 'User sends N transactions back-to-back without waiting. Timer starts at the first send and stops when all transactions achieve cross-chain finality on the destination chain. TPS is calculated as tokens successfully received divided by the time from the first send to the last settlement (in seconds).'
      };

      jsonReporter.generateReport(testData);

      expect(successfulSends).to.be.greaterThan(0, 'Should send some transactions');
      expect(Number(actualReceived)).to.be.greaterThan(0, 'Should receive some tokens');
    });
});
