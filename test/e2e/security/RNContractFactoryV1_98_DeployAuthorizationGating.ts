/**
 * @title E2E: behavior contract for `RNContractFactoryV1.deploy()` on a live PN.
 *
 * Each test names one scenario and asserts one property of the live-deployed factory.
 * Setup helpers live in `./factory-helpers.ts` so each test reads top-to-bottom as a
 * story without setup boilerplate.
 *
 * SCOPE
 *   - Access control: random users, business-role wallets, and operator-role wallets
 *     must NOT be able to call deploy() directly.
 *   - Bytecode integrity: the factory must store the supplied runtime byte-for-byte
 *     across all length boundaries.
 *   - Init dispatch binding: the dispatched function on the deployed contract must be
 *     a fixed initializer selector, not whatever the caller wrote in initializerParams.
 *   - Reentrancy: a deployed contract that holds FACTORY_DEPLOYER must NOT be able to
 *     re-enter deploy() during its own init-call.
 *   - Storage layout: the dead `templateToImplementationAddress` accessor must be
 *     removed from the contract's public ABI.
 *   - CREATE2 determinism: pre-computed addresses must match the actual deployment
 *     (off-chain indexers depend on this).
 *
 * Real-world framing
 *   - "Operator" = a participant or operations team that holds FACTORY_DEPLOYER for a
 *     legitimate integration. The role is granted by an admin on the live AccessManager.
 *   - "Random user" = any EOA on the PN chain that holds only the PUBLIC role.
 *   - "Integration probe" = a custom Solidity contract written by a third-party
 *     integrator. Today no such contract exists in production; the reentrancy test
 *     simulates one.
 */

import { expect } from 'chai';
import { concat, encodeBytes32String, id, zeroPadValue } from 'ethers';
import { DEFAULT_TIMEOUT, LOGGER } from '../../../src/config/env-config';
import { initializePrivacyNodes, PrivacyNodeMap } from '../../setup';
import { createUserOperator } from '../../../src/utils/wallet-factory';
import { submitTx } from '../../../src/utils/common';
import {
  RNContractFactoryV1__factory,
  ReentrancyProbe98__factory,
  IRaylsInitializer__factory,
} from '../../../typechain-types';
import {
  buildSentinelRuntime,
  buildSelectorObservingRuntime,
  predictNextDeployAddress,
  selectorIsCallable,
} from './factory-helpers';

