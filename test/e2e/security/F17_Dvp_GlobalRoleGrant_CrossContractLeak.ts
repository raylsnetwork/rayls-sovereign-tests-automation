/**
 * @title E2E SECURITY: F17 — Dvp global role grant leaks authority across contracts
 *
 * @description `Dvp.addEnygmaDvpIntegrationAddress` calls
 *              `RaylsAccessManagerV1.grantRole(ENYGMA_CREATOR, x, 0)` — a
 *              GLOBAL grant — instead of the scope-correct
 *              `grantContractScopedRole(..., address(this), 0)`.
 *              In the stock PNH deployment, `ENYGMA_CREATOR` is mapped to
 *              `EnygmaFactory.initiateEnygmaCreation` via
 *              `hardhat/tasks/deploy/private-hub.ts:280`. A global grant
 *              therefore satisfies `canCall` for EnygmaFactory as well —
 *              a genuine cross-contract authority leak on a stock,
 *              single-Dvp PNH.
 *
 *              This E2E exercises ONLY the `addEnygmaDvpIntegrationAddress`
 *              path against the live Dvp and EnygmaFactory. The Foundry
 *              counterpart (`F17_Dvp_GlobalRoleGrant_CrossContractLeak.t.sol`)
 *              covers the analogous COIN_VAULT leak through `registerVault`.
 *
 * EXPECTED BEHAVIOUR
 *   - Pre-fix: admin calls `addEnygmaDvpIntegrationAddress(attacker)`. A
 *     subsequent `canCall(attacker, enygmaFactory, initiateEnygmaCreation.sig)`
 *     returns `allowed=true`. Assertion `allowed == false` FAILS.
 *   - Post-fix: grant is scoped to Dvp only. canCall on EnygmaFactory returns
 *     `allowed=false`. Test PASSES.
 *
 * LIVE STATE IMPACT
 *   Pre-fix the attacker ends up with global ENYGMA_CREATOR. The `after`
 *   hook best-effort revokes it so subsequent tests are unpolluted.
 */

import { ethers } from 'ethers';
import { expect } from 'chai';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../src/config/env-config';
import { initializePrivacyNodesAndPnh } from '../../setup';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import {
  Dvp__factory,
  EnygmaFactory__factory,
  RaylsAccessManagerV1,
} from '../../../typechain-types';
import { createUserOperator } from '../../../src/utils/wallet-factory';
import { submitTx } from '../../../src/utils/common';

