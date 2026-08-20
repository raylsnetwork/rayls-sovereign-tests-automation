import { expect } from 'chai';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
} from '../../../typechain-types';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { eventually } from '../../../src/utils/common';
import { HDNodeWallet, Wallet } from 'ethers';
import { EnygmaWrapper } from '../../../src/entities/tokens/EnygmaWrapper';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { cleanEnygmaDb, checkDbBalance } from '../../../src/utils/db-utils';
import { DEFAULT_TIMEOUT, LOGGER } from '../../../src/config/env-config';
import { shouldCrossTransferEnygma } from '../../../src/flows/tokens/token-flows';
import { sendMultipleTransfers } from '../../test-utils/helpers';
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe('E2E Tests: EnygmaWrapper 1->1 Stress Test Duplex. A to B and B to A. Single token contract', function () {
  const MINT_AMOUNT = 7000n;
  const TOTAL_SIM_TXS = 100;
  const TRANSFER_AMOUNT = {
    TWENTY:20n,
    FIVE : 5n
  }

  let signerA : Wallet | HDNodeWallet;
  let signerB : Wallet | HDNodeWallet;
  let signerC : Wallet | HDNodeWallet;

  let token1OnPNA: EnygmaWrapper<ProductionEnygmaToken>;
  let token1OnPNB: EnygmaWrapper<ProductionEnygmaToken>;
  let token1OnPNC: EnygmaWrapper<ProductionEnygmaToken>;

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(3);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;
    await cleanEnygmaDb();

    token1OnPNA = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
    await token1OnPNA.deployViaFactory();
    await token1OnPNA.activateOnPn();
    await token1OnPNA.activateOnHub(privateHub);

    signerA = token1OnPNA.userWallet;
    signerB = token1OnPNA.userWallet;
    signerC = token1OnPNA.userWallet;

    await token1OnPNA.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: signerA.address })
  });

  it('Warm up with cross transfer A -> B , A -> C', async function () {
    const crossTransferStart = Date.now();
    const crossTranfer = {
      destinationAddresses: [signerB.address],
      amounts: [BigInt(2001)],
      destinationChainIds: [privacyNodes.B.chainId],
      programData: [[]]
    }
    const expectedOnB = { [privacyNodes.B.chainId]: BigInt(2001) } ;

    await shouldCrossTransferEnygma(crossTranfer,1,expectedOnB,privateHub,
      privacyNodes.A,[privacyNodes.B],token1OnPNA);

    const balance = await token1OnPNA.contract.balanceOf(signerA.address);

    expect(balance).to.be.equal(4999n);

    token1OnPNB = await token1OnPNA.forNode(privacyNodes.B);

    await checkDbBalance<ProductionEnygmaToken>(2001, privateHub, privacyNodes.B, token1OnPNB);

    const crossTransferTotalTime = Date.now() - crossTransferStart;
    LOGGER.optionalLog(`⏰ Cross transfer total time: ${crossTransferTotalTime} ms`);

    const crossTranfer2 = {
      destinationAddresses: [signerA.address],
      amounts: [BigInt(1)],
      destinationChainIds: [privacyNodes.A.chainId],
      programData: [[]]
    }
    const expectedOnA = { [privacyNodes.A.chainId]: BigInt(5000) };
    await shouldCrossTransferEnygma(crossTranfer2,2,expectedOnA,privateHub,
      privacyNodes.B,[privacyNodes.A],token1OnPNA);

    const crossTranfer3 = {
      destinationAddresses: [signerC.address],
      amounts: [BigInt(1)],
      destinationChainIds: [privacyNodes.C.chainId],
      programData: [[]]
    }
    const expectedOnC = { [privacyNodes.C.chainId]: BigInt(1) } as { [k: string]: bigint };
    await shouldCrossTransferEnygma(crossTranfer3,3,expectedOnC,privateHub,
      privacyNodes.A,[privacyNodes.C],token1OnPNA);

    token1OnPNC = await token1OnPNA.forNode(privacyNodes.C);

    await checkDbBalance<ProductionEnygmaToken>(1, privateHub, privacyNodes.C, token1OnPNC);

    const crossTranfer4 = {
      destinationAddresses: [signerA.address],
      amounts: [BigInt(1)],
      destinationChainIds: [privacyNodes.A.chainId],
      programData: [[]]
    }
    const expectedOnA2 = { [privacyNodes.A.chainId]: BigInt(5000) } as { [k: string]: bigint };
    await shouldCrossTransferEnygma(crossTranfer4,4,expectedOnA2,privateHub,
      privacyNodes.C,[privacyNodes.A],token1OnPNA);

  }).timeout(5 * 60 * 1000);

  it('Simultaneous Cross transfer A -> B, and B -> A', async function () {
    const startTime = Date.now();
    LOGGER.optionalLog(`🛠️ Sending ${TOTAL_SIM_TXS} simultaneous cross transfers from A to B, and B to A`);

    const sendToB = sendMultipleTransfers(TOTAL_SIM_TXS, token1OnPNA.contract, signerB.address, privacyNodes.B.chainId, TRANSFER_AMOUNT.TWENTY)
    const sendToA = sendMultipleTransfers(TOTAL_SIM_TXS, token1OnPNB.contract, signerA.address, privacyNodes.A.chainId, TRANSFER_AMOUNT.FIVE)

    await Promise.all([sendToB, sendToA])

    LOGGER.optionalLog(`🛠️ Checking balance on PNs`);
    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const balance1OnPlB = await token1OnPNB.contract.balanceOf(signerB.address);
        const balance1OnPlA = await token1OnPNA.contract.balanceOf(signerA.address);
        LOGGER.log(`Balances token1 (origin, destination): ${balance1OnPlA}, ${balance1OnPlB}`);
        LOGGER.log(`Elapsed time ${Math.round((Date.now() - startTime) / 1000)}s`);
        return balance1OnPlA + balance1OnPlB == MINT_AMOUNT;
      },
      interval: 1000,
      attempts: 500000000000,
      message: `Waiting for Token1 A+B → MINT_AMOUNT=${MINT_AMOUNT} (${TOTAL_SIM_TXS} duplex txs, single token)`,
      tolerateErrors: true,
    });

    const elapsedTime = Date.now() - startTime
    LOGGER.optionalLog(`✅ Checking balance on PN destination, after ${TOTAL_SIM_TXS} simultaneos txs. time ${Math.round(elapsedTime / 1000)}s`);
  }).timeout(HOUR);

  it('Simultaneous Cross transfer A -> C and B -> C', async function () {
    const startTime = Date.now();
    LOGGER.log(`🛠️ Sending ${TOTAL_SIM_TXS} simultaneous cross transfers from A to C and B to C`);

    const sendAToC = sendMultipleTransfers(TOTAL_SIM_TXS, token1OnPNA.contract, signerC.address, privacyNodes.C.chainId, TRANSFER_AMOUNT.TWENTY)
    const sendBToC = sendMultipleTransfers(TOTAL_SIM_TXS, token1OnPNB.contract, signerC.address, privacyNodes.C.chainId, TRANSFER_AMOUNT.FIVE)

    await Promise.all([sendAToC, sendBToC])

    LOGGER.log(`🛠️ Checking balance on PNs`);
    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const balanceOnPnA = await token1OnPNA.contract.balanceOf(signerA.address);
        const balanceOnPnB = await token1OnPNB.contract.balanceOf(signerB.address);
        const balanceOnPnC = await token1OnPNC.contract.balanceOf(signerC.address);

        LOGGER.log(`Balances (A, B, C): ${balanceOnPnA}, ${balanceOnPnB}, ${balanceOnPnC}`);

        LOGGER.log(`Elapsed time ${Math.round((Date.now() - startTime) / 1000)}s`);
        if (balanceOnPnA + balanceOnPnB + balanceOnPnC == MINT_AMOUNT) return true;
        // if (balanceOnPnA == BigInt(3000) && balanceOnPnB == BigInt(1500) && balanceOnPnC == BigInt(2500)) return true;
        return false;
      },
      interval: 1000,
      attempts: 500000000000,
      message: `Waiting for Token1 A+B+C → MINT_AMOUNT=${MINT_AMOUNT} (${TOTAL_SIM_TXS} A→C and B→C txs)`,
      tolerateErrors: true,
    });

    const elapsedTime = Date.now() - startTime
    LOGGER.optionalLog(`✅ Checking balance on PN destination, after ${TOTAL_SIM_TXS} simultaneos txs. time ${Math.round(elapsedTime / 1000)}s`);
  }).timeout(HOUR);
});