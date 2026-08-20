// NOTE: Teleport is only the vehicle for a live non-teleport feature — migrate to Enygma/DVP on removal; do not delete this test.
/**
 * @title E2E SECURITY: CustomTokenExample access-control gaps
 * @description Two bugs reported via PR review against `CustomTokenExample.sol`. Both
 *              affect the live cross-chain flow:
 *
 *   #1 (HIGH) — `initialize(bytes,RaylsTrustedInit)` overrides the parent and forgets to
 *               call `_registerAccessControl(trusted.owner)`. After a factory-path deploy
 *               (e.g. cross-chain auto-deploy via `ContractFactory.deploy`), the deployed
 *               instance has NO MESSAGE_EXECUTOR-gated selectors registered on the
 *               AccessManager. Cross-chain `receiveTeleport*` and friends silently fail.
 *
 *   #2 (HIGH) — `unlockToResourceId(bytes32, uint256)` is `external` without `restricted`.
 *               Any address can call it. The analogous base-class `unlock` IS restricted.
 *
 * Test polarity: each test is "fix-asserting" — it FAILS while the bug is present and
 *                PASSES after the fix is applied.
 *
 * Deploy path: factory-only. Direct constructor-deploy of CustomTokenExample reverts in a
 *              live env because the constructor double-registers (parent's
 *              `_registerAccessControl` + body's explicit `selfRegisterManagedContract` both
 *              hit the AccessManager → `ContractAlreadyRegistered`). Tests load the
 *              `deployedBytecode` from the artifacts JSON and dispatch via
 *              `ContractFactory.deploy(...)` — exactly the cross-chain auto-deploy path.
 *
 * Live env: requires the standard `start_dev.sh --clean N` docker stack (relayers up,
 *           participants synced).
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../src/config/env-config';
import { initializePrivacyNodes, PrivacyNodeMap } from '../../setup';
import { createUserOperator } from '../../../src/utils/wallet-factory';
import { retry, submitTx } from '../../../src/utils/common';
import { isNonceError } from '../../../src/exceptions-and-errors/block-chain-exceptions';
import {
  CustomTokenExample__factory,
  RaylsContractFactoryV1__factory,
} from '../../../typechain-types';
import { AbiCoder, encodeBytes32String, HDNodeWallet, id, parseEther, ZeroAddress } from 'ethers';

const RECEIVE_TELEPORT_SEL = id('receiveTeleport(address,uint256)').slice(0, 10);

/**
 * Read CustomTokenExample's runtime (`deployedBytecode`) directly from the artifacts JSON.
 * Cannot use `__factory(signer).deploy(...)` because the constructor double-registers in
 * the live AccessManager and reverts.
 */
