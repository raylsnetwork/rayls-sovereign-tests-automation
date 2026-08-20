import { expect } from 'chai';
import type { JsonRpcProvider, HDNodeWallet, TransactionRequest } from 'ethers';
import axios from 'axios';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { ProductionEnygmaToken, ProductionEnygmaToken__factory } from '../../../typechain-types';
import { EnygmaWrapper } from '../../../src/entities/tokens/EnygmaWrapper';
import { DEFAULT_TIMEOUT, LOGGER } from '../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { shouldCrossTransferEnygma } from '../../../src/flows/tokens/token-flows';
import { delay, eventually } from '../../../src/utils/common';
import { shortHex } from '../../../src/utils/formatters';
import JsonReporter from '../reporters/JsonReporter';
import { EnygmaCrossTransfer } from '../../../src/types';

// EnygmaWrapper Stability Test
// This test runs for a specified duration and continuously sends batches of N transactions
// without waiting for individual batch settlement, then validates the final total balance
// ENYGMA_STABILITY_DURATION_MINUTES=1 ENYGMA_STABILITY_BATCH_SIZE=1000 npx hardhat test test/performance/enygma/EnygmaBatchStability.ts

const testDurationMinutes = parseInt(process.env.ENYGMA_STABILITY_DURATION_MINUTES || '1');
const batchSize = parseInt(process.env.ENYGMA_STABILITY_BATCH_SIZE || '100');
const amountPerTx = 1;

const TEST_TIMEOUT = Math.max(testDurationMinutes * 60 * 1000 + 30 * 60 * 1000, 35 * 60 * 1000); // Add 30 minutes buffer for settlement
const TEST_DURATION = testDurationMinutes * 60 * 1000;