describe('E2E SECURITY: F17 — Dvp global role grant leaks ENYGMA_CREATOR into EnygmaFactory', function () {
  this.timeout(DEFAULT_TIMEOUT);

  let privateHub: PrivateHub;
  let attacker: ethers.HDNodeWallet;
  let manager: RaylsAccessManagerV1;
  let enygmaFactoryAddress: string;
  let enygmaCreatorRoleId: bigint;

  before(async function () {
    LOGGER.log('\n   ═══════════════════════════════════════════════════════════════');
    LOGGER.log('   F17: ENYGMA_CREATOR cross-contract leak — E2E setup');
    LOGGER.log('   ═══════════════════════════════════════════════════════════════');

    const { initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privateHub = initializedPNH;

    manager = await privateHub.getAccessManager();

    // EnygmaFactory address is registered in the DeploymentProxyRegistry under
    // the name `EnygmaFactory` (see private-hub.ts).
    enygmaFactoryAddress = privateHub.deployNamesAndAddresses['EnygmaFactory'];
    expect(enygmaFactoryAddress, 'EnygmaFactory address must be registered in the proxy registry').to.match(/^0x[0-9a-fA-F]{40}$/);

    enygmaCreatorRoleId = await manager.getRoleIdByName('ENYGMA_CREATOR');
    expect(enygmaCreatorRoleId > 0n, 'ENYGMA_CREATOR role must be registered').to.equal(true);

    attacker = createUserOperator(privateHub.provider);
    // No funding needed for this test — attacker is never the tx sender;
    // admin is the one calling addEnygmaDvpIntegrationAddress.

    LOGGER.log(`   PNH chainId          : ${(await privateHub.provider.getNetwork()).chainId}`);
    LOGGER.log(`   AccessManager        : ${await manager.getAddress()}`);
    LOGGER.log(`   Dvp                  : ${privateHub.dvpAddress}`);
    LOGGER.log(`   EnygmaFactory        : ${enygmaFactoryAddress}`);
    LOGGER.log(`   ENYGMA_CREATOR roleId: ${enygmaCreatorRoleId}`);
    LOGGER.log(`   Attacker             : ${attacker.address}`);
  });

  after(async function () {
    // Best-effort: revoke the attacker's global ENYGMA_CREATOR if it landed.
    try {
      const [isMember] = await manager.hasRole(enygmaCreatorRoleId, attacker.address);
      if (isMember) {
        LOGGER.log(`   Cleanup: revoking global ENYGMA_CREATOR from ${attacker.address}`);
        await submitTx(
          () => manager.connect(privateHub.adminWallet).revokeRole(
            enygmaCreatorRoleId, attacker.address, { gasLimit: GAS_LIMIT }
          ),
          'Cleanup: revoking global ENYGMA_CREATOR from attacker (PNH)',
        );
      }
    } catch (e) {
      LOGGER.log(`   Cleanup failed: ${e}`);
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  BASELINE  -  always pass
  // ════════════════════════════════════════════════════════════════════════════

  it('F17-E2E-baseline: canCall(attacker, EnygmaFactory, initiateEnygmaCreation.sig) is false before the grant', async function () {
    const selector = EnygmaFactory__factory.createInterface()
      .getFunction('initiateEnygmaCreation')!.selector;

    const [allowed, delay, paused] = await manager.canCall(
      attacker.address,
      enygmaFactoryAddress,
      selector
    );
    LOGGER.log(`   canCall(attacker, EnygmaFactory, initiateEnygmaCreation.sig) = (allowed=${allowed}, delay=${delay}, paused=${paused})`);
    expect(allowed, 'baseline: attacker canCall false on EnygmaFactory before the grant').to.equal(false);
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  EXPLOIT  -  FAILS pre-fix, PASSES post-fix
  // ════════════════════════════════════════════════════════════════════════════

  it('F17-E2E-exploit: addEnygmaDvpIntegrationAddress leaks ENYGMA_CREATOR onto EnygmaFactory', async function () {
    const dvpAsAdmin = Dvp__factory.connect(privateHub.dvpAddress, privateHub.adminWallet);

    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 1: admin calls dvp.addEnygmaDvpIntegrationAddress(attacker)');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    let grantReverted = false;
    let addTxHash: string | null = null;
    try {
      const tx = await dvpAsAdmin.addEnygmaDvpIntegrationAddress(attacker.address, { gasLimit: GAS_LIMIT });
      const receipt = await tx.wait();
      addTxHash = receipt!.hash;
      LOGGER.log(`   addEnygmaDvpIntegrationAddress SUCCEEDED — tx ${addTxHash}`);
    } catch (e: any) {
      grantReverted = true;
      LOGGER.log(`   addEnygmaDvpIntegrationAddress reverted: ${e?.shortMessage || e?.message}`);
    }

    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 2: inspect where ENYGMA_CREATOR now applies');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    const selectorDvp = Dvp__factory.createInterface().getFunction('depositEnygma')!.selector;
    const selectorFactory = EnygmaFactory__factory.createInterface()
      .getFunction('initiateEnygmaCreation')!.selector;

    const [canCallDvp] = await manager.canCall(attacker.address, privateHub.dvpAddress, selectorDvp);
    const [canCallFactory, delayFactory, pausedFactory] = await manager.canCall(
      attacker.address,
      enygmaFactoryAddress,
      selectorFactory
    );
    const [hasRoleGlobal] = await manager.hasRole(enygmaCreatorRoleId, attacker.address);
    LOGGER.log(`   attacker has GLOBAL ENYGMA_CREATOR         : ${hasRoleGlobal}`);
    LOGGER.log(`   canCall(attacker, Dvp, depositEnygma.sig)  : ${canCallDvp}  (intended)`);
    LOGGER.log(`   canCall(attacker, EnygmaFactory, initiate.sig): ${canCallFactory} delay=${delayFactory} paused=${pausedFactory}  (LEAK if true)`);

    if (canCallFactory) {
      LOGGER.log('\n   ╔══════════════════════════════════════════════════════════╗');
      LOGGER.log('   ║   F17 EXPLOIT REPRODUCED — CROSS-CONTRACT ROLE LEAK       ║');
      LOGGER.log('   ╚══════════════════════════════════════════════════════════╝');
      LOGGER.log(`   Attacker             : ${attacker.address}`);
      LOGGER.log(`   Intended scope       : ${privateHub.dvpAddress}  (Dvp)`);
      LOGGER.log(`   Leaked scope         : ${enygmaFactoryAddress}  (EnygmaFactory)`);
      LOGGER.log(`   Dvp grant tx         : ${addTxHash}`);
      LOGGER.log('   ───── ATTACK CHAIN ─────');
      LOGGER.log('   1. admin.dvp.addEnygmaDvpIntegrationAddress(attacker)');
      LOGGER.log('      Dvp internally calls grantRole(ENYGMA_CREATOR, attacker, 0) — GLOBAL.');
      LOGGER.log('      AccessManagerAuthLib._checkGlobalBitmap ORs ENYGMA_CREATOR against the');
      LOGGER.log('      selector bitmap of EVERY managed contract that maps it.');
      LOGGER.log('   2. EnygmaFactory.initiateEnygmaCreation is mapped to ENYGMA_CREATOR');
      LOGGER.log('      (hardhat/tasks/deploy/private-hub.ts:280). canCall returns true.');
      LOGGER.log('   3. Attacker can now call EnygmaFactory.initiateEnygmaCreation —');
      LOGGER.log('      an authority that should have been confined to Dvp.');
    }

    expect(
      canCallFactory,
      'F17 EXPLOIT: ENYGMA_CREATOR granted by Dvp leaked onto EnygmaFactory (global grant used instead of contract-scoped)'
    ).to.equal(false);
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  POSTFIX POSITIVE CONTROL  -  pass pre- and post-fix
  // ════════════════════════════════════════════════════════════════════════════

  it('F17-E2E-postfix: after the grant, Dvp-intended selectors STILL accept the attacker (fix does not over-constrain)', async function () {
    const selectorDvpDeposit = Dvp__factory.createInterface().getFunction('depositEnygma')!.selector;
    const selectorDvpWithdraw = Dvp__factory.createInterface().getFunction('withdrawEnygma')!.selector;
    const selectorDvpMix = Dvp__factory.createInterface().getFunction('mixFunds')!.selector;

    const [a1] = await manager.canCall(attacker.address, privateHub.dvpAddress, selectorDvpDeposit);
    const [a2] = await manager.canCall(attacker.address, privateHub.dvpAddress, selectorDvpWithdraw);
    const [a3] = await manager.canCall(attacker.address, privateHub.dvpAddress, selectorDvpMix);

    expect(a1, 'intended: attacker canCall Dvp.depositEnygma after grant').to.equal(true);
    expect(a2, 'intended: attacker canCall Dvp.withdrawEnygma after grant').to.equal(true);
    expect(a3, 'intended: attacker canCall Dvp.mixFunds after grant').to.equal(true);
  });
});
