import type { JsonRpcProvider, HDNodeWallet, TransactionRequest } from 'ethers';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { EnygmaWrapper } from '../../../src/entities/tokens/EnygmaWrapper';
import { DEFAULT_TIMEOUT, LOGGER } from '../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import axios from 'axios';
import JsonReporter from '../reporters/JsonReporter';
import { eventually } from '../../../src/utils/common';
import { shortHex } from '../../../src/utils/formatters';
import { shouldCrossTransferEnygma } from '../../../src/flows/tokens/token-flows';
import { ProductionEnygmaToken, ProductionEnygmaToken__factory } from '../../../typechain-types';
import { EnygmaCrossTransfer } from '../../../src/types';

// BATCH_TOTAL_TRANSFERS=1000 BATCH_TRANSFERS_PER_TX=10 npx hardhat test test/performance/enygma/EnygmaContractBatchTxPerformance.ts

const totalTransfers = parseInt(process.env.BATCH_TOTAL_TRANSFERS || '100');
const transfersPerBatch = parseInt(process.env.BATCH_TRANSFERS_PER_TX || '10');
const amountPerTransfer = BigInt(1);

const numberOfBatchTransactions = Math.ceil(totalTransfers / transfersPerBatch);

describe('Contract-Level Batch Transactions Performance', function () {
  const testTimeout = Math.max(30 * 60 * 1000, numberOfBatchTransactions * 30 * 1000);
  this.timeout(testTimeout);

  LOGGER.log(`=== Scenario 3: Contract-Level Batch Transactions ===`);
  LOGGER.log(`Total Transfers: ${totalTransfers}`);
  LOGGER.log(`Transfers Per Batch: ${transfersPerBatch}`);
  LOGGER.log(`Number of Batch Transactions: ${numberOfBatchTransactions}`);
  LOGGER.log(`Amount Per Transfer: ${amountPerTransfer}`);
  LOGGER.log(`Test Timeout: ${testTimeout}ms`);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  let tokenOnPNA: ProductionEnygmaToken;
  let tokenOnPNB: ProductionEnygmaToken;
  let enygmaToken: EnygmaWrapper<ProductionEnygmaToken>;

  async function createBatchTransactions(
    totalTransfers: number,
    batchSize: number,
    tokenContract: ProductionEnygmaToken,
    receiverAddress: string,
    destinationChainId: string,
    provider: JsonRpcProvider,
    signer: HDNodeWallet,
  ): Promise<string[]> {
    const { chainId } = await provider.getNetwork();
    let currentNonce = await provider.getTransactionCount(signer.address);

    const signedBatchTxs: string[] = [];
    const numBatches = Math.ceil(totalTransfers / batchSize);

    LOGGER.log(`Creating ${numBatches} batch transactions with up to ${batchSize} transfers each...`);

    for (let batchIndex = 0; batchIndex < numBatches; batchIndex++) {
      const transfersInThisBatch = Math.min(batchSize, totalTransfers - (batchIndex * batchSize));

      // Create arrays for batch transaction
      // Each transaction contains MULTIPLE transfers
      const recipients = Array(transfersInThisBatch).fill(receiverAddress);
      const amounts = Array(transfersInThisBatch).fill(amountPerTransfer);
      const chainIds = Array(transfersInThisBatch).fill(destinationChainId);
      const payloads = Array(transfersInThisBatch).fill([]);

      // Single transaction containing multiple transfers
      const call = await tokenContract
        .crossTransfer.populateTransaction(
          recipients,    // [recipient1, recipient2, ..., recipientN]
          amounts,       // [amount1, amount2, ..., amountN]
          chainIds,      // [chainId1, chainId2, ..., chainIdN]
          payloads,      // [[], [], ..., []]
        );

      const txReq: TransactionRequest = {
        ...call,
        from: signer.address,
        nonce: currentNonce,
        gasPrice: 0,
        gasLimit: 5_000_000 + (transfersInThisBatch * 100_000),
        chainId,
      };

      const signed = await signer.signTransaction(txReq);
      signedBatchTxs.push(signed);
      currentNonce++;

      LOGGER.log(`Batch ${batchIndex + 1}: ${transfersInThisBatch} transfers in single transaction`);
    }

    LOGGER.log(`Created ${numBatches} batch transactions`);
    return signedBatchTxs;
  }

  async function sendBatchTransactionsInParallel(signedBatchTxs: string[], rpcUrl: string): Promise<number> {
    // Send all batch transactions simultaneously
    const batchRequest = `[${signedBatchTxs
      .map((tx, index) =>
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_sendRawTransaction',
          params: [tx],
          id: index + 1
        })
      )
      .join(',')}]`;

    LOGGER.log(`Sending ${signedBatchTxs.length} batch transactions in parallel...`);

    try {
      const response = await axios.post(rpcUrl, batchRequest, {
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.status !== 200) {
        throw new Error(`Failed to send batch transactions: ${response.status} ${response.statusText}`);
      }

      const results: any[] = Array.isArray(response.data) ? response.data : [];
      const failedCount = results.filter((r) => r.error).length;
      LOGGER.log(`Batch sent: ${signedBatchTxs.length - failedCount} accepted, ${failedCount} rejected by node`);
      return failedCount;
    } catch (error) {
      LOGGER.error(`Error sending batch transactions: ${error}`);
      throw error;
    }
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
      amount: BigInt(totalTransfers) * BigInt(amountPerTransfer) + BigInt(10),
      toAddress: enygmaToken.userWallet.address,
    });
  });

    it(`Should transfer ${amountPerTransfer} token to PN B for warmup (Transfer #1)`, async function () {
      const transfer: EnygmaCrossTransfer = {
        destinationAddresses: [enygmaToken.userWallet.address],
        amounts: [amountPerTransfer],
        destinationChainIds: [privacyNodes.B.chainId],
        programData: [[]]
      };

      const expectedBalances = {
        [privacyNodes.B.chainId]: amountPerTransfer
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

    it(`Should transfer back ${amountPerTransfer} token to PN A (Transfer #2)`, async function () {
      const transfer: EnygmaCrossTransfer = {
        destinationAddresses: [enygmaToken.userWallet.address],
        amounts: [amountPerTransfer],
        destinationChainIds: [privacyNodes.A.chainId],
        programData: [[]]
      };

      const expectedBalances = {
        [privacyNodes.A.chainId]: BigInt(totalTransfers) * BigInt(amountPerTransfer) + BigInt(10)
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

  it(`TPS for ${numberOfBatchTransactions} batch transactions with ${totalTransfers} total transfers`, async function () {
      this.timeout(testTimeout);

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

      const signedBatchTxs = await createBatchTransactions(
        totalTransfers,
        transfersPerBatch,
        tokenOnPNA,
        enygmaToken.userWallet.address,
        privacyNodes.B.chainId,
        privacyNodes.A.provider,
        enygmaToken.userWallet as HDNodeWallet
      );

      const initialBalanceA = await tokenOnPNA.balanceOf(enygmaToken.userWallet.address);
      const initialBalanceB = await tokenOnPNB.balanceOf(enygmaToken.userWallet.address);

      const totalAmountToTransfer = BigInt(totalTransfers) * BigInt(amountPerTransfer);
      const expectedBalanceB = initialBalanceB + totalAmountToTransfer;

    LOGGER.log(`Initial balances:`);
    LOGGER.log(`  - Source (A): ${initialBalanceA}`);
    LOGGER.log(`  - Destination (B): ${initialBalanceB}`);

      const rejectedByNode = await sendBatchTransactionsInParallel(signedBatchTxs, privacyNodes.A.rpcUrl);
      const startTime = Date.now();
    LOGGER.log(`All batch transactions sent, starting timer at ${formatTimestamp(new Date(startTime))}`);
    LOGGER.log(`Monitoring balance settlement...`);

      // eventually() throws with descriptive context on exhaustion — no manual timeout branch needed.
      await eventually<boolean>({
        check: async (): Promise<boolean> => {
          const balanceB = await tokenOnPNB.balanceOf(enygmaToken.userWallet.address);

          const receivedOnB = balanceB - initialBalanceB;
          const elapsedTime = Date.now() - startTime;
          const currentTPS = Number(receivedOnB) / (elapsedTime / 1000);

          LOGGER.log(`Progress: Received ${receivedOnB}/${totalAmountToTransfer} transfers. Elapsed: ${Math.round(elapsedTime / 1000)}s. Current TPS: ${currentTPS.toFixed(2)}`);

          return balanceB === expectedBalanceB;
        },
        interval: 1000,
        attempts: 300,
        message: `Waiting for Enygma batch settlement: balance B → ${expectedBalanceB} for ${shortHex(enygmaToken.userWallet.address)}`,
        tolerateErrors: true,
      });

      const endTime = Date.now();
      const elapsedTime = endTime - startTime;
      const executionTimeSec = (elapsedTime / 1000).toFixed(2);
      const finalBalanceB = await tokenOnPNB.balanceOf(enygmaToken.userWallet.address);
      const actualReceived = Number(finalBalanceB - initialBalanceB);
      const actualTPS = (actualReceived / (elapsedTime / 1000)).toFixed(2);

    LOGGER.log(`All transactions completed at ${formatTimestamp(new Date(endTime))}`);
    LOGGER.log(`Total settlement time for ${totalTransfers} transfers in ${numberOfBatchTransactions} batch transactions: ${executionTimeSec} seconds`);
    LOGGER.log(`Throughput: ${actualTPS} TPS`);

      const jsonReporter = new JsonReporter();
      const testData = {
        testType: '[Scenario 3] Batch Transactions Performance Test',
        startTime: startTime,
        endTime: endTime,
        transactionCount: totalTransfers,
        batchTransactionCount: numberOfBatchTransactions,
        transfersPerBatch: transfersPerBatch,
        actualTPS: actualTPS,
        duration: parseFloat(executionTimeSec),
        successfulTransactions: actualReceived,
        failedTransactions: totalTransfers - actualReceived - rejectedByNode,
        rpnCount: 2,
        rpcUrlA: privacyNodes.A.rpcUrl,
        methodology: `Create ${numberOfBatchTransactions} batch transactions, each containing ${transfersPerBatch} transfers. Submit all batch transactions simultaneously via JSON-RPC batch. Timer starts after submission and stops when destination balance reflects all transfers.`
      };

      jsonReporter.generateReport(testData);

    });

  function formatTimestamp(date: Date): string {
    return date.toTimeString().substring(0, 8);
  }

});