function loadCustomTokenRuntime(): string {
  const artifactPath = path.join(
    __dirname,
    '..',
    '..',
    '..',
    'artifacts',
    'contracts',
    'remote',
    'rayls-protocol',
    'test-contracts',
    'CustomTokenExample.sol',
    'CustomTokenExample.json',
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf-8'));
  if (!artifact.deployedBytecode || artifact.deployedBytecode === '0x') {
    throw new Error(`CustomTokenExample artifact missing deployedBytecode: ${artifactPath}`);
  }
  return artifact.deployedBytecode as string;
}

describe('E2E Security: CustomTokenExample access control @custom-token-ac @hubless', function () {
  let privacyNodes: PrivacyNodeMap;
  let factoryAddress: string;
  let runtime: string;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    privacyNodes = await initializePrivacyNodes(1);
    factoryAddress = await privacyNodes.A.resolveFromRegistry('ContractFactory');
    runtime = loadCustomTokenRuntime();
    LOGGER.info(`ContractFactory @ ${factoryAddress} on PN ${privacyNodes.A.node}`);
  });

  /** Fund a fresh EOA so it can pay gas on the live PN. */
  async function makeFundedWallet(): Promise<HDNodeWallet> {
    const w = createUserOperator(privacyNodes.A.provider);
    // 0.1 ETH covers the handful of (mostly reverting) attacker txs with margin; each wallet is a
    // throwaway per run, so keep the per-run drain on a long-lived env low (was 1 ETH × N wallets).
    await retry(
      () => privacyNodes.A.adminWallet.sendTransaction({
        to: w.address,
        value: parseEther('0.1'),
      }).then(t => t.wait()),
      { retryIf: isNonceError, onRetry: (_e, i) => LOGGER.error(`[TX RETRY] nonce funding attempt ${i}`) },
    );
    return w;
  }

  /**
   * Encode the 5-tuple userArgs that `CustomTokenExample.initialize(bytes,RaylsTrustedInit)`
   * expects: (string name, string symbol, uint256 fundManagerChainId, address fundManagerAddr,
   * bytes32 attestationUuid).
   */
  function encodeCustomTokenInitArgs(): string {
    return AbiCoder.defaultAbiCoder().encode(
      ['string', 'string', 'uint256', 'address', 'bytes32'],
      ['CustomTok', 'CTK', 0n, ZeroAddress, encodeBytes32String('attest-1')],
    );
  }

  /** Deploy CustomTokenExample's runtime via `ContractFactory.deploy(...)`. Returns address. */
  async function deployCustomTokenViaFactory(suffix: string): Promise<string> {
    const operator = await privacyNodes.A.makeRoleHolder('FACTORY_DEPLOYER');
    const factory = RaylsContractFactoryV1__factory.connect(factoryAddress, operator);
    const userArgs = encodeCustomTokenInitArgs();
    const resourceId = encodeBytes32String(`ctx-${suffix}-${Date.now()}`);

    const tx = await factory.deploy(runtime, userArgs, resourceId, { gasLimit: GAS_LIMIT });
    const rcpt = await tx.wait();
    const ev = rcpt!.logs
      .map(l => { try { return factory.interface.parseLog(l as any); } catch { return null; } })
      .find(p => p && p.name === 'ContractDeployed');
    expect(ev, 'ContractDeployed event must be emitted').to.not.be.null;
    const addr = (ev as any).args.deployedAddress as string;
    LOGGER.info(`factory-deployed CustomTokenExample @ ${addr}`);
    return addr;
  }

  // ─────────────────────────────────────────────────────────────────
  //  Bug #1 — initialize override forgets _registerAccessControl
  // ─────────────────────────────────────────────────────────────────

  it('factory-deployed CustomTokenExample registers MESSAGE_EXECUTOR-gated selectors on the AccessManager (#1)', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const node = privacyNodes.A;
    const factoryDeployed = await deployCustomTokenViaFactory('bug1');

    // Assertion: an address holding MESSAGE_EXECUTOR can call `receiveTeleport` on the
    // deployed contract. Tested via AccessManager.canCall(caller, target, selector).
    //
    // Pre-fix (bug present): _registerAccessControl is NOT called by initialize, so the
    // target+selector mapping is missing on the AccessManager. canCall returns false →
    // assertion fails → test fails.
    //
    // Post-fix: _registerAccessControl is called by initialize, mapping is registered →
    // canCall returns true → assertion holds → test passes.
    const manager = await node.getAccessManager();
    const messageExecutorRoleId = await manager.getRoleIdByName('MESSAGE_EXECUTOR');
    const execWallet = await makeFundedWallet();
    await submitTx(
      () => (manager.connect(node.adminWallet) as typeof manager)
        .grantRole(messageExecutorRoleId, execWallet.address, 0),
      'Granting MESSAGE_EXECUTOR to exec wallet (PN A, CustomToken #1)',
    );

    const [allowed] = await manager.canCall(execWallet.address, factoryDeployed, RECEIVE_TELEPORT_SEL);
    expect(
      allowed,
      'MESSAGE_EXECUTOR should be allowed to call receiveTeleport on factory-deployed CustomTokenExample (initialize must register access control)',
    ).to.equal(true);
  });

  // ─────────────────────────────────────────────────────────────────
  //  Bug #2 — unlockToResourceId missing `restricted`
  // ─────────────────────────────────────────────────────────────────

  it('unlockToResourceId on factory-deployed CustomTokenExample is access-controlled (#2)', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const factoryDeployed = await deployCustomTokenViaFactory('bug2');
    const attacker = await makeFundedWallet();
    const tokenAsAttacker = CustomTokenExample__factory.connect(factoryDeployed, attacker);
    const fakeResourceId = encodeBytes32String('does-not-exist');

    // Diagnostics — log AccessManager state for the unlockToResourceId selector before
    // attempting the call. Pre-fix (no `restricted`): selector unmapped on AccessManager,
    // call enters body. Post-fix: selector reaches `restricted` modifier → reverts.
    const node = privacyNodes.A;
    const manager = await node.getAccessManager();
    const unlockToRidSel = id('unlockToResourceId(bytes32,uint256)').slice(0, 10);
    const [allowed, , paused] = await manager.canCall(attacker.address, factoryDeployed, unlockToRidSel);
    LOGGER.info(`canCall(attacker, deployed, unlockToResourceId) -> allowed=${allowed} paused=${paused}`);

    // Use eth_call (provider.call) directly so we receive the revert data — sendTransaction
    // on the live PN can return a status=0 receipt without populating revert data, which
    // breaks `revertedWithCustomError`.
    const populated = await tokenAsAttacker.unlockToResourceId.populateTransaction(fakeResourceId, 0n);
    let revertData = '';
    try {
      await node.provider.call({ to: factoryDeployed, data: populated.data, from: attacker.address });
      throw new Error('unlockToResourceId did NOT revert (call succeeded)');
    } catch (e: any) {
      revertData = e.data || e.error?.data || (e.info && e.info.error && e.info.error.data) || '';
      LOGGER.info(`unlockToResourceId revert data: ${revertData || '(none)'}`);
    }

    // Assertion: revert data MUST encode `RaylsAccessManaged__Unauthorized(attacker)`.
    // Pre-fix (no `restricted`): revert is from internal logic (e.g. unnamed `require(to != 0)`)
    // and selector mismatches → test fails. Post-fix: revert selector matches the typed error.
    const expectedSelector = id('RaylsAccessManaged__Unauthorized(address)').slice(0, 10);
    expect(
      revertData.startsWith(expectedSelector),
      `unlockToResourceId revert data should start with RaylsAccessManaged__Unauthorized selector ${expectedSelector}, got ${revertData}`,
    ).to.equal(true);
  });

  // ─────────────────────────────────────────────────────────────────
  //  Bug #1 secondary — every MESSAGE_EXECUTOR-gated selector should be reachable
  //  by MESSAGE_EXECUTOR after fix. Pre-fix none are; post-fix all are.
  //  The list mirrors RaylsErc20Handler._registerAccessControl's `executorSels`
  //  (7 selectors). NOTE: resourceId assignment is NOT here — `receiveResourceId`
  //  was removed; the token-registry model uses `RaylsApp.setResourceId(bytes32)`,
  //  gated by `msg.sender == tokenRegistry` (not a MESSAGE_EXECUTOR role). Do NOT
  //  re-add it to this list.
  // ─────────────────────────────────────────────────────────────────

  it('every MESSAGE_EXECUTOR-gated selector is reachable post-fix (#1 supplementary)', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const node = privacyNodes.A;
    const factoryDeployed = await deployCustomTokenViaFactory('bug1-extra');

    const manager = await node.getAccessManager();
    const messageExecutorRoleId = await manager.getRoleIdByName('MESSAGE_EXECUTOR');
    const exec = await makeFundedWallet();
    await submitTx(
      () => (manager.connect(node.adminWallet) as typeof manager)
        .grantRole(messageExecutorRoleId, exec.address, 0),
      'Granting MESSAGE_EXECUTOR to exec wallet (PN A, CustomToken #1 supplementary)',
    );

    const selectors: { name: string; selector: string }[] = [
      { name: 'receiveTeleport', selector: id('receiveTeleport(address,uint256)').slice(0, 10) },
      { name: 'receiveTeleportAtomic', selector: id('receiveTeleportAtomic(address,uint256)').slice(0, 10) },
      { name: 'revertTeleportMint', selector: id('revertTeleportMint(address,uint256)').slice(0, 10) },
      { name: 'revertTeleportBurn', selector: id('revertTeleportBurn(address,uint256)').slice(0, 10) },
      { name: 'unlock', selector: id('unlock(address,uint256)').slice(0, 10) },
      { name: 'receiveTeleportFromPublicChain', selector: id('receiveTeleportFromPublicChain(address,uint256)').slice(0, 10) },
      { name: 'revertTeleportToPublicChain', selector: id('revertTeleportToPublicChain(address,uint256)').slice(0, 10) },
    ];

    for (const { name, selector } of selectors) {
      const [allowed] = await manager.canCall(exec.address, factoryDeployed, selector);
      expect(allowed, `MESSAGE_EXECUTOR should be allowed to call ${name} on factory-deployed CustomTokenExample`).to.equal(true);
    }
  });
});
