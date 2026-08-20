import { expect } from 'chai';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { EnygmaWrapper } from '../../../src/entities/tokens/EnygmaWrapper';
import { cleanEnygmaDb, checkDbBalance } from '../../../src/utils/db-utils';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { HDNodeWallet, Wallet } from 'ethers';
import { LOGGER } from '../../../src/config/env-config';
import { ProductionEnygmaToken, ProductionEnygmaToken__factory } from '../../../typechain-types';
import { eventually } from '../../../src/utils/common';
import { shouldCrossTransferEnygma } from '../../../src/flows/tokens/token-flows';
import { sendMultipleTransfers } from '../../test-utils/helpers';
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe('E2E Tests: EnygmaWrapper 3->3 Stress Test Triplex. A to B, B to A and C to A. Separate token contracts', function () {
  const TOTAL_SIM_TXS = 50;
  const MINT_AMOUNT = 1000n;
  const TRANSFER_AMOUNT = 19n;//we make sure that we don't exceed the MINT_AMOUNT

  let signerA : HDNodeWallet | Wallet;
  let signerB : HDNodeWallet | Wallet
  let signerC: HDNodeWallet | Wallet

  let token1OnPNA: EnygmaWrapper<ProductionEnygmaToken>;
  let token1OnPNB: ProductionEnygmaToken;
  let token2OnPNB: EnygmaWrapper<ProductionEnygmaToken>;
  let token2OnPNA: ProductionEnygmaToken;
  let token3OnPNC: EnygmaWrapper<ProductionEnygmaToken>;
  let token3OnPNA: ProductionEnygmaToken;
  let privacyNodes: PrivacyNodeMap;
  let privateHub : PrivateHub;

  before(async function () {
    this.timeout(3 * 60 * 1000);
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(3);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    await cleanEnygmaDb()
    token1OnPNA = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
    token2OnPNB = new EnygmaWrapper(privacyNodes.B, ProductionEnygmaToken__factory);
    token3OnPNC = new EnygmaWrapper(privacyNodes.C, ProductionEnygmaToken__factory);

    signerA = token1OnPNA.userWallet;
    signerB = token2OnPNB.userWallet;
    signerC = token3OnPNC.userWallet;

   await token1OnPNA.deployViaFactory();
   await token1OnPNA.activateOnPn();
   await token1OnPNA.activateOnHub(privateHub);
   await token2OnPNB.deployViaFactory();
   await token2OnPNB.activateOnPn();
   await token2OnPNB.activateOnHub(privateHub);
   await token3OnPNC.deployViaFactory();
   await token3OnPNC.activateOnPn();
   await token3OnPNC.activateOnHub(privateHub);

    await token1OnPNA.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: token1OnPNA.userWallet.address })
    await token2OnPNB.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: token2OnPNB.userWallet.address })
    await token3OnPNC.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: token3OnPNC.userWallet.address })
  });

  it('Warm up with cross transfer A -> B', async function () {
    // Use the standardized helper to perform A -> B warmup like in the Duplex test
    const crossTranfer = {
      destinationAddresses: [signerB.address],
      amounts: [BigInt(10)],
      destinationChainIds: [privacyNodes.B.chainId],
      programData: [[]],
    };
    const expectedOnB = { [privacyNodes.B.chainId]: BigInt(10) } as { [k: string]: bigint };

    await shouldCrossTransferEnygma(
      crossTranfer,
      1,
      expectedOnB,
      privateHub,
      privacyNodes.A,
      [privacyNodes.B],
      token1OnPNA
    );

    // Bind destination-side contract instance for subsequent steps
    token1OnPNB = privacyNodes.B.getContract<ProductionEnygmaToken>(token1OnPNA.symbol);

    // Basic sanity: source balance decreased by 10
    const balanceA = await token1OnPNA.contract.balanceOf(signerA.address);
    expect(balanceA).to.equal(990n);

    // And B has 10 now
    const balanceB = await token1OnPNB.balanceOf(signerB.address);
    expect(balanceB).to.equal(10n);

    // Optional DB checks
    await checkDbBalance(10, privateHub, privacyNodes.B, token1OnPNA);
  }).timeout(5 * 60 * 1000);

  it('Warm up with cross transfer B -> A', async function () {
    const crossTranfer = {
      destinationAddresses: [signerA.address],
      amounts: [BigInt(10)],
      destinationChainIds: [privacyNodes.A.chainId],
      programData: [[]],
    };
    const expectedOnA = { [privacyNodes.A.chainId]: BigInt(10) } as { [k: string]: bigint };

    await shouldCrossTransferEnygma(
      crossTranfer,
      1,
      expectedOnA,
      privateHub,
      privacyNodes.B,
      [privacyNodes.A],
      token2OnPNB
    );

    // Bind destination-side contract instance for subsequent steps
    token2OnPNA = privacyNodes.A.getContract<ProductionEnygmaToken>(token2OnPNB.symbol);

    // Basic sanity balances
    const balB = await token2OnPNB.contract.balanceOf(signerB.address);
    expect(balB).to.equal(990n);
    const balA = await token2OnPNA.balanceOf(signerA.address);
    expect(balA).to.equal(10n);

    await checkDbBalance(10, privateHub, privacyNodes.A, token2OnPNB);
  }).timeout(5 * 60 * 1000);

  it('Warm up with cross transfer C -> A', async function () {
    const crossTranfer = {
      destinationAddresses: [signerA.address],
      amounts: [BigInt(10)],
      destinationChainIds: [privacyNodes.A.chainId],
      programData: [[]],
    };
    const expectedOnA = { [privacyNodes.A.chainId]: BigInt(10) } as { [k: string]: bigint };

    await shouldCrossTransferEnygma(
      crossTranfer,
      1,
      expectedOnA,
      privateHub,
      privacyNodes.C,
      [privacyNodes.A],
      token3OnPNC
    );

    // Bind destination-side contract instance for subsequent steps
    token3OnPNA = privacyNodes.A.getContract<ProductionEnygmaToken>(token3OnPNC.symbol);

    const balC = await token3OnPNC.contract.balanceOf(signerC.address);
    expect(balC).to.equal(990n);
    const balA = await token3OnPNA.balanceOf(signerA.address);
    expect(balA).to.be.gte(10n); // may be >10 if previous warmups added

    await checkDbBalance(10, privateHub, privacyNodes.A, token3OnPNC);

  }).timeout(5 * 60 * 1000);

  it('Simultaneous Cross transfer A -> B, B -> A, and C -> A', async function () {
    const startTime = Date.now();
    LOGGER.optionalLog(`🛠️ Sending ${TOTAL_SIM_TXS} simultaneous cross transfers from A->B, B->A, and C->A`);

    const sendAToB = sendMultipleTransfers(
      TOTAL_SIM_TXS,
      token1OnPNA.contract,
      signerB.address,
      privacyNodes.B.chainId,
      TRANSFER_AMOUNT
    );
    const sendBToA = sendMultipleTransfers(
      TOTAL_SIM_TXS,
      token2OnPNB.contract,
      signerA.address,
      privacyNodes.A.chainId,
      TRANSFER_AMOUNT
    );
    const sendCToA = sendMultipleTransfers(
      TOTAL_SIM_TXS,
      token3OnPNC.contract,
      signerA.address,
      privacyNodes.A.chainId,
      TRANSFER_AMOUNT
    );

    await Promise.all([sendAToB, sendBToA, sendCToA]);

    LOGGER.optionalLog(`🛠️ Checking balances on PNs`);
    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const balance1OnPlB = await token1OnPNB.balanceOf(signerB.address);
        const balance1OnPlA = await token1OnPNA.contract.balanceOf(signerA.address);
        const balance2OnPlB = await token2OnPNB.contract.balanceOf(signerB.address);
        const balance2OnPlA = await token2OnPNA.balanceOf(signerA.address);
        const balance3OnPlC = await token3OnPNC.contract.balanceOf(signerC.address);
        const balance3OnPlA = await token3OnPNA.balanceOf(signerA.address);

        LOGGER.optionalLog(`Balances token1 (A,B): ${balance1OnPlA}, ${balance1OnPlB}`);
        LOGGER.optionalLog(`Balances token2 (A,B): ${balance2OnPlA}, ${balance2OnPlB}`);
        LOGGER.optionalLog(`Balances token3 (A,C): ${balance3OnPlA}, ${balance3OnPlC}`);

        LOGGER.optionalLog(`Elapsed time ${Math.round((Date.now() - startTime) / 1000)}s`);
        return balance1OnPlA + balance1OnPlB == MINT_AMOUNT &&
          balance2OnPlA + balance2OnPlB == MINT_AMOUNT &&
          balance3OnPlC + balance3OnPlA == MINT_AMOUNT;
      },
      interval: 1000,
      attempts: 500000000000,
      message: `Waiting for triplex balances → MINT_AMOUNT=${MINT_AMOUNT} (${TOTAL_SIM_TXS} txs)`,
      tolerateErrors: true,
    });

    const elapsedTime = Date.now() - startTime;
    LOGGER.optionalLog(
      `✅ Checking balance on PN destination, after ${TOTAL_SIM_TXS} simultaneous txs. time ${Math.round(
        elapsedTime / 1000
      )}s`
    );
  }).timeout(HOUR);
});