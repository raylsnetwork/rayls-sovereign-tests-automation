/**
 * @title E2E: behavior contract for `RaylsContractFactoryV1.deploy()` on a live PN.
 *
 * The protocol-side factory differs from RN factory in three ways:
 *   - Init-call appends BOTH `EndpointV1` and `RNEndpointV1` addresses (RN appends only RN).
 *   - Init-call failures should surface a typed custom error.
 *   - This factory historically auto-granted ENDPOINT_SENDER to deployed contracts; the
 *     migration removes that auto-grant in favor of activation flows.
 *
 * Same scenario shape as the RN factory tests; helpers shared via `factory-helpers.ts`.
 */

import { expect } from 'chai';
import { concat, encodeBytes32String, hexlify, id, zeroPadValue } from 'ethers';
import { DEFAULT_TIMEOUT, LOGGER } from '../../../src/config/env-config';
import { initializePrivacyNodes, PrivacyNodeMap } from '../../setup';
import { createUserOperator } from '../../../src/utils/wallet-factory';
import { submitTx } from '../../../src/utils/common';
import {
  RaylsContractFactoryV1__factory,
  ReentrancyProbe98__factory,
  IRaylsInitializer__factory,
} from '../../../typechain-types';
import {
  buildSentinelRuntime,
  buildSelectorObservingRuntime,
  predictNextDeployAddress,
  selectorIsCallable,
} from './factory-helpers';

