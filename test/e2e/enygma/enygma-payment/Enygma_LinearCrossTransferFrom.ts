import { expect } from 'chai';
import hre, { ethers } from 'hardhat';
import { HDNodeWallet, Wallet } from 'ethers';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import {  checkDbBalance } from '../../../../src/utils/db-utils';
import {
  ArbitraryCallable,
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
  TemplateRegistryV1__factory,
  TemplateRegistryReplicaV1__factory,
} from '../../../../typechain-types';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../../src/config/env-config';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { eventually, sendTx, submitTx } from '../../../../src/utils/common';
import { shortHex } from '../../../../src/utils/formatters';
import { createEnygmaProgramDataByAddresses } from '../../../../src/utils/transfer-callables-utils';
describe('E2E Tests: EnygmaWrapper LinearCrossTransferFrom', function () {
  let signerA : HDNodeWallet | Wallet;
  let signerB : HDNodeWallet | Wallet

  let tokenOnPNA: EnygmaWrapper<ProductionEnygmaToken>;
  let tokenOnPNB: ProductionEnygmaToken;
  let privacyNodes: PrivacyNodeMap;
  let privateHub : PrivateHub;

  const walletOther = ethers.Wallet.createRandom();

  let signerOtherA : HDNodeWallet | Wallet;
  let signerOtherB : HDNodeWallet | Wallet;

  // Shared ArbitraryCallable on PN B + its approved template, set up in `before`. The composed
  // A→B transfer carries a `receiveMsgA(string)` userBlob targeting this contract by address; the
  // destination executor gates (codehash, selector) against PN B's TemplateRegistryReplica, so the
  // template must be proposed+approved on PNH and replicated to B BEFORE the transfer — otherwise
  // executeProgramData reverts the whole mint and the destination balance never lands.
  let arbitraryCallableB: ArbitraryCallable;
  const receiveMsgASelector = ethers.id('receiveMsgA(string)').slice(0, 10);

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const {initializedNodes, initializedPNH} = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    tokenOnPNA = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
    signerA = tokenOnPNA.userWallet;
    signerB = tokenOnPNA.userWallet.connect(privacyNodes.B.provider);
    signerOtherA = walletOther.connect(privacyNodes.A.provider);
    signerOtherB = walletOther.connect(privacyNodes.B.provider);
    // New token-registry flow: node-factory deploy as user (seeded codehash clears the
    // programmability gate), then PN-authorize + hub-activate.
    await tokenOnPNA.deployViaFactory();
    await tokenOnPNA.activateOnPn();
    await tokenOnPNA.activateOnHub(privateHub);
    await tokenOnPNA.mintAndAwait(privateHub, { amount: 1000n, toAddress: signerA.address });

    // Deploy the ArbitraryCallable on PN B (the userBlob target for the composed A→B test) and
    // propose+approve a template for (its codehash, receiveMsgA selector) on PNH, then wait for the
    // approval to replicate to PN B's TemplateRegistryReplica — the gate the executor consults.
    const arbitraryCallableFactoryB = await hre.ethers.getContractFactory(
      'ArbitraryCallable', tokenOnPNA.userWallet.connect(privacyNodes.B.provider));
    arbitraryCallableB = await arbitraryCallableFactoryB.deploy();
    await arbitraryCallableB.waitForDeployment();

    const callableCodehash = ethers.keccak256(
      await privacyNodes.B.provider.getCode(await arbitraryCallableB.getAddress()));
    const registry = TemplateRegistryV1__factory.connect(
      privateHub.deployNamesAndAddresses['TemplateRegistry'], privateHub.operatorWallet);
    const templateKey = await registry.getKey(callableCodehash, receiveMsgASelector);

    // Idempotent across re-runs: codehash is bytecode-stable, so propose() reverts AlreadyRegistered
    // and approve() reverts AlreadyApproved on a repeat — guard each on the current template state.
    const existing = await registry.getTemplate(templateKey);
    if (existing.bytecodeHash === ethers.ZeroHash) {
      await submitTx(
        () => registry.propose(callableCodehash, 'receiveMsgA(string)', { gasLimit: GAS_LIMIT }),
        'Proposing receiveMsgA template on PNH');
    }
    if (!existing.approved) {
      await submitTx(
        () => registry.approve(templateKey, { gasLimit: GAS_LIMIT }),
        'Approving receiveMsgA template on PNH');
    }

    const replicaBAddr = await privacyNodes.B.resolveFromRegistry('TemplateRegistryReplica');
    const replicaB = TemplateRegistryReplicaV1__factory.connect(replicaBAddr, privacyNodes.B.provider);
    await eventually({
      check: async () => (await replicaB.getTemplate(templateKey)).approved,
      message: 'Waiting for receiveMsgA template → PN B replica approval',
      tolerateErrors: true,
    });
  });

  it('Should not Cross transfer A -> B, from another wallet without allowance', async function () {
    const tokenOnPNASignedByOtherWallet = tokenOnPNA.contract.connect(signerOtherA);
    const tx = tokenOnPNASignedByOtherWallet.linearCrossTransferFrom(signerA.address, signerB.address,
      10, privacyNodes.B.chainId, []);

    await expect(tx).to.be.revertedWithCustomError(tokenOnPNASignedByOtherWallet, 'ERC20InsufficientAllowance');
  }).timeout(5 * 60 * 1000);

  it('Cross transfer A -> B, from another wallet with allowance @smoke', async function () {
    const initialBlockNumber = await privateHub.provider.getBlockNumber();
    const tokenOnPNASignedByOtherWallet = tokenOnPNA.contract.connect(signerOtherA);
    const initialBalanceA = await tokenOnPNA.contract.balanceOf(signerA.address);

    // grant allowance to signerOtherA
    const receiptAllowance = await sendTx(() => tokenOnPNA.contract.connect(signerA).approve(signerOtherA.address, 10n));
    expect(receiptAllowance?.status).to.be.equal(1);

    const receipt = await sendTx(() => tokenOnPNASignedByOtherWallet.linearCrossTransferFrom(signerA.address, signerB.address,
      10, privacyNodes.B.chainId, []));
    expect(receipt?.status).to.be.equal(1);

    const balance = await tokenOnPNA.contract.balanceOf(signerA.address);
    expect(balance).to.be.equal(initialBalanceA - BigInt(10));

    // check remaining allowance and assert it is 0
    const allowanceAfter = await tokenOnPNA.contract.allowance(signerA.address, signerOtherA.address);
    expect(allowanceAfter).to.be.equal(BigInt(0));

    // retrying the same transaction should revert due to no allowance
    const txToRevert = tokenOnPNASignedByOtherWallet.linearCrossTransferFrom(signerA.address, signerB.address, 10,
      privacyNodes.B.chainId, []);
    await expect(txToRevert).to.be.revertedWithCustomError(tokenOnPNASignedByOtherWallet, 'ERC20InsufficientAllowance');

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

    let parsedEvent;
    try {
      parsedEvent = iface.parseLog(eventLog);
    } catch (error) {
      throw new Error('Error parsing the event log');
    }

    const referenceId = parsedEvent?.args?._referenceId;

    LOGGER.log(`🛠️  Waiting for the next block`);
    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const currentBlockNumber = await privateHub.provider.getBlockNumber();
        return currentBlockNumber > initialBlockNumber;
      },
      interval: 1000,
      attempts: 300,
      message: `Waiting for PNH block > ${initialBlockNumber} after linearCrossTransferFrom A→B`,
    });

    tokenOnPNB = await privacyNodes.B.setContractByResourceId<ProductionEnygmaToken>(
      ProductionEnygmaToken__factory.name, tokenOnPNA.resourceId, tokenOnPNA.symbol, tokenOnPNA.userWallet.connect(privacyNodes.B.provider));

    LOGGER.log(`✅ Checking deploy of token PL destination`);

    LOGGER.log(`🛠️  Checking balance on PN destination`);

    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const balanceOnPnB = await tokenOnPNB.balanceOf(signerB.address);

        if (balanceOnPnB == BigInt(10)) return true;
        return false;
      },
      interval: 1000,
      attempts: 300,
      message: `Waiting for ${tokenOnPNA.symbol} balance → 10 on PN B for ${shortHex(signerB.address)}`,
      tolerateErrors: true,
    });

    LOGGER.log(`✅ Checking balance on PN destination`);

    await checkDbBalance(Number(initialBalanceA - BigInt(10)),privateHub,privacyNodes.A,tokenOnPNA);

    LOGGER.log(`✅ Checking balance on database PN A, final r`);

    await checkDbBalance(10,privateHub,privacyNodes.B,tokenOnPNA);

    expect(await tokenOnPNA.contract.referenceIdStatus(referenceId)).to.be.equal(1);

    expect(await tokenOnPNB.referenceIdStatus(referenceId)).to.be.equal(2);

    LOGGER.log(`✅ Checking referenceIds Status`);
  }).timeout(5 * 60 * 1000);

  it('Should not Cross transfer B -> A, from another wallet without allowance', async function () {
    const tokenOnPNBSignedByOtherWallet = tokenOnPNB.connect(signerOtherB);
    const tx = tokenOnPNBSignedByOtherWallet.linearCrossTransferFrom(signerB.address, signerA.address,
      10, privacyNodes.A.chainId, []);

    await expect(tx).to.be.revertedWithCustomError(tokenOnPNBSignedByOtherWallet, 'ERC20InsufficientAllowance');
  }).timeout(5 * 60 * 1000);

  it('Cross transfer B -> A, from another wallet with allowance', async function () {
    const initialBlockNumber = await privateHub.provider.getBlockNumber();
    const initialBalanceA = await tokenOnPNA.contract.balanceOf(signerA.address);
    const initialBalanceB = await tokenOnPNB.balanceOf(signerB.address);
    const tokenOnPNBSignedByOtherWallet = tokenOnPNB.connect(signerOtherB);

    // grant allowance to signerOtherB
    const receiptAllowance = await sendTx(() => tokenOnPNB.connect(signerB).approve(signerOtherB.address, 5n));
    expect(receiptAllowance?.status).to.be.equal(1);

    LOGGER.log(`🛠️ Sending some enygma from B to A`);

    const receipt = await sendTx(() => tokenOnPNBSignedByOtherWallet.linearCrossTransferFrom(signerB.address, signerA.address,
      5n, privacyNodes.A.chainId, []));

    expect(receipt?.status).to.be.equal(1);

    // check remaining allowance and assert it is 0
    const allowanceAfter = await tokenOnPNB.allowance(signerB.address, signerOtherB.address);
    expect(allowanceAfter).to.be.equal(BigInt(0));

    // retrying the same transaction should revert due to no allowance
    const txToRevert = tokenOnPNBSignedByOtherWallet.linearCrossTransferFrom(signerB.address, signerA.address,
      5n, privacyNodes.A.chainId, []);
    await expect(txToRevert).to.be.revertedWithCustomError(tokenOnPNBSignedByOtherWallet, 'ERC20InsufficientAllowance');

    LOGGER.log(`✅ Sending some enygma from B to A`);

    LOGGER.log(`🛠️ Checking balance on PN B`);

    const balance = await tokenOnPNB.balanceOf(signerB.address);

    expect(balance).to.be.equal(initialBalanceB - BigInt(5));

    LOGGER.log(`✅ Checking balance on PN B `);

    LOGGER.log(`🛠️ Finding reference ID of this transfer...`);

    const iface = new ethers.Interface(['event crossTransferReferenceId(bytes32 _referenceId)']);

    const eventLog = receipt?.logs.find((log: any) => {
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

    let parsedEvent;
    try {
      parsedEvent = iface.parseLog(eventLog);
    } catch (error) {
      throw new Error('Error parsing the event log');
    }

    const referenceId = parsedEvent?.args?._referenceId;

    LOGGER.log(`✅ Finding reference ID of this transfer`);

    LOGGER.log(`🛠️  Waiting for the next block`);
    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const currentBlockNumber = await privateHub.provider.getBlockNumber();
        return currentBlockNumber > initialBlockNumber;
      },
      interval: 1000,
      attempts: 300,
      message: `Waiting for PNH block > ${initialBlockNumber} after linearCrossTransferFrom B→A (allowance)`,
    });
    LOGGER.log(`✅ Next block confirmed`);

    LOGGER.log(`🛠️  Checking balance on PN destination`);

    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const balanceOnPnA = await tokenOnPNA.contract.balanceOf(signerA.address);

        if (balanceOnPnA == initialBalanceA + BigInt(5)) return true;
        return false;
      },
      interval: 1000,
      attempts: 300,
      message: `Waiting for ${tokenOnPNA.symbol} balance → ${initialBalanceA + 5n} on PN A for ${shortHex(signerA.address)}`,
      tolerateErrors: true,
    });
    LOGGER.log(`✅ Checking balance on PN destination`);

    await checkDbBalance(Number(initialBalanceA + BigInt(5)), privateHub, privacyNodes.A,tokenOnPNA)

    LOGGER.log(`🛠️  Checking balance on database PN B`);

    await checkDbBalance(Number(initialBalanceB - BigInt(5)), privateHub, privacyNodes.B,tokenOnPNA)

    LOGGER.log(`🛠️  Checking referenceIds Status`);

    expect(await tokenOnPNA.contract.referenceIdStatus(referenceId)).to.be.equal(2);

    expect(await tokenOnPNB.referenceIdStatus(referenceId)).to.be.equal(1);

    LOGGER.log(`✅ Checking referenceIds Status`);
  }).timeout(5 * 60 * 1000);

  it('Cross transfer A -> B, with a call to ArbitraryCallable', async function () {
    const initialBlockNumber = await privateHub.provider.getBlockNumber();
    const initialBalanceAOnPNA = await tokenOnPNA.contract.balanceOf(signerA.address);
    const initialBalanceAOnPNB = await tokenOnPNB.balanceOf(signerB.address);
    const tokenOnPNASignedByOtherWallet = tokenOnPNA.contract.connect(signerOtherA);

    // grant allowance to signerOtherA
    const receiptAllowance = await sendTx(() => tokenOnPNA.contract.connect(signerA).approve(signerOtherA.address, 10));
    expect(receiptAllowance?.status).to.be.equal(1);

    // Reuse the ArbitraryCallable deployed + template-approved in `before` (the gate the executor
    // consults on PN B). Deploying a fresh instance here would produce the same codehash, so the
    // approved template still applies — but reusing keeps the approved target unambiguous.
    expect(await arbitraryCallableB.message()).to.eq('');

    const programData = createEnygmaProgramDataByAddresses([await arbitraryCallableB.getAddress()], ['receiveMsgA(string)'], [['string']], [['Hey']]);

    const receipt = await sendTx(() => tokenOnPNASignedByOtherWallet.linearCrossTransferFrom(
      signerA.address,
      signerB.address,
      10n,
      privacyNodes.B.chainId,
      programData
    ));
    expect(receipt?.status).to.be.equal(1);

    const balance = await tokenOnPNA.contract.balanceOf(signerA.address);
    expect(balance).to.be.equal(initialBalanceAOnPNA - BigInt(10));

    // check remaining allowance and assert it is 0
    const allowanceAfter = await tokenOnPNA.contract.allowance(signerA.address, signerOtherA.address);
    expect(allowanceAfter).to.be.equal(BigInt(0));

    // retrying the same transaction should revert due to no allowance
    const txToRevert = tokenOnPNASignedByOtherWallet.linearCrossTransferFrom(
      signerA.address,
      signerB.address,
      10n,
      privacyNodes.B.chainId,
      programData
    );

    await expect(txToRevert).to.be.revertedWithCustomError(tokenOnPNASignedByOtherWallet, 'ERC20InsufficientAllowance');

    const iface = new ethers.Interface(['event crossTransferReferenceId(bytes32 _referenceId)']);

    const eventLog = receipt?.logs.find((log: any) => {
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

    let parsedEvent;
    try {
      parsedEvent = iface.parseLog(eventLog);
    } catch (error) {
      throw new Error('Error parsing the event log');
    }

    const referenceId = parsedEvent?.args?._referenceId;

    LOGGER.log(`🛠️  Waiting for the next block`);
    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const currentBlockNumber = await privateHub.provider.getBlockNumber();
        return currentBlockNumber > initialBlockNumber;
      },
      interval: 1000,
      attempts: 300,
      message: `Waiting for PNH block > ${initialBlockNumber} after linearCrossTransferFrom A→B (arbitrary call)`,
    });
    LOGGER.log(`✅ Next block confirmed`);

    LOGGER.log(`🛠️  Checking balance on PN destination`);

    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const balanceOnPnB = await tokenOnPNB.balanceOf(signerB.address);

        if (balanceOnPnB == initialBalanceAOnPNB + BigInt(10)) return true;
        return false;
      },
      interval: 1000,
      attempts: 300,
      message: `Waiting for ${tokenOnPNA.symbol} balance → ${initialBalanceAOnPNB + 10n} on PN B for ${shortHex(signerB.address)}`,
      tolerateErrors: true,
    });

    LOGGER.log(`✅ Checking balance on PN destination`);

    await checkDbBalance(Number(initialBalanceAOnPNA - BigInt(10)), privateHub, privacyNodes.A,tokenOnPNA)

      LOGGER.log(`🛠️  Checking balance on database PN B`);

    await checkDbBalance(Number(initialBalanceAOnPNB + BigInt(10)), privateHub, privacyNodes.B,tokenOnPNA)

      LOGGER.log(`🛠️  Checking balance on EnygmaWrapper PN B`);


    const expectedMessageA = 'Hey';
    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const msgA = await arbitraryCallableB.message();

        return msgA == expectedMessageA;
      },
      interval: 1000,
      attempts: 300,
      message: `Waiting for arbitratyCallableB.msgA → '${expectedMessageA}'`,
      tolerateErrors: true,
    });

    LOGGER.log(`🛠️  Checking referenceIds Status`);

    expect(await tokenOnPNA.contract.referenceIdStatus(referenceId)).to.be.equal(1);

    expect(await tokenOnPNB.referenceIdStatus(referenceId)).to.be.equal(2);

    LOGGER.log(`✅ Checking referenceIds Status`);
  }).timeout(5 * 60 * 1000);
});