describe('EnygmaWrapper Stability Test', function () {
  this.timeout(TEST_TIMEOUT);

  LOGGER.log(`=== Enygma Stability Test Configuration ===`);
  LOGGER.log(`Test Duration: ${testDurationMinutes} minutes`);
  LOGGER.log(`Batch Size: ${batchSize} transactions per batch`);
  LOGGER.log(`Amount Per Transfer: ${amountPerTx}`);
  LOGGER.log(`Test Timeout: ${TEST_TIMEOUT}ms`);

  const MINT_AMOUNT = BigInt(10000000000);
  const TRANSFER_AMOUNT = BigInt(10);
  let privacyNodes: PrivacyNodeMap;

  let privateHub : PrivateHub;

  let enygmaToken: EnygmaWrapper<ProductionEnygmaToken>;

  async function signTransferBatch(
    totalTxs: number,
    tokenContract: ProductionEnygmaToken,
    receiverAddress: string,
    destinationChainId: string,
    provider: JsonRpcProvider,
    signer: HDNodeWallet,
    startingNonce: number,
    batchNumber?: number
  ): Promise<string[]> {
    const { chainId } = await provider.getNetwork();
    let currentNonce = startingNonce;

    const signedRawTxs: string[] = [];

    if (batchNumber != null && batchNumber % 10 === 0) {
      LOGGER.log(`Preparing batch ${batchNumber} of ${totalTxs} transfers...`);
    }

    for (let i = 0; i < totalTxs; i++) {
      const call = await tokenContract.crossTransfer.populateTransaction(
        [receiverAddress],
        [amountPerTx],
        [destinationChainId],
        [[]] // Empty payload
      );

      // Estimate gas for the first transaction to ensure it's reasonable
      let gasLimit = 5_000_000;
      if (i === 0) {
        try {
          const estimatedGas = await tokenContract.crossTransfer.estimateGas(
            [receiverAddress],
            [amountPerTx],
            [destinationChainId],
            [[]]
          );
          gasLimit = Number((estimatedGas * 12n) / 10n); // Add 20% buffer
          if (batchNumber != null && batchNumber % 10 === 0) {
            LOGGER.log(`Estimated gas for crossTransfer: ${estimatedGas}, using: ${gasLimit}`);
          }
        } catch (error) {
          LOGGER.log(`Gas estimation failed for batch ${batchNumber}, using default: ${error}`);
        }
      }

      const txReq: TransactionRequest = {
        ...call,
        from: signer.address,
        nonce: currentNonce,
        gasPrice: 0,
        gasLimit,
        chainId
      };

      const signed = await signer.signTransaction(txReq);
      signedRawTxs.push(signed);
      currentNonce++;
    }

    if (batchNumber != null && batchNumber % 10 === 0) {
      LOGGER.log(
        `Prepared batch ${batchNumber} (nonces ${startingNonce}-${startingNonce + totalTxs - 1})`
      );
    }
    return signedRawTxs;
  }

  async function sendSignedBatchTransactions(
    signedRawTxs: string[],
    rpcUrl: string,
    batchNumber: number
  ) {
    LOGGER.log(`Sending batch ${batchNumber} with ${signedRawTxs.length} transactions...`);

    try {

      // Create JSON-RPC batch payload
      const batchPayload = signedRawTxs.map((signedTx, index) => ({
        jsonrpc: "2.0",
        method: "eth_sendRawTransaction",
        params: [signedTx],
        id: index + 1
      }));

      // Send batch via direct axios call
      const response = await axios.post(rpcUrl, batchPayload, {
        headers: {
          'Content-Type': 'application/json'
        }
      });


      if (response.status === 200) {
        LOGGER.log(`Batch ${batchNumber} sent successfully `);
      } else {
        LOGGER.log(`Batch ${batchNumber} failed: ${response.statusText}`);
      }
    } catch (error) {
      LOGGER.log(`Error sending batch ${batchNumber}: ${error}`);
      throw error;
    }
  }

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const {initializedNodes,
      initializedPNH} = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    enygmaToken = new EnygmaWrapper<ProductionEnygmaToken>(
      privacyNodes.A,ProductionEnygmaToken__factory)

    await enygmaToken.deployViaFactory();
    await enygmaToken.activateOnPn();
    await enygmaToken.activateOnHub(privateHub);
    await enygmaToken.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: enygmaToken.userWallet.address })
  });

    it(
      `Should transfer ${TRANSFER_AMOUNT} tokens to PN B (Transfer #${1})`, async function () {
        const transfer: EnygmaCrossTransfer = {
          destinationAddresses: [enygmaToken.userWallet.address],
          amounts: [TRANSFER_AMOUNT],
          destinationChainIds: [privacyNodes.B.chainId],
          programData: [[]]
        };

        const expectedBalances = {
          [privacyNodes.B.chainId]: TRANSFER_AMOUNT
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
      }
    ).timeout(DEFAULT_TIMEOUT);

    it(
      `Should transfer back ${TRANSFER_AMOUNT} tokens to PN A (Transfer #${2})`, async function () {
        const transfer: EnygmaCrossTransfer = {
          destinationAddresses: [enygmaToken.userWallet.address],
          amounts: [TRANSFER_AMOUNT],
          destinationChainIds: [privacyNodes.A.chainId],
          programData: [[]]
        };

        const expectedBalances = {
          [privacyNodes.A.chainId]: MINT_AMOUNT
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
      }
    ).timeout(DEFAULT_TIMEOUT);

  it(`Continuous sending for ${testDurationMinutes} minutes, then verify final balance`, async function () {
    const providerA = privacyNodes.A.provider;
    const signerA = enygmaToken.userWallet;
    const signerB = enygmaToken.userWallet;
    const chainIdB = privacyNodes.B.chainId;
    const walletA = enygmaToken.userWallet;

    const tokenAddressA = enygmaToken.address[privacyNodes.A.chainId];
    const tokenAddressB = enygmaToken.address[privacyNodes.B.chainId];
    const tokenOnPNA = await privacyNodes.A.getContractAt<ProductionEnygmaToken>(
      ProductionEnygmaToken__factory.name,
      tokenAddressA,
      enygmaToken.symbol
    );
    const tokenOnPNB = await privacyNodes.B.getContractAt<ProductionEnygmaToken>(
      ProductionEnygmaToken__factory.name,
      tokenAddressB,
      enygmaToken.symbol
    );
    this.timeout(TEST_TIMEOUT);

    LOGGER.log(`=== Enygma Stability Test: ${testDurationMinutes} minutes  ===`);
    LOGGER.log(`Batch size: ${batchSize} transactions per batch`);

    const testStartTime = Date.now();
    const testEndTime = testStartTime + TEST_DURATION;

    let currentNonce = await providerA.getTransactionCount(signerA.address);
    let totalBatches = 0;
    let totalTransactions = 0;

    const initialBalanceA = await tokenOnPNA.balanceOf(signerA.address);
    const initialBalanceB = await tokenOnPNB.balanceOf(signerB.address);

    LOGGER.log(`Initial balances:`);
    LOGGER.log(`  - Source (A): ${initialBalanceA}`);
    LOGGER.log(`  - Destination (B): ${initialBalanceB}`);
    LOGGER.log(`Starting continuous batch sending at ${new Date(testStartTime).toISOString()}`);
    LOGGER.log(`Will send batches until ${new Date(testEndTime).toISOString()}`);

    // Continuous batch sending loop
    const rpcUrl = (providerA as any)._getConnection().url;

    while (Date.now() < testEndTime) {
      try {
        totalBatches++;

        LOGGER.log(`=== Sending Batch ${totalBatches} (${batchSize} transactions) ===`);

        // Verify nonce is still correct before signing batch
        const latestNonce = await providerA.getTransactionCount(signerA.address, 'pending');
        if (latestNonce > currentNonce) {
          LOGGER.log(
            `Adjusting nonce from ${currentNonce} to ${latestNonce} (some transactions may have failed)`
          );
          currentNonce = latestNonce;
        }

        // Check current balance to avoid sending transactions that will revert
        const currentBalance = await tokenOnPNA.balanceOf(signerA.address);
        const requiredAmount = BigInt(batchSize * amountPerTx);

        if (currentBalance < requiredAmount) {
          LOGGER.log(
            `Insufficient balance: ${currentBalance} < ${requiredAmount}. Skipping batch ${totalBatches}`
          );
          totalBatches--; // Don't count this as a sent batch
          break; // Exit the loop early
        }

        // Sign the batch
        const signedTxs = await signTransferBatch(
          batchSize,
          tokenOnPNA,
          signerB.address,
          chainIdB,
          providerA,
          walletA as HDNodeWallet,
          currentNonce,
          totalBatches
        );

        // Send the batch
        await sendSignedBatchTransactions(signedTxs, rpcUrl, totalBatches);

        currentNonce += batchSize;
        totalTransactions += batchSize;

        if (totalBatches % 10 === 0) {
          const elapsedTime = Date.now() - testStartTime;
          LOGGER.log(
            `Progress: batches=${totalBatches}, txs=${totalTransactions}, elapsed=${Math.round(elapsedTime / 1000)}s`
          );
        }

        // Small delay between batches
        await delay(1000); // 1 second
      } catch (error) {
        LOGGER.log(`Failed to send batch ${totalBatches}: ${error}`);
        // Continue with the next batch even if one fails
      }
    }

    LOGGER.log(`=== Batch Sending Phase Complete ===`);
    LOGGER.log(`Total batches sent: ${totalBatches}`);
    LOGGER.log(`Total transactions sent: ${totalTransactions}`);

    // Calculate expected final balances (for logging purposes)
    const totalAmountToTransfer = BigInt(totalTransactions * amountPerTx);
    const expectedBalanceB = initialBalanceB + totalAmountToTransfer;

    LOGGER.log(`=== Starting Final Settlement Verification ===`);
    LOGGER.log(
      `Expected final balance on B: ${expectedBalanceB} (if all ${totalTransactions} transactions settle)`
    );

    // Wait for final settlement
    LOGGER.log(`Waiting for all transactions to settle on destination...`);
    const settlementStartTime = Date.now();

    const finalSettled = await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const balance = await tokenOnPNB.balanceOf(signerB.address);
        LOGGER.log(`Final settlement progress: ${balance}/${expectedBalanceB}`);
        return balance >= expectedBalanceB;
      },
      interval: 5000, // 5 second polling interval for final settlement
      attempts: 25 * 60, // 25 minute timeout converted to seconds
      message: `Waiting for Enygma batch settlement: balance B → ${expectedBalanceB} for ${shortHex(signerB.address)} (${totalTransactions} txs)`,
      tolerateErrors: true,
    });

    const settlementEndTime = Date.now();
    const settlementDuration = (settlementEndTime - settlementStartTime) / 1000;
    const totalTestDuration = (settlementEndTime - testStartTime) / 1000;

    if (!finalSettled) {
      const actualBalanceB = await tokenOnPNB.balanceOf(signerB.address);
      const actualReceived = actualBalanceB - initialBalanceB;
      const successfulTransactions = Number(actualReceived);
      const failedTransactions = totalTransactions - successfulTransactions;

      LOGGER.log(`=== Test Incomplete - Settlement Timeout ===`);
      LOGGER.log(`Expected transactions: ${totalTransactions}`);
      LOGGER.log(`Successful transactions: ${successfulTransactions}`);
      LOGGER.log(`Failed/Pending transactions: ${failedTransactions}`);
      LOGGER.log(
        `Success rate: ${((successfulTransactions / totalTransactions) * 100).toFixed(2)}%`
      );
      LOGGER.log(`Settlement timeout after: ${settlementDuration.toFixed(2)} seconds`);

      // Skip partial report generation; rely on final report only
      throw new Error(
        `Stability test incomplete: Only ${successfulTransactions}/${totalTransactions} transactions settled within timeout`
      );
    }

    // Verify source balance as well
    const finalBalanceA = await tokenOnPNA.balanceOf(signerA.address);
    const finalBalanceB = await tokenOnPNB.balanceOf(signerB.address);

    LOGGER.log(`=== Enygma Stability Test Results ===`);
    LOGGER.log(`Test completed successfully!`);
    LOGGER.log(`Total batches: ${totalBatches}`);
    LOGGER.log(`Total transactions: ${totalTransactions}`);
    LOGGER.log(`Duration (first send → last settlement): ${totalTestDuration.toFixed(2)} seconds`);

    // Calculate actual settled amounts for reporting
    const actualSettledAmount = finalBalanceB - initialBalanceB;

    LOGGER.log(`Final balances:`);
    LOGGER.log(`  - Source (A): ${finalBalanceA}`);
    LOGGER.log(`  - Destination (B): ${finalBalanceB} (expected: ${expectedBalanceB})`);
    LOGGER.log(`Actual tokens settled: ${actualSettledAmount}`);
    LOGGER.log(`Overall TPS: ${(totalTransactions / totalTestDuration).toFixed(2)}`);

    const jsonReporter = new JsonReporter();
    const testData = {
      testType: '[EnygmaWrapper] Stability Test',
      testStartTime: testStartTime,
      settlementEndTime: settlementEndTime,
      testDurationMinutes: testDurationMinutes,
      batchSize: batchSize,
      totalBatches: totalBatches,
      totalTransactions: totalTransactions,
      successfulTransactions: totalTransactions,
      failedTransactions: 0,
      successRate: 100,
      settlementDuration: settlementDuration,
      totalDuration: totalTestDuration,
      overallTPS: totalTransactions / totalTestDuration,
      rpnCount: 2,
      status: 'SUCCESS',
      methodology:
        'Run for a fixed duration. Continuously sign and submit batches of size B without waiting for previous batches to settle. After time elapses, wait for all transactions to settle and compute metrics. Overall TPS = settled transactions / duration from first send to last settlement (seconds).'
    };

    const reportPath = jsonReporter.generateReport(testData);
    if (reportPath) {
      LOGGER.log(`Test results saved to: ${reportPath}`);
    }

    // Verify source and destination balance consistency
    const expectedBalanceA = initialBalanceA - actualSettledAmount;
    expect(finalBalanceA).to.equal(
      expectedBalanceA,
      `Source balance inconsistent with settled amount: actual ${finalBalanceA}, expected ${expectedBalanceA}`
    );

    // Verify settlement completeness (within tolerance for setup discrepancies)
    const actualTransactionsSettled = Number(actualSettledAmount);
    expect(actualTransactionsSettled).to.be.closeTo(
      totalTransactions,
      1,
      `Settlement count should be close to expected: ${actualTransactionsSettled} settled vs ${totalTransactions} sent`
    );
    expect(totalBatches).to.be.greaterThan(0, 'No batches were sent');
    expect(totalTransactions).to.be.greaterThan(0, 'No transactions were sent');

    LOGGER.log(
      `Stability test PASSED - ${actualTransactionsSettled}/${totalTransactions} transactions settled successfully`
    );
  });
});
