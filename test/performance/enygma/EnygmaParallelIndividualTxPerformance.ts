import type { JsonRpcProvider, HDNodeWallet, TransactionRequest } from 'ethers';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { EnygmaWrapper } from '../../../src/entities/tokens/EnygmaWrapper';
import { DEFAULT_TIMEOUT, LOGGER } from '../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { shouldCrossTransferEnygma } from '../../../src/flows/tokens/token-flows';
import { eventually } from '../../../src/utils/common';
import { shortHex } from '../../../src/utils/formatters';
import axios from 'axios';
import JsonReporter from '../reporters/JsonReporter';
import { ProductionEnygmaToken, ProductionEnygmaToken__factory } from '../../../typechain-types';
import { EnygmaCrossTransfer } from '../../../src/types';

// ENYGMA_TRANSACTION_COUNT=1000 npx hardhat test test/performance/enygma/EnygmaParallelIndividualTxPerformance.ts

const transactionCount = parseInt(process.env.ENYGMA_TRANSACTION_COUNT || '10');
const amountPerTx = BigInt(1);

describe('Parallel Individual Transactions Performance', function () {
  const testTimeout = Math.max(30 * 60 * 1000, transactionCount * 30);
  this.timeout(testTimeout);

  LOGGER.log(`=== Scenario 2: Parallel Individual Transactions ===`);
  LOGGER.log(`Individual Transfers: ${transactionCount}`);
  LOGGER.log(`Amount Per Transfer: ${amountPerTx}`);
  LOGGER.log(`Test Timeout: ${testTimeout}ms`);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let enygmaToken: EnygmaWrapper<ProductionEnygmaToken>;

  let tokenOnPNA: ProductionEnygmaToken;
  let tokenOnPNB: ProductionEnygmaToken;

  async function signTransfers(
    totalTxs: number,
    tokenContract: ProductionEnygmaToken,
    receiverAddress: string,
    destinationChainId: string,
    provider: JsonRpcProvider,
    signer: HDNodeWallet,
  ): Promise<string[]> {
    const { chainId } = await provider.getNetwork();
    let currentNonce = await provider.getTransactionCount(signer.address);

    const signedRawTxs: string[] = []

    LOGGER.log(`Signing ${totalTxs} individual transfers...`);

    for (let i = 0; i < totalTxs; i++) {
      const call = await tokenContract
        .crossTransfer.populateTransaction(
          [receiverAddress],
          [amountPerTx],
          [destinationChainId],
          [[]], // Empty payload
        )

      const txReq: TransactionRequest = {
        ...call,
        from: signer.address,
        nonce: currentNonce,
        gasPrice: 0,
        gasLimit: 5_000_000,
        chainId,
      }

      const signed = await signer.signTransaction(txReq);
      signedRawTxs.push(signed);
      currentNonce++;


    }

    LOGGER.log(`Signed ${totalTxs} transfers`);
    return signedRawTxs;
  }

  async function sendSignedBatchTransactions(signedRawTxs: string[], rpcUrl: string): Promise<number> {
    const batchRequest = `[${signedRawTxs
      .map((tx, index) =>
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'eth_sendRawTransaction',
          params: [tx],
          id: index + 1
        })
      )
      .join(',')}]`;

    LOGGER.log(`Sending batch of ${signedRawTxs.length} transactions...`);

    try {
      const response = await axios.post(rpcUrl, batchRequest, {
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.status !== 200) {
        throw new Error(`Failed to send batch transactions: ${response.status} ${response.statusText}`);
      }

      const results: any[] = Array.isArray(response.data) ? response.data : [];
      const failedCount = results.filter((r) => r.error).length;
      LOGGER.log(`Batch sent: ${signedRawTxs.length - failedCount} accepted, ${failedCount} rejected by node`);
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
      amount: BigInt(transactionCount) * BigInt(amountPerTx) + BigInt(10),
      toAddress: enygmaToken.userWallet.address,
    });
  });

    it(`Should transfer ${amountPerTx} token to PN B for warmup (Transfer #1)`, async function () {
      const transfer: EnygmaCrossTransfer = {
        destinationAddresses: [enygmaToken.userWallet.address],
        amounts: [amountPerTx],
        destinationChainIds: [privacyNodes.B.chainId],
        programData: [[]],
      };

      const expectedBalances = {
        [privacyNodes.B.chainId]: amountPerTx,
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
      );
    }).timeout(DEFAULT_TIMEOUT);

    it(`Should transfer back ${amountPerTx} token to PN A (Transfer #2)`,async function () {
      const transfer: EnygmaCrossTransfer = {
        destinationAddresses: [enygmaToken.userWallet.address],
        amounts: [amountPerTx],
        destinationChainIds: [privacyNodes.A.chainId],
        programData: [[]]
      };

      const expectedBalances = {
        [privacyNodes.A.chainId]: BigInt(transactionCount) * BigInt(amountPerTx) + BigInt(10)
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

  it(`Measures A→B transfer TPS: ${transactionCount} transfers`, async function () {
      this.timeout(testTimeout);

      const N = transactionCount;

    LOGGER.log(`=== A→B TPS Test: ${N} Individual Transfers ===`);

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

      const signedTxs = await signTransfers(
        N,
        tokenOnPNA,
        enygmaToken.userWallet.address,
        privacyNodes.B.chainId,
        privacyNodes.A.provider,
        enygmaToken.userWallet as HDNodeWallet
      );

      const initialBalanceA = await tokenOnPNA.balanceOf(enygmaToken.userWallet.address);
      const initialBalanceB = await tokenOnPNB.balanceOf(enygmaToken.userWallet.address);

      const totalAmountToTransfer = BigInt(N) * BigInt(amountPerTx);
      const expectedBalanceB = initialBalanceB + totalAmountToTransfer;

    LOGGER.log(`Initial balances:`);
    LOGGER.log(`  - Source (A): ${initialBalanceA}`);
    LOGGER.log(`  - Destination (B): ${initialBalanceB}`);

      const rejectedByNode = await sendSignedBatchTransactions(signedTxs, privacyNodes.A.rpcUrl);
      const startTime = Date.now();
    LOGGER.log(`All transactions sent, starting timer at ${formatTimestamp(new Date(startTime))}`);
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
        message: `Waiting for Enygma parallel settlement: balance B → ${expectedBalanceB} for ${shortHex(enygmaToken.userWallet.address)}`,
        tolerateErrors: true,
      });

      const endTime = Date.now();
      const elapsedTime = endTime - startTime;
      const executionTimeSec = (elapsedTime / 1000).toFixed(2);

    const finalBalanceB = await tokenOnPNB.balanceOf(enygmaToken.userWallet.address);
    const actualReceived = Number(finalBalanceB - initialBalanceB);
    const actualTPS = (actualReceived / (elapsedTime / 1000)).toFixed(2);

    LOGGER.log(`All transactions completed at ${formatTimestamp(new Date(endTime))}`);
    LOGGER.log(`Total settlement time for ${N} transactions: ${executionTimeSec} seconds`);
    LOGGER.log(`Throughput: ${actualTPS} TPS`);

      const jsonReporter = new JsonReporter();
      const testData = {
        testType: '[Scenario 2] Parallel Transactions Performance Test',
        startTime: startTime,
        endTime: endTime,
        transactionCount: N,
        actualTPS: actualTPS,
        duration: parseFloat(executionTimeSec),
        successfulTransactions: actualReceived,
        failedTransactions: N - actualReceived - rejectedByNode,
        rpnCount: 2,
        rpcUrlA: privacyNodes.A.rpcUrl,
        methodology: 'Pre-sign N individual A→B transfers and submit them via a single JSON-RPC batch (eth_sendRawTransaction). The timer starts after all transactions are submitted and stops when the destination balance reflects all N transfers. TPS = N / settlement duration (seconds).'
      };

      jsonReporter.generateReport(testData);

    });

  function formatTimestamp(date: Date): string {
    return date.toTimeString().substring(0, 8);
  }

});