describe('RaylsContractFactoryV1 — deploy() behavior on live PN @authorization-gating @hubless', function () {
  let privacyNodes: PrivacyNodeMap;
  let factoryAddress: string;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    privacyNodes = await initializePrivacyNodes(1);
    const node = privacyNodes.A;

    factoryAddress = await node.resolveFromRegistry('ContractFactory');
    LOGGER.info(`RaylsContractFactory @ ${factoryAddress} on PN ${node.node}`);
    // operator/bank roles (which the access-control tests prank as) are granted by initializePrivacyNodes.
  });

  // ─────────────────────────────────────────────────────────────────
  //  Access control
  // ─────────────────────────────────────────────────────────────────

  it('random user (PUBLIC role only) cannot call deploy()', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario('A random EOA on PN A calls deploy(). Auth V3 must reject.');

    const randomUser = createUserOperator(privacyNodes.A.provider);
    const factory = RaylsContractFactoryV1__factory.connect(factoryAddress, randomUser);

    await expect(factory.deploy('0x00', '0x', encodeBytes32String('rnd')))
      .to.be.revertedWithCustomError(factory, 'RaylsAccessManaged__Unauthorized')
      .withArgs(randomUser.address);
  });

  it('BANK_EMPLOYEE wallet cannot call deploy()', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario('A bank-employee user calls deploy(). Business roles must NOT include factory deployment.');

    const wallet = privacyNodes.A.bankEmployeeWallet;
    const factory = RaylsContractFactoryV1__factory.connect(factoryAddress, wallet);

    await expect(factory.deploy('0x00', '0x', encodeBytes32String('be')))
      .to.be.revertedWithCustomError(factory, 'RaylsAccessManaged__Unauthorized')
      .withArgs(wallet.address);
  });

  it('PRIVACY_NODE_OPERATOR wallet cannot call deploy()', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario('A privacy-node operator calls deploy(). Operator scope must NOT include factory deployment.');

    const wallet = privacyNodes.A.operatorWallet;
    const factory = RaylsContractFactoryV1__factory.connect(factoryAddress, wallet);

    await expect(factory.deploy('0x00', '0x', encodeBytes32String('op')))
      .to.be.revertedWithCustomError(factory, 'RaylsAccessManaged__Unauthorized')
      .withArgs(wallet.address);
  });

  it('AccessManager grants deploy() only to FACTORY_ADMIN and FACTORY_DEPLOYER roles', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario('Read live AccessManager configuration for deploy() and verify the allowed-role list.');

    const manager = await privacyNodes.A.getAccessManager();
    const factory = RaylsContractFactoryV1__factory.connect(factoryAddress, privacyNodes.A.userWallet);
    const deploySel = factory.interface.getFunction('deploy').selector;

    const allowed = await manager.getFunctionAllowedRoles(factoryAddress, deploySel);
    const allowedSet = new Set(allowed.map((r) => r.toString()));

    const [factoryAdminId, factoryDeployerId, bankEmployeeId, operatorId] = await Promise.all([
      manager.getRoleIdByName('FACTORY_ADMIN'),
      manager.getRoleIdByName('FACTORY_DEPLOYER'),
      manager.getRoleIdByName('BANK_EMPLOYEE'),
      manager.getRoleIdByName('PRIVACY_NODE_OPERATOR'),
    ]);

    expect(allowedSet.has(factoryAdminId.toString())).to.equal(true);
    expect(allowedSet.has(factoryDeployerId.toString())).to.equal(true);
    expect(allowedSet.has(bankEmployeeId.toString())).to.equal(false);
    expect(allowedSet.has(operatorId.toString())).to.equal(false);
    expect(allowedSet.has('1')).to.equal(false); // PUBLIC role id = 1
  });

  // ─────────────────────────────────────────────────────────────────
  //  Bytecode integrity
  // ─────────────────────────────────────────────────────────────────

  it('factory stores 60-byte runtime exactly as supplied', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario('Operator deploys a 60-byte template (small-bytecode path).');

    const operator = await privacyNodes.A.makeRoleHolder('FACTORY_DEPLOYER');
    const factory = RaylsContractFactoryV1__factory.connect(factoryAddress, operator);

    const runtime = buildSentinelRuntime(60);
    const predicted = await predictNextDeployAddress(privacyNodes.A.provider, factoryAddress, runtime);
    await (await factory.deploy(runtime, '0x', encodeBytes32String('rt60'))).wait();
    const onChain = await privacyNodes.A.provider.getCode(predicted);

    expect(onChain.toLowerCase()).to.equal(runtime.toLowerCase());
  });

  it('factory stores 255-byte runtime exactly as supplied', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario('Boundary case for the small-bytecode path.');

    const operator = await privacyNodes.A.makeRoleHolder('FACTORY_DEPLOYER');
    const factory = RaylsContractFactoryV1__factory.connect(factoryAddress, operator);

    const runtime = buildSentinelRuntime(255);
    const predicted = await predictNextDeployAddress(privacyNodes.A.provider, factoryAddress, runtime);
    await (await factory.deploy(runtime, '0x', encodeBytes32String('rt255'))).wait();
    const onChain = await privacyNodes.A.provider.getCode(predicted);

    expect(onChain.toLowerCase()).to.equal(runtime.toLowerCase());
  });

  it('factory stores 256-byte runtime exactly as supplied', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario('First size on the large-bytecode path. Regression fence for the path independent from small.');

    const operator = await privacyNodes.A.makeRoleHolder('FACTORY_DEPLOYER');
    const factory = RaylsContractFactoryV1__factory.connect(factoryAddress, operator);

    const runtime = buildSentinelRuntime(256);
    const predicted = await predictNextDeployAddress(privacyNodes.A.provider, factoryAddress, runtime);
    await (await factory.deploy(runtime, '0x', encodeBytes32String('rt256'))).wait();
    const onChain = await privacyNodes.A.provider.getCode(predicted);

    expect(onChain.toLowerCase()).to.equal(runtime.toLowerCase());
  });

  // ─────────────────────────────────────────────────────────────────
  //  Init-call dispatch shape (typed dispatch — fix-asserting)
  //
  //  Factory dispatches the canonical IRaylsInitializer.initialize selector via
  //  abi.encodeCall. Caller-supplied bytes go into userArgs, not the function selector.
  //  Selector-binding migration.
  // ─────────────────────────────────────────────────────────────────

  it('factory dispatches the canonical IRaylsInitializer.initialize selector regardless of caller bytes', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario(
      'Operator deploys a probe via RaylsContractFactoryV1 with arbitrary initializerParams. ' +
      'Factory must dispatch the fixed canonical selector — caller bytes belong to userArgs only.',
    );

    const operator = await privacyNodes.A.makeRoleHolder('FACTORY_DEPLOYER');
    const factory = RaylsContractFactoryV1__factory.connect(factoryAddress, operator);

    const probeRuntime = buildSelectorObservingRuntime();
    const predicted = await predictNextDeployAddress(privacyNodes.A.provider, factoryAddress, probeRuntime);

    // Canonical selector derived from the typechain IRaylsInitializer interface so it tracks
    // the RaylsTrustedInit struct shape — never hardcode the ABI signature.
    const canonicalSelector = IRaylsInitializer__factory.createInterface().getFunction('initialize').selector;

    const callerBytes = concat([
      '0xdeadbeef',
      zeroPadValue('0x00', 32),
    ]);

    await (await factory.deploy(probeRuntime, callerBytes, encodeBytes32String('disp'))).wait();

    const slot0Hex = await privacyNodes.A.provider.getStorage(predicted, 0);
    const observedSelector = '0x' + BigInt(slot0Hex).toString(16).padStart(8, '0').slice(-8);

    expect(observedSelector.toLowerCase()).to.equal(canonicalSelector.toLowerCase(),
      'RaylsContractFactoryV1 must dispatch the fixed IRaylsInitializer.initialize selector regardless of caller-supplied bytes');
  });

  // ─────────────────────────────────────────────────────────────────
  //  Reentrancy
  // ─────────────────────────────────────────────────────────────────

  it('contract deployed by factory cannot re-enter deploy() during its init-call', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario(
      'Simulates a third-party integration contract that holds FACTORY_DEPLOYER and re-enters ' +
      'factory.deploy from its post-deploy fallback.',
    );

    const node = privacyNodes.A;
    const operator = await node.makeRoleHolder('FACTORY_DEPLOYER');
    const factory = RaylsContractFactoryV1__factory.connect(factoryAddress, operator);

    const probeContract = await new ReentrancyProbe98__factory(node.adminWallet).deploy(factoryAddress);
    await probeContract.waitForDeployment();
    const probeRuntime = await node.provider.getCode(await probeContract.getAddress());

    const predicted = await predictNextDeployAddress(node.provider, factoryAddress, probeRuntime);
    const manager = await node.getAccessManager();
    const factoryDeployerRoleId = await manager.getRoleIdByName('FACTORY_DEPLOYER');
    await submitTx(
      () => (manager.connect(node.adminWallet) as typeof manager)
        .grantRole(factoryDeployerRoleId, predicted, 0),
      'Pre-granting FACTORY_DEPLOYER to predicted reentrancy probe (PN A)',
    );

    await (await factory.deploy(probeRuntime, '0x', encodeBytes32String('reentry'))).wait();

    const slot1 = await node.provider.getStorage(predicted, 1);
    const innerSucceeded = BigInt(slot1) !== 0n;

    expect(innerSucceeded).to.equal(false,
      'inner factory.deploy() succeeded inside outer init-call — deploy() is reentrant on live PN');
  });

  // ─────────────────────────────────────────────────────────────────
  //  Storage layout
  // ─────────────────────────────────────────────────────────────────

  it('dead templateToImplementationAddress accessor is no longer callable', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario('Public mapping accessor was removed; selector must no longer resolve.');

    const sel = id('templateToImplementationAddress(uint8)').slice(0, 10);
    const callable = await selectorIsCallable(privacyNodes.A.provider, factoryAddress, sel);

    expect(callable).to.equal(false,
      'templateToImplementationAddress(uint8) accessor is still callable — dead mapping not removed');
  });

  // ─────────────────────────────────────────────────────────────────
  //  Init-call failure surface
  // ─────────────────────────────────────────────────────────────────

  it('factory reverts with custom error when the deployed contract reverts on init', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario(
      'Operator deploys bytecode whose first byte is INVALID (0xfe). Any call to the deployed ' +
      'contract reverts immediately, propagating a typed custom error from the factory.',
    );

    const operator = await privacyNodes.A.makeRoleHolder('FACTORY_DEPLOYER');
    const factory = RaylsContractFactoryV1__factory.connect(factoryAddress, operator);

    // 257-byte runtime starting with INVALID — exercises the PUSH2 init-code path.
    const arr = new Uint8Array(257);
    arr[0] = 0xfe;
    const runtime = hexlify(arr);

    await expect(factory.deploy(runtime, '0x', encodeBytes32String('initfail')))
      .to.be.revertedWithCustomError(factory, 'FactoryV1__InitializationFailed');
  });

  // ─────────────────────────────────────────────────────────────────
  //  ENDPOINT_SENDER auto-grant (current behavior sentinel)
  //
  //  factory.deploy() atomically grants ENDPOINT_SENDER to the deployed contract.
  //  Templates rely on the role to call endpoint.send. Cross-chain auto-deploy on
  //  receiver PNs depends on this grant — the alternative grant site
  //  (TokenRegistryReplicaV1.activateToken) only fires on the issuer chain.
  //  Pinning the behavior; removal requires a coordinated migration.
  // ─────────────────────────────────────────────────────────────────

  it('factory auto-grants ENDPOINT_SENDER to every contract it deploys', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario('After deploy, the deployed contract holds ENDPOINT_SENDER. Cross-chain auto-deploy on receiver PNs depends on this.');

    const operator = await privacyNodes.A.makeRoleHolder('FACTORY_DEPLOYER');
    const factory = RaylsContractFactoryV1__factory.connect(factoryAddress, operator);

    // Inert 256-byte runtime (PUSH2 path).
    const runtime = '0x' + '00'.repeat(256);
    const predicted = await predictNextDeployAddress(privacyNodes.A.provider, factoryAddress, runtime);
    await (await factory.deploy(runtime, '0x', encodeBytes32String('grant'))).wait();

    const manager = await privacyNodes.A.getAccessManager();
    const endpointSenderRoleId = await manager.getRoleIdByName('ENDPOINT_SENDER');
    const [hasEpSender] = await manager.hasRole(endpointSenderRoleId, predicted);

    expect(hasEpSender).to.equal(true,
      'auto-grant of ENDPOINT_SENDER on deploy() removed - cross-chain auto-deploy will produce non-functional tokens');
  });

  // ─────────────────────────────────────────────────────────────────
  //  CREATE2 determinism
  // ─────────────────────────────────────────────────────────────────

  it('CREATE2 deployment address matches the off-chain prediction', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario('Indexer pre-computes the next deployment address; on-chain deploy lands at exactly that address.');

    const operator = await privacyNodes.A.makeRoleHolder('FACTORY_DEPLOYER');
    const factory = RaylsContractFactoryV1__factory.connect(factoryAddress, operator);

    const runtime = buildSentinelRuntime(256);
    const predicted = await predictNextDeployAddress(privacyNodes.A.provider, factoryAddress, runtime);

    await (await factory.deploy(runtime, '0x', encodeBytes32String('create2'))).wait();
    const code = await privacyNodes.A.provider.getCode(predicted);

    expect(code.length).to.be.greaterThan(2,
      'no code at predicted address — CREATE2 prediction drifted from actual deployment');
  });
});
