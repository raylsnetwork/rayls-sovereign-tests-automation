/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
import { expect } from 'chai';
import { HDNodeWallet, parseUnits, Wallet } from 'ethers';

import { ProductionErc20Token, ProductionErc20Token__factory } from '../../typechain-types';
import { eventually } from '../../src/utils/common';
import { shortHex } from '../../src/utils/formatters';
import { LOGGER } from '../../src/config/env-config';
import { PrivateHub } from '../../src/entities/PrivateHub';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../setup';
import { ERC20Wrapper } from '../../src/entities/tokens/ERC20Wrapper';
import { TransactionSender } from '../test-utils/transaction-sender';
import { TransactionBuilder } from '../test-utils/transaction-builder';

const TEST_TIMEOUT = 20 * 60 * 1000;

describe('Atomic Performance tests @decommissioned', function () {
  const THREE_MINUTES_WORTH_OF_ATTEMPTS: [number, number] = [1000, 180];
  const FIVE_MINUTES_WORTH_OF_ATTEMPTS: [number, number] = [1000, 300];

  const totalTransactions = process.env['TRANSACTIONS_COUNT'] || '500';
  let privacyNodes: PrivacyNodeMap;
  let privateHub : PrivateHub;
  let TxBuilder: TransactionBuilder;
  const TxSender = TransactionSender;

  let signerA : HDNodeWallet | Wallet;
  let signerB : HDNodeWallet | Wallet;

  // Contracts and variables
  let tokenOnPNA: ERC20Wrapper<ProductionErc20Token>;
  let tokenOnPNB:ProductionErc20Token;
  let balanceOnB: bigint;
  let initialBalanceOnB: bigint;
  let initialBalanceOnA: bigint;

  async function pollUntilBalanceUpdated(token: ProductionErc20Token, address: string, expectedBalance: bigint) {
    return await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const balance = await token.balanceOf(address);
        return balance === expectedBalance;
      },
      interval: FIVE_MINUTES_WORTH_OF_ATTEMPTS[0],
      attempts: FIVE_MINUTES_WORTH_OF_ATTEMPTS[1],
      message: `Waiting for balance → ${expectedBalance} for ${shortHex(address)}`,
    });
  }


  before(async function () {
    this.timeout(3 * 60 * 1000);

    const {initializedNodes, initializedPNH} = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    // Endpoint addresses
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

  describe('Setup a token for performance testing', function () {

    it('Deploys ERC20 Contract', async function () {
      const totalTxCount = 1;
      const amount = 1;

      // Get current nonce
      let currentNonce = await signerA.getNonce();
      LOGGER.log(`Current nonce for signerA: ${currentNonce}`);
      initialBalanceOnA = await tokenOnPNA.contract.balanceOf(signerA.address);

      const txs = await TxBuilder.signBatch(totalTxCount,"teleport",
        [signerB.address,amount,privacyNodes.B.chainId],currentNonce);
      await TxSender.sendBatchRawTransactions(txs,privacyNodes.A.rpcUrl,'AtomicPerformance');

      tokenOnPNB = await privacyNodes.B.setContractByResourceId(ProductionErc20Token__factory.name,tokenOnPNA.resourceId,tokenOnPNA.symbol, tokenOnPNA.userWallet.connect(privacyNodes.B.provider))
      const balanceUpdated = await pollUntilBalanceUpdated(tokenOnPNB, signerB.address, BigInt(amount * totalTxCount));
      expect(balanceUpdated).to.be.true;

      // also assert the balance on A
      const balanceOnA = await tokenOnPNA.contract.balanceOf(signerA.address);
      expect(balanceOnA).to.equal(initialBalanceOnA - BigInt(amount));
    }).timeout(TEST_TIMEOUT);
  });

  describe('AtomicTeleport from A to B single batch', function () {
    it('AtomicTeleport from A to B single batch', async function () {
      const totalTxCount = Number(totalTransactions);
      const amount = 1;
      let startTime: number;

      // Get current nonce
      let currentNonce = await signerA.getNonce();
      LOGGER.log(`Current nonce for signerA: ${currentNonce}`);

      initialBalanceOnA = await tokenOnPNA.contract.balanceOf(signerA.address);
      initialBalanceOnB = await tokenOnPNB.balanceOf(signerB.address);
      LOGGER.log(`Initial token balance on B: ${initialBalanceOnB}`);

      const txs = await TxBuilder.signBatch(totalTxCount,"teleportAtomic",[signerB.address,amount,privacyNodes.B.chainId],currentNonce);
      await TxSender.sendBatchRawTransactions(txs,privacyNodes.A.rpcUrl,'AtomicPerformance');

      startTime = Date.now();
      const balanceUpdated = await pollUntilBalanceUpdated(tokenOnPNB, signerB.address, BigInt(amount * totalTxCount) + initialBalanceOnB);
      expect(balanceUpdated).to.be.true;

      // Calculate finality time and TPS
      const endTime = Date.now();
      const totalSeconds = (endTime - startTime) / 1000;
      const tps = totalTxCount / totalSeconds;

      balanceOnB = await tokenOnPNB.balanceOf(signerB.address);
      LOGGER.log(`Balance on PN B for Address B: ${balanceOnB.toString()}`);
      LOGGER.info(`AtomicTeleport finality time: ${totalSeconds.toFixed(2)} seconds`);
      LOGGER.info(`Total TPS achieved: ${totalTxCount}tx / ${totalSeconds}s = ${tps.toFixed(2)}`);

      // also assert the balance on A
      const balanceOnA = await tokenOnPNA.contract.balanceOf(signerA.address);
      expect(balanceOnA).to.equal(initialBalanceOnA - BigInt(amount * totalTxCount));
    }).timeout(TEST_TIMEOUT);
  });

  describe('Vanila Teleport from A to B single batch', function () {
    it('Vanila Teleport from A to B', async function () {
      const totalTxCount = Number(totalTransactions);
      const amount = 1;
      let startTime: number;

      initialBalanceOnA = await tokenOnPNA.contract.balanceOf(signerA.address);
      initialBalanceOnB = await tokenOnPNB.balanceOf(signerB.address);
      LOGGER.log(`Initial token balance on B: ${initialBalanceOnB}`);

      // Get current nonce
      let currentNonce = await signerA.getNonce();
      LOGGER.log(`Current nonce for signerA: ${currentNonce}`);

      const txs = await TxBuilder.signBatch(totalTxCount,"teleport",[signerB.address,amount,privacyNodes.B.chainId],currentNonce);
      await TxSender.sendBatchRawTransactions(txs,privacyNodes.A.rpcUrl,'AtomicPerformance');

      startTime = Date.now();
      const balanceUpdated = await pollUntilBalanceUpdated(tokenOnPNB, signerB.address, BigInt(amount * totalTxCount) + initialBalanceOnB);
      expect(balanceUpdated).to.be.true;

      // Calculate finality time and TPS
      const endTime = Date.now();
      const totalSeconds = (endTime - startTime) / 1000;
      const tps = totalTxCount / totalSeconds;

      balanceOnB = await tokenOnPNB.balanceOf(signerB.address);
      LOGGER.log(`Balance on PN B for Address B: ${balanceOnB.toString()}`);
      LOGGER.info(`Teleport finality time: ${totalSeconds.toFixed(2)} seconds`);
      LOGGER.info(`Total TPS achieved: ${totalTxCount}tx / ${totalSeconds}s = ${tps.toFixed(2)}`);

      // also assert the balance on A
      const balanceOnA = await tokenOnPNA.contract.balanceOf(signerA.address);
      expect(balanceOnA).to.equal(initialBalanceOnA - BigInt(amount * totalTxCount));
    }).timeout(TEST_TIMEOUT);
  });
});
