/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
import { expect } from 'chai';
import { HDNodeWallet, parseUnits, Wallet } from 'ethers';
import { LOGGER } from '../../src/config/env-config';
import { ERC20Wrapper } from '../../src/entities/tokens/ERC20Wrapper';
import { ProductionErc20Token, ProductionErc20Token__factory } from '../../typechain-types';
import { delay, eventually } from '../../src/utils/common';
import { shortHex } from '../../src/utils/formatters';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../setup';
import { PrivateHub } from '../../src/entities/PrivateHub';
import { TransactionBuilder } from '../test-utils/transaction-builder';
import { TransactionSender } from '../test-utils/transaction-sender';

const TEST_TIMEOUT = 120 * 60 * 1000;

describe('Atomic Performance tests @decommissioned', function () {
  const THREE_MINUTES_WORTH_OF_ATTEMPTS: [number, number] = [1000, 180];
  const FIVE_MINUTES_WORTH_OF_ATTEMPTS: [number, number] = [1000, 7200];
  const totalTransactions = process.env['TRANSACTIONS_COUNT'] || '500';

  const TEST_DURATION_MINUTES = Number(process.env['TEST_DURATION_MINUTES'] || '2');
  const TEST_DURATION = TEST_DURATION_MINUTES * 60 * 1000; // 60 minutes
  let signerA : HDNodeWallet | Wallet;
  let signerB : HDNodeWallet | Wallet;

  let tokenOnPNA: ERC20Wrapper<ProductionErc20Token>;
  let tokenOnPNB: ProductionErc20Token;
  let balanceOnB: bigint;
  let initialBalanceOnB: bigint;
  let initialBalanceOnA: bigint;
  let privacyNodes: PrivacyNodeMap;
  let privateHub : PrivateHub;
  let TxBuilder: TransactionBuilder;
  const TxSender =  TransactionSender

  async function pollUntilBalanceUpdated(token: ProductionErc20Token, address: string, expectedBalance: bigint) {
    return await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const balance = await token.balanceOf(address);
        LOGGER.log(`Current balance on B: ${balance}`);
        return balance === expectedBalance;
      },
      interval: FIVE_MINUTES_WORTH_OF_ATTEMPTS[0],
      attempts: FIVE_MINUTES_WORTH_OF_ATTEMPTS[1],
      message: `Waiting for balance on B → ${expectedBalance} for ${shortHex(address)}`,
    });
  }

  before(async function () {
    this.timeout(3 * 60 * 1000);

    const {initializedNodes, initializedPNH} = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    // Deploy token and get contract instances
    tokenOnPNA = new ERC20Wrapper(privacyNodes.A, ProductionErc20Token__factory)
    await tokenOnPNA.deploy();
    await tokenOnPNA.activateOnPn();
    await tokenOnPNA.activateOnHub(privateHub);
    // ProductionErc20Token has no constructor premint — reproduce the old factory auto-mint (2M).
    await tokenOnPNA.mintAndAwait(privateHub, { toAddress: tokenOnPNA.userWallet.address, amount: parseUnits('2000000', 18) });

    signerA = tokenOnPNA.userWallet;
    signerB = tokenOnPNA.userWallet;

    TxBuilder = new TransactionBuilder(ProductionErc20Token__factory.abi,tokenOnPNA.address[privacyNodes.A.chainId],
      tokenOnPNA.userWallet.privateKey, Number(privacyNodes.A.chainId))
  });

  describe('Setup a token for testing', function () {
    it('Send non-atomic ERC20', async function () {
      const totalTxCount = 1;
      const amount = 1;

      // Get current nonce
      let currentNonce = await signerA.getNonce();
      LOGGER.log(`Current nonce for signerA: ${currentNonce}`);
      initialBalanceOnA = await tokenOnPNA.contract.balanceOf(signerA.address);

      // await sendBatchTransactions(totalTxCount, amount, currentNonce, tokenOnPNA.teleport);
      const txs = await TxBuilder.signBatch(totalTxCount,"teleport",[signerB.address,amount,privacyNodes.B.chainId],currentNonce);
      await TxSender.sendBatchRawTransactions(txs,privacyNodes.A.rpcUrl,'AtomicStability');

      tokenOnPNB = await privacyNodes.B.setContractByResourceId(ProductionErc20Token__factory.name,tokenOnPNA.resourceId,tokenOnPNA.symbol, tokenOnPNA.userWallet.connect(privacyNodes.B.provider))
      const balanceUpdated = await pollUntilBalanceUpdated(tokenOnPNB, signerB.address, BigInt(amount * totalTxCount));
      expect(balanceUpdated).to.be.true;

      // also assert the balance on A
      const balanceOnA = await tokenOnPNA.contract.balanceOf(signerA.address);
      expect(balanceOnA).to.equal(initialBalanceOnA - BigInt(amount));
    }).timeout(TEST_TIMEOUT);
  });

  describe(`AtomicTeleport from A to B ${TEST_DURATION_MINUTES} minutes of transactions`, function () {
    it('AtomicTeleport from A to B multiple batches', async function () {
      let totalTxCount = Number(totalTransactions);
      const amount = 1;
      let multipleBatches = 0;
      let startTime: number;

      const endTimestamp = Math.floor(Date.now()) + TEST_DURATION;

      // Get current nonce
      let currentNonce = await signerA.getNonce();
      LOGGER.log(`Current nonce for signerA: ${currentNonce}`);

      initialBalanceOnA = await tokenOnPNA.contract.balanceOf(signerA.address);
      initialBalanceOnB = await tokenOnPNB.balanceOf(signerB.address);
      LOGGER.log(`Initial token balance on B: ${initialBalanceOnB}`);

      startTime = Date.now();

      while (true) {
        const txs = await TxBuilder.signBatch(totalTxCount,"teleportAtomic",[signerB.address,amount,privacyNodes.B.chainId],currentNonce);
        await TxSender.sendBatchRawTransactions(txs,privacyNodes.A.rpcUrl,'AtomicPerformance');

        currentNonce += totalTxCount;
        multipleBatches++;
        LOGGER.log(`Current nonce for signerA: ${currentNonce}`);
        LOGGER.log(`Total transactions sent: ${totalTxCount * multipleBatches}`);
        await delay(1000);

        // Check if we reached the end timestamp
        if (Math.floor(Date.now()) >= endTimestamp) {
          break;
        }
      }

      const balanceUpdated = await pollUntilBalanceUpdated(tokenOnPNB, signerB.address, BigInt(amount * totalTxCount * multipleBatches) + initialBalanceOnB);
      expect(balanceUpdated).to.be.true;

      // Calculate finality time and TPS
      const endTime = Date.now();
      const totalSeconds = (endTime - startTime) / 1000;
      let totalTxInSpan = totalTxCount * multipleBatches;
      const tps = totalTxInSpan / totalSeconds;

      balanceOnB = await tokenOnPNB.balanceOf(signerB.address);
      LOGGER.log(`Balance on PN B for Address B: ${balanceOnB.toString()}`);
      LOGGER.info(`AtomicTeleport finality time accross ${multipleBatches} PN A blocks pushes: ${totalSeconds.toFixed(2)} seconds`);
      LOGGER.info(`Total TPS achieved: ${totalTxInSpan}tx / ${totalSeconds}s = ${tps.toFixed(2)}`);

      // also assert the balance on A
      const balanceOnA = await tokenOnPNA.contract.balanceOf(signerA.address);
      expect(balanceOnA).to.equal(initialBalanceOnA - BigInt(amount * totalTxCount * multipleBatches));
    }).timeout(TEST_TIMEOUT);
  });
});
