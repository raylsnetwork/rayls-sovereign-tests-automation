import { expect } from 'chai';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
} from '../../typechain-types';
import { EnygmaWrapper } from '../../src/entities/tokens/EnygmaWrapper';
import { LOGGER } from '../../src/config/env-config';
import { PrivateHub } from '../../src/entities/PrivateHub';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../setup';
import { HDNodeWallet, Wallet } from 'ethers';
import { eventually } from '../../src/utils/common';
import { shortHex } from '../../src/utils/formatters';
import { TransactionBuilder } from '../test-utils/transaction-builder';
import { TransactionSender } from '../test-utils/transaction-sender';

function formatTimestamp(date: Date): string {
  return date.toTimeString().substring(0, 8);
}

describe('Performance Tests: EnygmaWrapper Cross-Transfer', function () {

  const totalTransactions = process.env['TRANSACTIONS_COUNT_ENYGMA'] || '100';

  let tokenOnPNA: EnygmaWrapper<ProductionEnygmaToken>;
  let tokenOnPNB: ProductionEnygmaToken;

  let signerA: HDNodeWallet | Wallet;
  let signerB: HDNodeWallet | Wallet;

  let privacyNodes: PrivacyNodeMap;
  let privateHub : PrivateHub;
  let TxBuilder: TransactionBuilder;
  const TxSender =  TransactionSender

  before(async function () {
    this.timeout(5 * 60 * 1000);
    const {initializedNodes, initializedPNH} = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    tokenOnPNA = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory)
    await tokenOnPNA.deployViaFactory();
    await tokenOnPNA.activateOnPn();
    await tokenOnPNA.activateOnHub(privateHub);

    signerA = tokenOnPNA.userWallet;
    signerB = tokenOnPNA.userWallet;

    TxBuilder = new TransactionBuilder(ProductionEnygmaToken__factory.abi,tokenOnPNA.address[privacyNodes.A.chainId],
      tokenOnPNA.userWallet.privateKey, Number(privacyNodes.A.chainId))
      // Mint tokens
    await tokenOnPNA.mintAndAwait(privateHub, { amount: 1000n, toAddress: signerA.address });
  });

  it('Measures cross transfer A -> B performance', async function () {
    this.timeout(15 * 60 * 1000);

    let startTime: number;
    const measuredTxs = Number(totalTransactions);

    // Send the initial transaction (to deploy on PN B)
    LOGGER.info(`Sending initial transaction...`);
      const tx = await tokenOnPNA.contract.crossTransfer([signerB.address], [1], [privacyNodes.B.chainId], [[]], { gasLimit: 5000000 });
      const receipt = await tx.wait();
      expect(receipt?.status).to.equal(1);

      LOGGER.info(`Initial transaction sent, waiting for confirmation on destination PN...`);
      tokenOnPNB = await privacyNodes.B.setContractByResourceId(ProductionEnygmaToken__factory.name,tokenOnPNA.resourceId,tokenOnPNA.symbol, tokenOnPNA.userWallet.connect(privacyNodes.B.provider))

    let currentNonce = await privacyNodes.A.provider.getTransactionCount(signerA.address);

    const txs = await TxBuilder.signBatch(measuredTxs,"crossTransfer",
      [[signerB.address], [1], [privacyNodes.B.chainId], [[]]],currentNonce);

    await TxSender.sendBatchRawTransactions(txs,privacyNodes.A.rpcUrl)

    // Start measuring
    startTime = Date.now();
    LOGGER.info(`Initial transaction confirmed and all transactions sent, starting timer at ${formatTimestamp(new Date(startTime))}`);

    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const balanceOnPnB = await tokenOnPNB.balanceOf(signerB.address);
        LOGGER.info(`Balance on PN B: ${balanceOnPnB}`);

        // Total transactions = initial + measured
        if (balanceOnPnB == BigInt(measuredTxs + 1)) {
          // End measuring
          const endTime = Date.now();

          // Calculate metrics
          if (startTime) {
            const executionTimeMs = endTime - startTime;
            const executionTimeSec = (executionTimeMs / 1000).toFixed(2);
            const avgTimePerTxSec = (executionTimeMs / measuredTxs / 1000).toFixed(2);
            const tps = (measuredTxs / (executionTimeMs / 1000)).toFixed(2);

            LOGGER.info(`All transactions completed at ${formatTimestamp(new Date(endTime))}`);
            LOGGER.info(`Total execution time for ${measuredTxs} transactions: ${executionTimeSec} seconds`);
            LOGGER.info(`Average time per transaction: ${avgTimePerTxSec} seconds`);
            LOGGER.info(`Throughput: ${tps} transactions per second`);
          }
          return true;
        }
        return false;
      },
      interval: 10000,
      attempts: 3000,
      message: `Waiting for balance on PN B → ${measuredTxs + 1} for ${shortHex(signerB.address)} (${measuredTxs} txs)`,
      tolerateErrors: true,
    });
  });
});
