import { expect } from 'chai';
import { ethers } from 'hardhat';
import { EnygmaWrapper } from '../../../src/entities/tokens/EnygmaWrapper';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
} from '../../../typechain-types';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { checkDbBalance, cleanEnygmaDb } from '../../../src/utils/db-utils';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { eventually } from '../../../src/utils/common';
import { shortHex } from '../../../src/utils/formatters';
import { HDNodeWallet, Wallet } from 'ethers';
import { LOGGER } from '../../../src/config/env-config';
import { sendMultipleTransfers } from '../../test-utils/helpers';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe('E2E Tests: EnygmaWrapper 1->1 Stress Test Duplex. A to B and B to A. Separate token contracts', function () {
  const TOTAL_SIM_TXS = 100;
  const MINT_AMOUNT = 1000n;
  const TRANSFER_AMOUNT = 1n;

  let signerA : Wallet | HDNodeWallet;
  let signerB : Wallet | HDNodeWallet;

  let token1OnPNA: EnygmaWrapper<ProductionEnygmaToken>;
  let token1OnPNB: ProductionEnygmaToken;
  let token2OnPNA: ProductionEnygmaToken;
  let token2OnPNB: EnygmaWrapper<ProductionEnygmaToken>;

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  before(async function () {
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    this.timeout(3 * 60 * 1000);

    await cleanEnygmaDb()

    token1OnPNA = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
    token2OnPNB = new EnygmaWrapper(privacyNodes.B, ProductionEnygmaToken__factory);
    await token1OnPNA.deployViaFactory();
    await token1OnPNA.activateOnPn();
    await token1OnPNA.activateOnHub(privateHub);
    await token2OnPNB.deployViaFactory();
    await token2OnPNB.activateOnPn();
    await token2OnPNB.activateOnHub(privateHub);

    signerA = token1OnPNA.userWallet;
    signerB = token2OnPNB.userWallet;

    await token1OnPNA.mintAndAwait(privateHub, { amount: 1000n, toAddress: token1OnPNA.userWallet.address })
    await token2OnPNB.mintAndAwait(privateHub, { amount: 1000n, toAddress: token2OnPNB.userWallet.address })
  });

  it('Warm up with cross transfer A -> B', async function () {
    const initialBlockNumber = await privateHub.provider.getBlockNumber();

    const crossTransferStart = Date.now();
    const tx = await token1OnPNA.contract.crossTransfer([signerB.address], [10], [privacyNodes.B.chainId], [[]]);
    const receipt = await tx.wait();

    expect(receipt?.status).to.be.equal(1);

    const balance = await token1OnPNA.contract.balanceOf(signerA.address);

    expect(balance).to.be.equal(990);

    const iface = new ethers.Interface(['event transactionReferenceId(bytes32 _referenceId)']);

    const eventLog = receipt?.logs.find((log: any) => {
      try {
        const parsedLog = iface.parseLog(log);
        return parsedLog?.name === 'transactionReferenceId';
      } catch (error) {
        return false;
      }
    });

    if (!eventLog) {
      throw new Error('transactionReferenceId event not found in transaction receipt logs');
    }

    let parsedEvent;
    try {
      parsedEvent = iface.parseLog(eventLog);
    } catch (error) {
      throw new Error('Error parsing the event log');
    }

    const referenceId = parsedEvent?.args?._referenceId;

    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const currentBlockNumber = await privateHub.provider.getBlockNumber();
        return currentBlockNumber > initialBlockNumber;
      },
      interval: 1000,
      attempts: 300,
      message: `Waiting for PNH block > ${initialBlockNumber} (warm-up A→B)`,
    });

    token1OnPNB = await privacyNodes.B.setContractByResourceId<ProductionEnygmaToken>(
      ProductionEnygmaToken__factory.name, token1OnPNA.resourceId, token1OnPNA.symbol, token1OnPNA.userWallet.connect(privacyNodes.B.provider));


    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const balanceOnPnB = await token1OnPNB.balanceOf(signerB.address);

        return balanceOnPnB == BigInt(10);
      },
      interval: 1000,
      attempts: 300,
      message: `Waiting for Token1 balance → 10 on PN B (${shortHex(signerB.address)})`,
      tolerateErrors: true,
    });

    LOGGER.optionalLog(`✅ Checking balance on PN destination`);

    await checkDbBalance(990,privateHub,privacyNodes.A,token1OnPNA);
    await checkDbBalance(10,privateHub,privacyNodes.B,token1OnPNA);

    LOGGER.optionalLog(`🛠️  Checking referenceIds Status`);
    const crossTransferTotalTime = Date.now() - crossTransferStart;
    LOGGER.optionalLog(`⏰ Cross transfer total time: ${crossTransferTotalTime} ms`);

    expect(await token1OnPNA.contract.referenceIdStatus(referenceId)).to.be.equal(1);

    expect(await token1OnPNB.referenceIdStatus(referenceId)).to.be.equal(2);

    LOGGER.optionalLog(`✅ Checking referenceIds Status`);

    // crossTransfer from B back to A
    LOGGER.optionalLog(`🛠️  Sending back the enygma tokens from B to A`);
    const txB = await token1OnPNB.crossTransfer([signerA.address], [10], [privacyNodes.A.chainId], [[]]);
    const receiptB = await txB.wait();

    expect(receiptB?.status).to.be.equal(1);

    const balanceB = await token1OnPNB.balanceOf(signerB.address);

    expect(balanceB).to.be.equal(0);

    // check PN A
    LOGGER.optionalLog(`🛠️  Checking balance on PN destination A`);

    await token1OnPNA.waitForBalance(BigInt(1000),signerA.address);

    LOGGER.optionalLog(`✅ Checking balance on PN destination A`);
  }).timeout(5 * 60 * 1000);

  it('Warm up with cross transfer B -> A', async function () {
    const initialBlockNumber = await privateHub.provider.getBlockNumber();

    const crossTransferStart = Date.now();
    const tx = await token2OnPNB.contract.crossTransfer([signerA.address], [10], [privacyNodes.A.chainId], [[]]);
    const receipt = await tx.wait();

    expect(receipt?.status).to.be.equal(1);

    const balance = await token2OnPNB.contract.balanceOf(signerB.address);

    expect(balance).to.be.equal(990);

    const iface = new ethers.Interface(['event transactionReferenceId(bytes32 _referenceId)']);

    const eventLog = receipt?.logs.find((log : any) => {
      try {
        const parsedLog = iface.parseLog(log);
        return parsedLog?.name === 'transactionReferenceId';
      } catch (error) {
        return false;
      }
    });

    if (!eventLog) {
      throw new Error('transactionReferenceId event not found in transaction receipt logs');
    }

    let parsedEvent;
    try {
      parsedEvent = iface.parseLog(eventLog);
    } catch (error) {
      throw new Error('Error parsing the event log');
    }

    const referenceId = parsedEvent?.args?._referenceId;

    LOGGER.optionalLog(`🛠️  Waiting for the next block`);
    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const currentBlockNumber = await privateHub.provider.getBlockNumber();
        return currentBlockNumber > initialBlockNumber;
      },
      interval: 1000,
      attempts: 300,
      message: `Waiting for PNH block > ${initialBlockNumber} (warm-up B→A)`,
    });
    LOGGER.optionalLog(`✅ Next block confirmed`);

    LOGGER.optionalLog(`🛠️  Checking deploy of token PL destination`);

    token2OnPNA = await privacyNodes.A.setContractByResourceId(
      ProductionEnygmaToken__factory.name, token2OnPNB.resourceId, token2OnPNB.symbol, token2OnPNB.userWallet.connect(privacyNodes.A.provider));


    LOGGER.optionalLog(`✅ Checking deploy of token PL destination`);

    LOGGER.optionalLog(`🛠️  Checking balance on PN destination`);

    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const balanceOnPnA = await token2OnPNA.balanceOf(signerA.address);

        return balanceOnPnA == BigInt(10);
      },
      interval: 1000,
      attempts: 300,
      message: `Waiting for Token2 balance → 10 on PN A (${shortHex(signerA.address)})`,
      tolerateErrors: true,
    });

    LOGGER.optionalLog(`✅ Checking balance on PN destination`);

    await checkDbBalance(990,privateHub,privacyNodes.B,token2OnPNB);
    await checkDbBalance(10,privateHub,privacyNodes.A,token2OnPNB);

    LOGGER.optionalLog(`🛠️  Checking referenceIds Status`);
    const crossTransferTotalTime = Date.now() - crossTransferStart;
    LOGGER.optionalLog(`⏰ Cross transfer total time: ${crossTransferTotalTime} ms`);

    expect(await token2OnPNB.contract.referenceIdStatus(referenceId)).to.be.equal(1);

    expect(await token2OnPNA.referenceIdStatus(referenceId)).to.be.equal(2);

    LOGGER.optionalLog(`✅ Checking referenceIds Status`);

    // crossTransfer from A back to B
    LOGGER.optionalLog(`🛠️  Sending back the enygma tokens from A to B`);
    const txA = await token2OnPNA.crossTransfer([signerB.address], [10], [privacyNodes.B.chainId], [[]]);
    const receiptA = await txA.wait();

    expect(receiptA?.status).to.be.equal(1);

    const balanceA = await token2OnPNA.balanceOf(signerA.address);

    expect(balanceA).to.be.equal(0);

    // check PN B
    LOGGER.optionalLog(`🛠️  Checking balance on PN destination B`);

    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const balanceOnPnB = await token2OnPNB.contract.balanceOf(signerB.address);

        if (balanceOnPnB == BigInt(1000)) return true;
        return false;
      },
      interval: 1000,
      attempts: 300,
      message: `Waiting for Token2 balance → 1000 on PN B (${shortHex(signerB.address)}, A→B roundtrip)`,
      tolerateErrors: true,
    });

    LOGGER.optionalLog(`✅ Checking balance on PN destination B`);
  }).timeout(5 * 60 * 1000);

  it('Simultaneous Cross transfer A -> B, and B -> A', async function () {
    const startTime = Date.now();
    LOGGER.optionalLog(`🛠️ Sending ${TOTAL_SIM_TXS} simultaneous cross transfers from A to B, and B to A`);

    const sendToB = sendMultipleTransfers(
      TOTAL_SIM_TXS,
      token1OnPNA.contract,
      signerB.address,
      privacyNodes.B.chainId,
      TRANSFER_AMOUNT
    );
    const sendToA = sendMultipleTransfers(
      TOTAL_SIM_TXS,
      token2OnPNB.contract,
      signerA.address,
      privacyNodes.A.chainId,
      TRANSFER_AMOUNT
    );
    await Promise.all([sendToB, sendToA])

    LOGGER.optionalLog(`🛠️ Checking balance on PNs`);
    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const balance1OnPlB = await token1OnPNB.balanceOf(signerB.address);
        const balance1OnPlA = await token1OnPNA.contract.balanceOf(signerA.address);
        const balance2OnPlB = await token2OnPNB.contract.balanceOf(signerB.address);
        const balance2OnPlA = await token2OnPNA.balanceOf(signerA.address);
        LOGGER.log(`Balances token1 (origin, destination): ${balance1OnPlA}, ${balance1OnPlB}`);
        LOGGER.log(`Balances token2 (origin, destination): ${balance2OnPlA}, ${balance2OnPlB}`);
        LOGGER.log(`Elapsed time ${Math.round((Date.now() - startTime) / 1000)}s`);
        return balance1OnPlA + balance1OnPlB == MINT_AMOUNT && balance2OnPlA + balance2OnPlB == MINT_AMOUNT;
      },
      interval: 1000,
      attempts: 500000000000,
      message: `Waiting for Token1+Token2 A+B totals → MINT_AMOUNT=${MINT_AMOUNT} (${TOTAL_SIM_TXS} duplex txs)`,
      tolerateErrors: true,
    });

    const elapsedTime = Date.now() - startTime
    LOGGER.optionalLog(`✅ Checking balance on PN destination, after ${TOTAL_SIM_TXS} simultaneos txs. time ${Math.round(elapsedTime / 1000)}s`);
  }).timeout(HOUR);
});