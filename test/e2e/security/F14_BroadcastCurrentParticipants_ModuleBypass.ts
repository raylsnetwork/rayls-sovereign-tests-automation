/**
 * @title E2E SECURITY: F14 — `broadcastCurrentParticipants` module-level auth bypass
 *
 * @description The facade `ParticipantStorageV1.broadcastCurrentParticipants()`
 *              is correctly `restricted`. Its underlying module
 *              `ParticipantCoreV1.broadcastCurrentParticipants(uint256)` is
 *              NOT guarded by `onlyParticipantStorage`, so any caller can
 *              invoke it directly at the deployed module address with an
 *              arbitrary `fromChainId` — triggering a protocol-wide cross-chain
 *              participant broadcast on behalf of a forged origin.
 *
 * EXPECTED BEHAVIOUR
 *   - Pre-fix: attacker's direct call to the module succeeds. The assertion
 *     that it must revert fails. Test FAILS and logs the forged broadcast tx.
 *   - Post-fix: the call reverts with `ParticipantCoreV1__UnauthorizedCaller`.
 *     Test PASSES.
 */

import { ethers } from 'ethers';
import { expect } from 'chai';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../src/config/env-config';
import { initializePrivacyNodesAndPnh } from '../../setup';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import {
  ParticipantStorageV1__factory,
  ParticipantCoreV1__factory,
  RaylsAccessManagerV1__factory,
} from '../../../typechain-types';
import { createUserOperator } from '../../../src/utils/wallet-factory';

describe('E2E SECURITY: F14 — ParticipantCoreV1.broadcastCurrentParticipants module-direct bypass', function () {
  this.timeout(DEFAULT_TIMEOUT);

  let privateHub: PrivateHub;
  let attacker: ethers.HDNodeWallet;
  let participantCoreAddress: string;

  before(async function () {
    LOGGER.log('\n   ═══════════════════════════════════════════════════════════════');
    LOGGER.log('   F14: ParticipantCore module-direct broadcast bypass — E2E setup');
    LOGGER.log('   ═══════════════════════════════════════════════════════════════');

    const { initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privateHub = initializedPNH;

    // Resolve the live module address via the facade.
    const facade = ParticipantStorageV1__factory.connect(
      privateHub.participantStorageAddress,
      privateHub.adminWallet
    );
    participantCoreAddress = await facade.getParticipantCore();

    attacker = createUserOperator(privateHub.provider);
    // Fund for 1 tx.
    await (await privateHub.adminWallet.sendTransaction({
      to: attacker.address,
      value: ethers.parseEther('0.2'),
    })).wait();

    LOGGER.log(`   PNH chainId          : ${(await privateHub.provider.getNetwork()).chainId}`);
    LOGGER.log(`   ParticipantStorage   : ${privateHub.participantStorageAddress}`);
    LOGGER.log(`   ParticipantCore      : ${participantCoreAddress}`);
    LOGGER.log(`   Attacker (no roles)  : ${attacker.address}`);
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  BASELINE  -  always pass
  // ════════════════════════════════════════════════════════════════════════════

  it('F14-E2E-baseline: canCall(attacker, participantCore, broadcastCurrentParticipants.sig) is false', async function () {
    const manager = await privateHub.getAccessManager();
    const selector = ParticipantCoreV1__factory.createInterface()
      .getFunction('broadcastCurrentParticipants')!.selector;

    const [allowed, delay, paused] = await manager.canCall(
      attacker.address,
      participantCoreAddress,
      selector
    );
    LOGGER.log(`   canCall(attacker, core, broadcastCurrentParticipants.sig) = (allowed=${allowed}, delay=${delay}, paused=${paused})`);
    expect(allowed, 'baseline: canCall false on the module at the manager layer').to.equal(false);

    // Sanity: calling the facade's `broadcastCurrentParticipants()` also reverts.
    const facadeAsAttacker = ParticipantStorageV1__factory.connect(
      privateHub.participantStorageAddress,
      attacker
    );
    let facadeReverted = false;
    try {
      const tx = await facadeAsAttacker.broadcastCurrentParticipants({ gasLimit: GAS_LIMIT });
      await tx.wait();
    } catch {
      facadeReverted = true;
    }
    expect(facadeReverted, 'baseline: facade broadcastCurrentParticipants must revert for non-admin').to.equal(true);
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  EXPLOIT  -  FAILS pre-fix, PASSES post-fix
  // ════════════════════════════════════════════════════════════════════════════

  it('F14-E2E-exploit: attacker calls ParticipantCoreV1.broadcastCurrentParticipants DIRECTLY on the module — must revert', async function () {
    const coreAsAttacker = ParticipantCoreV1__factory.connect(participantCoreAddress, attacker);

    // Any attacker-chosen fromChainId is fine — we only care that the call lands.
    const attackerChoseChainId = 424242;

    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 1: Attacker calls module DIRECTLY with a forged fromChainId');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    LOGGER.log(`   Target (module)      : ${participantCoreAddress}`);
    LOGGER.log(`   Forged fromChainId   : ${attackerChoseChainId}`);

    let landed = false;
    let revertReason = '';
    let txHash: string | null = null;
    try {
      const tx = await coreAsAttacker.broadcastCurrentParticipants(attackerChoseChainId, {
        gasLimit: GAS_LIMIT,
      });
      const receipt = await tx.wait();
      txHash = receipt!.hash;
      landed = true;
      LOGGER.log(`   module-direct call SUCCEEDED — tx ${txHash}`);
    } catch (e: any) {
      revertReason = e?.shortMessage || e?.message || String(e);
      LOGGER.log(`   module-direct call reverted: ${revertReason}`);
    }

    if (landed) {
      LOGGER.log('\n   ╔══════════════════════════════════════════════════════════╗');
      LOGGER.log('   ║   F14 EXPLOIT REPRODUCED — module-direct broadcast lands  ║');
      LOGGER.log('   ╚══════════════════════════════════════════════════════════╝');
      LOGGER.log(`   Attacker (no roles)    : ${attacker.address}`);
      LOGGER.log(`   Target module          : ${participantCoreAddress}`);
      LOGGER.log(`   Facade (correctly gated): ${privateHub.participantStorageAddress}`);
      LOGGER.log(`   Exploit tx             : ${txHash}`);
      LOGGER.log('   ───── ATTACK CHAIN ─────');
      LOGGER.log('   1. attacker.broadcastCurrentParticipants(fromChainId=424242) on the module directly.');
      LOGGER.log('      The facade\'s `restricted` modifier is bypassed because the attacker');
      LOGGER.log('      never touches the facade. The module has no `onlyParticipantStorage`.');
      LOGGER.log('   2. The module calls `_raylsSendToResourceId(fromChainId=424242, ...)`.');
      LOGGER.log('      Every participant peer receives an `addOrUpdateParticipants` message');
      LOGGER.log('      tagged with a forged origin chain.');
    }

    expect(
      landed,
      'F14: attacker landed broadcastCurrentParticipants via module-direct call (no onlyParticipantStorage)'
    ).to.equal(false);
  });
});
