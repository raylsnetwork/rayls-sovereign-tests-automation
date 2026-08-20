import { expect } from 'chai';
import hre, { ethers } from 'hardhat';
import {
  EndpointV1,
  ProductionEnygmaToken, ProductionEnygmaToken__factory,
} from '../../../../typechain-types';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { DEFAULT_TIMEOUT, LOGGER } from '../../../../src/config/env-config';
import { eventually, sendTx } from '../../../../src/utils/common';
import { shortHex } from '../../../../src/utils/formatters';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { HDNodeWallet, Wallet } from 'ethers';

describe('E2E Tests: EnygmaWrapper Edge Cases', function () {
  let signerA: HDNodeWallet | Wallet;
  let signerB: HDNodeWallet | Wallet;

  let tokenOnPNA: EnygmaWrapper<ProductionEnygmaToken>;
  let tokenOnPNB: ProductionEnygmaToken;
  let endpointB: EndpointV1;

   let privateHub : PrivateHub;
   let privacyNodes: PrivacyNodeMap;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const {initializedNodes, initializedPNH} = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    tokenOnPNA = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
    signerA = tokenOnPNA.userWallet;
    signerB = tokenOnPNA.userWallet.connect(privacyNodes.B.provider);
    endpointB = privacyNodes.B.getContract<EndpointV1>('EndpointV1')

    // New token-registry flow: node-factory deploy as user (seeded codehash clears the
    // programmability gate), then PN-authorize + hub-activate.
    await tokenOnPNA.deployViaFactory();
    await tokenOnPNA.activateOnPn();
    await tokenOnPNA.activateOnHub(privateHub);
    await tokenOnPNA.mintAndAwait(privateHub, { amount: 1000n, toAddress: tokenOnPNA.userWallet.address })
  });

  it('should mint token on RN before approval, and send A -> B', async function () {

      LOGGER.log(`Starting transaction A -> B`);
      const initialBlockNumber = await privateHub.provider.getBlockNumber();
      LOGGER.log(`Cross transferring...`);
      LOGGER.log(`Balance of PN A before: ${await tokenOnPNA.contract.balanceOf(signerA.address)}`);

      const receipt = await sendTx(() => tokenOnPNA.contract.crossTransfer([signerB.address], [10], [privacyNodes.B.chainId], [[]]));

      expect(receipt?.status).to.be.equal(1);
      LOGGER.log(`Cross transfer from A to B finished. Transaction status: ${receipt?.status}`);

      LOGGER.log(`Checking sender balance...`);
      const balance = await tokenOnPNA.contract.balanceOf(signerA.address);
      expect(balance).to.be.equal(990);
      LOGGER.log(`Balance of PN A after: ${await tokenOnPNA.contract.balanceOf(signerA.address)}`);

      const iface = new ethers.Interface(['event crossTransferReferenceId(bytes32 _referenceId)']);
      const eventLog = receipt?.logs.find((log : any) => {
        try {
          const parsedLog = iface.parseLog(log);
          return parsedLog?.name === 'crossTransferReferenceId';
        } catch (error) {
          return false;
        }
      });

      if (!eventLog) {
        throw new Error('crossTransferReferenceId event not found in transaction receipt logs');
      }

      const parsedEvent = iface.parseLog(eventLog);
      const referenceId = parsedEvent?.args?._referenceId;
      expect(referenceId).to.not.be.undefined;
      LOGGER.log(`Reference ID extracted: ${referenceId}`);

      LOGGER.log(`🛠️ Waiting for the next block on PNH...`);
      await eventually<boolean>({
        check: async (): Promise<boolean> => {
          const currentBlockNumber = await privateHub.provider.getBlockNumber();
          return currentBlockNumber > initialBlockNumber;
        },
        interval: 1000,
        attempts: 300,
        message: `Waiting for PNH block > ${initialBlockNumber} after crossTransfer A→B`,
      });
      LOGGER.log(`✅ Next block confirmed on PNH.`);

      LOGGER.log(`🛠️ Checking deploy of token on PN destination...`);
      await eventually<boolean>({
        check: async (): Promise<boolean> => {
          const tokenBAddress = await endpointB.getAddressByResourceId(tokenOnPNA.resourceId);
          if (tokenBAddress === '0x0000000000000000000000000000000000000000') return false;
          tokenOnPNB = await hre.ethers.getContractAt('ProductionEnygmaToken', tokenBAddress, signerB);
          return true;
        },
        interval: 1000,
        attempts: 300,
        message: `Waiting for ${tokenOnPNA.symbol} deployed on PN B (rid=${shortHex(tokenOnPNA.resourceId)})`,
      });
      LOGGER.log(`✅ Token deployed on PN destination: ${await tokenOnPNB.getAddress()}`);

      LOGGER.log(`🛠️ Checking balance on PN destination...`);
      await eventually<boolean>({
        check: async (): Promise<boolean> => {
          const balanceOnPnB = await tokenOnPNB.balanceOf(signerB.address);
          return balanceOnPnB === BigInt(10);
        },
        interval: 1000,
        attempts: 300,
        message: `Waiting for ${tokenOnPNA.symbol} balance B → 10 for ${shortHex(signerB.address)}`,
        tolerateErrors: true,
      });
      LOGGER.log(`Balance on PN B: ${await tokenOnPNB.balanceOf(signerB.address)}`);
      LOGGER.log(`✅ Balance on PN destination confirmed.`);

      LOGGER.log(`🛠️ Checking referenceIds Status...`);
      expect(await tokenOnPNA.contract.referenceIdStatus(referenceId)).to.be.equal(1); // Sent
      expect(await tokenOnPNB.referenceIdStatus(referenceId)).to.be.equal(2); // Received
      LOGGER.log(`✅ ReferenceIds Status confirmed.`);
  }).timeout(5 * 60 * 1000);

  it('should handle sending a wrong payload gracefully, causing a revert', async function () {
    try {
      LOGGER.log(`⚒️ Sending wrong payload to trigger a revert...`);
      const balanceOfAOnPNABefore = await tokenOnPNA.contract.balanceOf(signerA.address);
      LOGGER.log(`Balance of A on PN A before: ${balanceOfAOnPNABefore}`);

      const wrongPayload = {
        "resourceId": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "contractAddress": "0xa950C7AF3F7161FCAc7892baC116842aB5Cac3A5",
        "selector": "0x40d11f19",
        "args": "0x0000000000000000000000001648cca5838683e401cc86f833c762ab710e98ba00000000000000000000000000000000000000000000000000000000002dc6c0"
      };

      const receipt = await sendTx(() => tokenOnPNA.contract.crossTransfer([signerA.address], [10], [privacyNodes.B.chainId], [[wrongPayload]]));

      expect(receipt?.status).to.be.equal(1); // Transaction on source chain succeeded

      let balanceOfAOnPNAAfter = await tokenOnPNA.contract.balanceOf(signerA.address);
      LOGGER.log(`Balance on PN A just after the crossTransfer TX: ${balanceOfAOnPNAAfter}`);

      // Poll until balance reverts to original, indicating the cross-chain operation failed and funds returned
      await eventually<boolean>({
        check: async (): Promise<boolean> => {
          balanceOfAOnPNAAfter = await tokenOnPNA.contract.balanceOf(signerA.address);
          return balanceOfAOnPNABefore === balanceOfAOnPNAAfter;
        },
        interval: 1000,
        attempts: 300,
        message: `Waiting for PN A balance reverted to ${balanceOfAOnPNABefore} for ${shortHex(signerA.address)} (wrong-payload)`,
      });

      LOGGER.log(`Balance on PN A after revert: ${balanceOfAOnPNAAfter}`);
      expect(balanceOfAOnPNABefore).to.be.equal(balanceOfAOnPNAAfter);
      LOGGER.log(`✅ Passed. Funds were reverted to sender after destination chain failure.`);

    } catch (error) {
      LOGGER.error(`Test 'Sending wrong payload' failed: ${error}`);
      throw error;
    }
  }).timeout(5 * 60 * 1000);

  it('should successfully send tokens from B -> A after a previous revert', async function () {
    try {
      LOGGER.log(`⚒️ Sending tokens from B -> A to confirm system is working after previous revert...`);
      const balanceOfBOnPNBBefore = await tokenOnPNB.balanceOf(signerB.address);
      const balanceOfAOnPNABefore = await tokenOnPNA.contract.balanceOf(signerA.address);

      LOGGER.log(`Balance of B on PN B before: ${balanceOfBOnPNBBefore}`);
      LOGGER.log(`Balance of A on PN A before: ${balanceOfAOnPNABefore}`);

      const amountToSend = 5;

      const receipt = await sendTx(() => tokenOnPNB.crossTransfer([signerA.address], [amountToSend], [privacyNodes.A.chainId], [[]]));

      expect(receipt?.status).to.be.equal(1);
      LOGGER.log(`Cross transfer from B to A initiated ✅`);

      await eventually<boolean>({
        check: async (): Promise<boolean> => {
          const currentBalanceOfA = await tokenOnPNA.contract.balanceOf(signerA.address);
          return currentBalanceOfA === (balanceOfAOnPNABefore + BigInt(amountToSend));
        },
        interval: 1000,
        attempts: 300,
        message: `Waiting for PN A balance → ${balanceOfAOnPNABefore + BigInt(amountToSend)} for ${shortHex(signerA.address)} (B→A)`,
      });

      const balanceOfBOnPNBAfter = await tokenOnPNB.balanceOf(signerB.address);
      const balanceOfAOnPNBAfter = await tokenOnPNA.contract.balanceOf(signerA.address);

      LOGGER.log(`Balance of B on PN B after: ${balanceOfBOnPNBAfter}`);
      LOGGER.log(`Balance of A on PN A after: ${balanceOfAOnPNBAfter}`);

      expect(balanceOfBOnPNBBefore - BigInt(amountToSend)).to.be.equal(balanceOfBOnPNBAfter);
      expect(balanceOfAOnPNABefore + BigInt(amountToSend)).to.be.equal(balanceOfAOnPNBAfter);

      LOGGER.log(`✅ Successfully sent tokens from B -> A after previous revert.`);
    } catch (error) {
      LOGGER.error(`❌ Error sending tokens from B -> A after previous revert: ${error}`);
      throw error;
    }
  }).timeout(5 * 60 * 1000);
});
