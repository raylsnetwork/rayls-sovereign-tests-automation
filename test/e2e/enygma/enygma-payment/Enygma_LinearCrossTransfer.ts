import { expect } from 'chai';
import { ethers } from 'hardhat';
import { checkDbBalance } from '../../../../src/utils/db-utils';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
  RaylsArbitraryCallable,
  RaylsArbitraryCallable__factory,
  TemplateRegistryV1__factory,
  TemplateRegistryReplicaV1__factory,
} from '../../../../typechain-types';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { HDNodeWallet, Wallet } from 'ethers';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../../src/config/env-config';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { linearTransferEnygma } from '../../../../src/flows/tokens/token-flows';
import { createEnygmaProgramDataByResourceIds } from '../../../../src/utils/transfer-callables-utils';
import { eventually, submitTx } from '../../../../src/utils/common';

describe('E2E Tests: EnygmaWrapper LinearCrossTransfer', function () {
  let signerA : HDNodeWallet | Wallet;
  let signerB : HDNodeWallet | Wallet

  let tokenOnPNA: EnygmaWrapper<ProductionEnygmaToken>;
  let tokenOnPNB: ProductionEnygmaToken;
  let privacyNodes: PrivacyNodeMap;
  let privateHub : PrivateHub;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const {initializedNodes, initializedPNH} = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    tokenOnPNA = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
    signerA = tokenOnPNA.userWallet;
    signerB = tokenOnPNA.userWallet;
    // New token-registry flow: node-factory deploy as user (seeded codehash clears the
    // programmability gate), then PN-authorize + hub-activate.
    await tokenOnPNA.deployViaFactory();
    await tokenOnPNA.activateOnPn();
    await tokenOnPNA.activateOnHub(privateHub);
    await tokenOnPNA.mintAndAwait(privateHub, { amount: 1000n, toAddress: tokenOnPNA.userWallet.address });
  });

  it('Cross transfer A -> B @smoke', async function () {
    const enygmaLinearTransfer = {
      destinationAddress: signerB.address,
      amount: 10n,
      destinationChainId: privacyNodes.B.chainId,
      programData: []
    }

    const receipt = await linearTransferEnygma(enygmaLinearTransfer,
      2, 10n,
      privateHub,privacyNodes.A,privacyNodes.B,tokenOnPNA);

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

   LOGGER.log(`✅ Checking balance on PN destination`);
// Bind destination-side contract instance for subsequent steps
    tokenOnPNB = privacyNodes.B.getContract<ProductionEnygmaToken>(tokenOnPNA.symbol);
    tokenOnPNA.resourceId = await tokenOnPNB.resourceId();
   await checkDbBalance(990,privateHub,privacyNodes.A, tokenOnPNA)
    await checkDbBalance(10,privateHub,privacyNodes.B, tokenOnPNA)

    expect(await tokenOnPNA.contract.referenceIdStatus(referenceId)).to.be.equal(1);

    expect(await tokenOnPNB.referenceIdStatus(referenceId)).to.be.equal(2);

   LOGGER.log(`✅ Checking referenceIds Status`);
  }).timeout(5 * 60 * 1000);

  it('Cross transfer B -> A', async function () {
    const initialBalanceA = await tokenOnPNA.contract.balanceOf(signerA.address);
    const initialBalanceB = await tokenOnPNB.balanceOf(signerB.address);

   LOGGER.log(`🛠️ Sending some enygma from B to A`);

   const enygmaLinearTransfer = {
     destinationAddress: signerA.address,
     amount: 5n,
     destinationChainId: privacyNodes.A.chainId,
     programData: []
   }

    const receipt = await linearTransferEnygma(enygmaLinearTransfer,2,
      initialBalanceA + BigInt(5),
      privateHub,privacyNodes.B,privacyNodes.A,tokenOnPNA);

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

    LOGGER.log(`🛠️  Checking balance on PN destination`);

    const balanceOnPnA = await tokenOnPNA.contract.balanceOf(signerA.address);
    expect(balanceOnPnA).to.be.equal(initialBalanceA + BigInt(5));

    LOGGER.log(`✅ Checking balance on PN destination`);

    await checkDbBalance(Number(initialBalanceB - BigInt(5)),privateHub,privacyNodes.B, tokenOnPNA)
    await checkDbBalance(Number(initialBalanceA + BigInt(5)),privateHub,privacyNodes.A, tokenOnPNA)

    LOGGER.log(`🛠️  Checking referenceIds Status`);

    expect(await tokenOnPNA.contract.referenceIdStatus(referenceId)).to.be.equal(2);

    expect(await tokenOnPNB.referenceIdStatus(referenceId)).to.be.equal(1);

    LOGGER.log(`✅ Checking referenceIds Status`);
  }).timeout(5 * 60 * 1000);

  it('Cross transfer A -> B, with a call to RaylsArbitraryCallable', async function () {
    const initialBalanceAOnPNA = await tokenOnPNA.contract.balanceOf(signerA.address);
    const initialBalanceAOnPNB = await tokenOnPNB.balanceOf(signerB.address);

    // The userBlob target must clear the programmability gate: (target codehash, selector) has to be
    // an APPROVED template on PNH and replicated to PN B's replica, and the target must be resolvable
    // on B's endpoint by resourceId. Mirrors Enygma_Programmability's composed-transfer setup.
    const adminB = privacyNodes.B.adminWallet;
    const callableResourceId = ethers.encodeBytes32String('linear-callable');
    const setMessageSelector = ethers.id('setMessage(string)').slice(0, 10);
    const expectedMessageA = 'Hey';

    // 1. Deploy the gate-compatible callable on B (admin-signed); ctor stores its resourceId.
    const arbitratyCallableB: RaylsArbitraryCallable = await new RaylsArbitraryCallable__factory(adminB).deploy(
      callableResourceId,
      privacyNodes.B.endpointAddress,
      privacyNodes.B.raylsNodeEndpointAddress,
      { gasLimit: GAS_LIMIT },
    );
    await arbitratyCallableB.waitForDeployment();
    const callableAddress = await arbitratyCallableB.getAddress();
    expect(await arbitratyCallableB.getMessage()).to.eq('');

    // 2. Register resourceId → callable on B's endpoint so the executor resolves it natively.
    const endpointBAsAdmin = privacyNodes.B.getEndpointV1().connect(adminB) as ReturnType<typeof privacyNodes.B.getEndpointV1>;
    await submitTx(
      () => endpointBAsAdmin.registerResourceId(callableResourceId, callableAddress, { gasLimit: GAS_LIMIT }),
      'Registering callable resourceId on PN B endpoint',
    );

    // 3. Propose + approve a custom template for (codehash, setMessage) on PNH. Idempotent across
    //    re-runs: the codehash is stable, so guard each step on the current template state.
    const callableCodehash = ethers.keccak256(await privacyNodes.B.provider.getCode(callableAddress));
    const registryAddress = privateHub.deployNamesAndAddresses['TemplateRegistry'];
    const registry = TemplateRegistryV1__factory.connect(registryAddress, privateHub.operatorWallet);
    const templateKey = await registry.getKey(callableCodehash, setMessageSelector);
    const existing = await registry.getTemplate(templateKey);
    if (existing.bytecodeHash === ethers.ZeroHash)
      await submitTx(() => registry.propose(callableCodehash, 'setMessage(string)', { gasLimit: GAS_LIMIT }), 'Proposing setMessage template on PNH');
    if (!existing.approved)
      await submitTx(() => registry.approve(templateKey, { gasLimit: GAS_LIMIT }), 'Approving setMessage template on PNH');

    // 4. Wait for the approval to replicate to PN B's replica (the gate the executor consults).
    const replicaBAddr = await privacyNodes.B.resolveFromRegistry('TemplateRegistryReplica');
    const replicaB = TemplateRegistryReplicaV1__factory.connect(replicaBAddr, privacyNodes.B.provider);
    await eventually({
      check: async () => (await replicaB.getTemplate(templateKey)).approved,
      message: 'Waiting for setMessage template → PN B replica approval',
      tolerateErrors: true,
    });

    const programData = createEnygmaProgramDataByResourceIds(
      [callableResourceId],
      ['setMessage(string)'],
      [['string']],
      [[expectedMessageA]]
    );

    const enygmaLinearTransfer = {
      destinationAddress: signerB.address,
      amount: 10n,
      destinationChainId: privacyNodes.B.chainId,
      programData
    }

    const receipt = await linearTransferEnygma(enygmaLinearTransfer
      ,3,initialBalanceAOnPNB + BigInt(10),
      privateHub, privacyNodes.A, privacyNodes.B, tokenOnPNA);

    expect(receipt?.status).to.be.equal(1);

    const balance = await tokenOnPNA.contract.balanceOf(signerA.address);

    expect(balance).to.be.equal(initialBalanceAOnPNA - BigInt(10));

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


   LOGGER.log(`🛠️  Checking deploy of token PL destination`);
   const balanceOnPnB = await tokenOnPNB.balanceOf(signerB.address);
   expect(balanceOnPnB).to.equal(initialBalanceAOnPNB + BigInt(10));

   LOGGER.log(`✅ Checking balance on PN destination`);

   await checkDbBalance(Number(initialBalanceAOnPNA - BigInt(10)),privateHub,privacyNodes.A, tokenOnPNA)
    await checkDbBalance(Number(initialBalanceAOnPNB + BigInt(10)),privateHub,privacyNodes.B, tokenOnPNA)

    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const msgA = await arbitratyCallableB.getMessage();

        return msgA == expectedMessageA;
      },
      interval: 1000,
      attempts: DEFAULT_TIMEOUT / 1000,
      message: `Waiting for RaylsArbitraryCallable.getMessage → '${expectedMessageA}'`,
      tolerateErrors: true,
    });

   LOGGER.log(`🛠️  Checking referenceIds Status`);

    expect(await tokenOnPNA.contract.referenceIdStatus(referenceId)).to.be.equal(1);

    expect(await tokenOnPNB.referenceIdStatus(referenceId)).to.be.equal(2);

   LOGGER.log(`✅ Checking referenceIds Status`);
  }).timeout(5 * 60 * 1000);
});