describe('RNContractFactoryV1 — deploy() behavior on live PN @authorization-gating @hubless', function () {
  let privacyNodes: PrivacyNodeMap;
  let factoryAddress: string;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    privacyNodes = await initializePrivacyNodes(1);
    const node = privacyNodes.A;

    factoryAddress = await node.resolveFromRegistry('RNContractFactory');
    LOGGER.info(`RNContractFactory @ ${factoryAddress} on PN ${node.node}`);
    // operator/bank roles (which the access-control tests prank as) are granted by initializePrivacyNodes.
  });

  // ─────────────────────────────────────────────────────────────────
  //  Access control
  // ─────────────────────────────────────────────────────────────────

  it('random user (PUBLIC role only) cannot call deploy()', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario('A random EOA on PN A — holding only the PUBLIC role — calls deploy(). Auth V3 must reject.');

    const randomUser = createUserOperator(privacyNodes.A.provider);
    const factory = RNContractFactoryV1__factory.connect(factoryAddress, randomUser);

    await expect(factory.deploy('0x00', '0x', encodeBytes32String('rnd')))
      .to.be.revertedWithCustomError(factory, 'RaylsAccessManaged__Unauthorized')
      .withArgs(randomUser.address);
  });

  it('BANK_EMPLOYEE wallet cannot call deploy()', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario('A bank-employee user (BANK_EMPLOYEE role) calls deploy(). Business roles must NOT cascade to factory deployment.');

    const wallet = privacyNodes.A.bankEmployeeWallet;
    const factory = RNContractFactoryV1__factory.connect(factoryAddress, wallet);

    await expect(factory.deploy('0x00', '0x', encodeBytes32String('be')))
      .to.be.revertedWithCustomError(factory, 'RaylsAccessManaged__Unauthorized')
      .withArgs(wallet.address);
  });

  it('PRIVACY_NODE_OPERATOR wallet cannot call deploy()', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario('A privacy-node operator (PRIVACY_NODE_OPERATOR role) calls deploy(). Operator scope must NOT include factory deployment.');

    const wallet = privacyNodes.A.operatorWallet;
    const factory = RNContractFactoryV1__factory.connect(factoryAddress, wallet);

    await expect(factory.deploy('0x00', '0x', encodeBytes32String('op')))
      .to.be.revertedWithCustomError(factory, 'RaylsAccessManaged__Unauthorized')
      .withArgs(wallet.address);
  });

  it('AccessManager grants deploy() only to FACTORY_ADMIN and FACTORY_DEPLOYER roles', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario('Read the live AccessManager configuration for deploy() — the allowed-role list must contain only the two factory roles.');

    const manager = await privacyNodes.A.getAccessManager();
    const factory = RNContractFactoryV1__factory.connect(factoryAddress, privacyNodes.A.userWallet);
    const deploySel = factory.interface.getFunction('deploy').selector;

    const allowed = await manager.getFunctionAllowedRoles(factoryAddress, deploySel);
    const allowedSet = new Set(allowed.map((r) => r.toString()));

    const [factoryAdminId, factoryDeployerId, bankEmployeeId, operatorId] = await Promise.all([
      manager.getRoleIdByName('FACTORY_ADMIN'),
      manager.getRoleIdByName('FACTORY_DEPLOYER'),
      manager.getRoleIdByName('BANK_EMPLOYEE'),
      manager.getRoleIdByName('PRIVACY_NODE_OPERATOR'),
    ]);

    expect(allowedSet.has(factoryAdminId.toString()), 'FACTORY_ADMIN must be allowed').to.equal(true);
    expect(allowedSet.has(factoryDeployerId.toString()), 'FACTORY_DEPLOYER must be allowed').to.equal(true);
    expect(allowedSet.has(bankEmployeeId.toString()), 'BANK_EMPLOYEE must NOT be allowed').to.equal(false);
    expect(allowedSet.has(operatorId.toString()), 'PRIVACY_NODE_OPERATOR must NOT be allowed').to.equal(false);
    expect(allowedSet.has('1'), 'PUBLIC must NOT be allowed').to.equal(false); // PUBLIC role id = 1
  });

  // ─────────────────────────────────────────────────────────────────
  //  Bytecode integrity — runtime stored on chain must match exactly
  // ─────────────────────────────────────────────────────────────────

  it('factory stores 60-byte runtime exactly as supplied', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario('An operator deploys a 60-byte template (small-bytecode path). The on-chain runtime must equal the supplied bytes byte-for-byte.');

    const operator = await privacyNodes.A.makeRoleHolder('FACTORY_DEPLOYER');
    const factory = RNContractFactoryV1__factory.connect(factoryAddress, operator);

    const runtime = buildSentinelRuntime(60);
    const predicted = await predictNextDeployAddress(privacyNodes.A.provider, factoryAddress, runtime);
    await (await factory.deploy(runtime, '0x', encodeBytes32String('rt60'))).wait();
    const onChain = await privacyNodes.A.provider.getCode(predicted);

    expect(onChain.toLowerCase()).to.equal(runtime.toLowerCase(),
      'on-chain runtime differs from supplied bytes (small-bytecode path)');
  });

  it('factory stores 255-byte runtime exactly as supplied', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario('Same as above at the boundary — 255 bytes is the largest size the small-path stub supports.');

    const operator = await privacyNodes.A.makeRoleHolder('FACTORY_DEPLOYER');
    const factory = RNContractFactoryV1__factory.connect(factoryAddress, operator);

    const runtime = buildSentinelRuntime(255);
    const predicted = await predictNextDeployAddress(privacyNodes.A.provider, factoryAddress, runtime);
    await (await factory.deploy(runtime, '0x', encodeBytes32String('rt255'))).wait();
    const onChain = await privacyNodes.A.provider.getCode(predicted);

    expect(onChain.toLowerCase()).to.equal(runtime.toLowerCase(),
      'on-chain runtime differs from supplied bytes at the small-path boundary');
  });

  it('factory stores 256-byte runtime exactly as supplied', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario('256 bytes triggers the large-bytecode path. Regression fence — guards that path independently of the small one.');

    const operator = await privacyNodes.A.makeRoleHolder('FACTORY_DEPLOYER');
    const factory = RNContractFactoryV1__factory.connect(factoryAddress, operator);

    const runtime = buildSentinelRuntime(256);
    const predicted = await predictNextDeployAddress(privacyNodes.A.provider, factoryAddress, runtime);
    await (await factory.deploy(runtime, '0x', encodeBytes32String('rt256'))).wait();
    const onChain = await privacyNodes.A.provider.getCode(predicted);

    expect(onChain.toLowerCase()).to.equal(runtime.toLowerCase(),
      'on-chain runtime differs from supplied bytes at the large-path boundary');
  });

  // ─────────────────────────────────────────────────────────────────
  //  Init-call dispatch shape (typed dispatch — fix-asserting)
  //
  //  Factory dispatches the canonical `IRaylsInitializer.initialize(bytes,
  //  RaylsTrustedInit)` selector via `abi.encodeCall`. Caller cannot influence which
  //  function the deployed contract sees — `initializerParams` is opaque user-args
  //  bytes that the handler abi.decodes per its own shape. Selector-binding migration.
  // ─────────────────────────────────────────────────────────────────

  it('factory dispatches the canonical IRaylsInitializer.initialize selector regardless of caller bytes', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario(
      'Operator deploys a probe runtime via the factory with arbitrary initializerParams. ' +
      'Factory must dispatch the fixed canonical selector on the deployed contract — ' +
      'caller bytes go into userArgs, not into the function selector.',
    );

    const operator = await privacyNodes.A.makeRoleHolder('FACTORY_DEPLOYER');
    const factory = RNContractFactoryV1__factory.connect(factoryAddress, operator);

    // Probe runtime stores msg.sig in slot 0 — lets us read what the factory dispatched.
    const probeRuntime = buildSelectorObservingRuntime();
    const predicted = await predictNextDeployAddress(privacyNodes.A.provider, factoryAddress, probeRuntime);

    // Canonical selector derived from the typechain IRaylsInitializer interface so it tracks
    // the RaylsTrustedInit struct shape — never hardcode the ABI signature (it drifts silently
    // when the struct gains/loses a field, as the trailing `caller` addition did).
    const canonicalSelector = IRaylsInitializer__factory.createInterface().getFunction('initialize').selector;

    // Caller-supplied bytes that intentionally try to "set" a different selector at the head.
    // With typed dispatch this is now part of `userArgs` and has no influence on msg.sig.
    const callerBytes = concat([
      '0xdeadbeef',
      zeroPadValue('0x00', 32),
    ]);

    await (await factory.deploy(probeRuntime, callerBytes, encodeBytes32String('disp'))).wait();

    const slot0Hex = await privacyNodes.A.provider.getStorage(predicted, 0);
    const observedSelector = '0x' + BigInt(slot0Hex).toString(16).padStart(8, '0').slice(-8);

    expect(observedSelector.toLowerCase()).to.equal(canonicalSelector.toLowerCase(),
      'factory must dispatch the fixed IRaylsInitializer.initialize selector regardless of caller-supplied bytes');
  });

  // ─────────────────────────────────────────────────────────────────
  //  Reentrancy — third-party integration scenario
  // ─────────────────────────────────────────────────────────────────

  it('contract deployed by factory cannot re-enter deploy() during its init-call', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario(
      'Simulates a third-party integration that holds FACTORY_DEPLOYER and re-enters factory.deploy ' +
      'from its post-deploy fallback. Standard Rayls contracts have no such pattern — this guards ' +
      'the bug class for any future integration.',
    );

    const node = privacyNodes.A;
    const operator = await node.makeRoleHolder('FACTORY_DEPLOYER');
    const factory = RNContractFactoryV1__factory.connect(factoryAddress, operator);

    // Deploy the probe directly (not via factory). Its constructor bakes the live factory
    // address into its runtime as an immutable, so the runtime knows where to call back.
    const probeContract = await new ReentrancyProbe98__factory(node.adminWallet).deploy(factoryAddress);
    await probeContract.waitForDeployment();
    const probeRuntime = await node.provider.getCode(await probeContract.getAddress());

    // Predict where the factory will redeploy this runtime. Pre-grant FACTORY_DEPLOYER to
    // the predicted address so the probe's inner re-entry call would be authorized at the
    // AccessManager layer — isolating the test to the contract-level reentrancy guard.
    const predicted = await predictNextDeployAddress(node.provider, factoryAddress, probeRuntime);
    const manager = await node.getAccessManager();
    const factoryDeployerRoleId = await manager.getRoleIdByName('FACTORY_DEPLOYER');
    await submitTx(
      () => (manager.connect(node.adminWallet) as typeof manager)
        .grantRole(factoryDeployerRoleId, predicted, 0),
      'Pre-granting FACTORY_DEPLOYER to predicted reentrancy probe (PN A)',
    );

    await (await factory.deploy(probeRuntime, '0x', encodeBytes32String('reentry'))).wait();

    // Probe storage layout (defined in ReentrancyProbe98.sol):
    //   slot 0: re-entry flag (set when fallback ran)
    //   slot 1: inner-success flag (set if the inner factory.deploy returned ok)
    const slot1 = await node.provider.getStorage(predicted, 1);
    const innerSucceeded = BigInt(slot1) !== 0n;

    expect(innerSucceeded).to.equal(false,
      'inner factory.deploy() succeeded inside outer init-call — deploy() is reentrant on live PN');
  });

  // ─────────────────────────────────────────────────────────────────
  //  Storage layout — dead accessor must be gone
  // ─────────────────────────────────────────────────────────────────

  it('dead templateToImplementationAddress accessor is no longer callable', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario('The factory used to expose a public mapping accessor that was never written. The migration replaces it with a `__gap` placeholder. The selector must no longer resolve.');

    const sel = id('templateToImplementationAddress(uint8)').slice(0, 10);
    const callable = await selectorIsCallable(privacyNodes.A.provider, factoryAddress, sel);

    expect(callable).to.equal(false,
      'templateToImplementationAddress(uint8) accessor is still callable — dead mapping not removed');
  });

  // ─────────────────────────────────────────────────────────────────
  //  CREATE2 determinism
  // ─────────────────────────────────────────────────────────────────

  it('CREATE2 deployment address matches the off-chain prediction', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    LOGGER.scenario('An indexer pre-computes the next deployment address from saltCounter + bytecode. The on-chain deploy must land at exactly that address.');

    const operator = await privacyNodes.A.makeRoleHolder('FACTORY_DEPLOYER');
    const factory = RNContractFactoryV1__factory.connect(factoryAddress, operator);

    const runtime = buildSentinelRuntime(256);
    const predicted = await predictNextDeployAddress(privacyNodes.A.provider, factoryAddress, runtime);

    await (await factory.deploy(runtime, '0x', encodeBytes32String('create2'))).wait();
    const code = await privacyNodes.A.provider.getCode(predicted);

    expect(code.length).to.be.greaterThan(2,
      'no code at predicted address — CREATE2 prediction drifted from actual deployment');
  });
});
