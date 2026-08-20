/**
 * @title E2E SECURITY: F01 - Universal `restricted` bypass via unauthenticated schedule + execute
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 *
 * @description Targets the LIVE RaylsAccessManagerV1 + TeleportV1 deployed on the
 *              Private Network Hub (PNH). Demonstrates that an EOA holding NO roles
 *              and NO allowances can:
 *
 *                 1. Call manager.schedule(target, restrictedCalldata, 0)   — succeeds
 *                 2. Call manager.execute(target, restrictedCalldata)       — succeeds
 *                 3. Observe a state mutation on the target that should have been
 *                    reachable only by a RELAYER-roled caller.
 *
 *              The chosen victim is `TeleportV1.executeAtomicMessageBatch(string[],string)`
 *              because it is `restricted` (RELAYER-gated) and its effect is observable
 *              via `getAtomicMessageStatus(msgId)`: an unset message reads "Pending", and
 *              a successful (unauthorized) execute would flip it to "Executed". The
 *              security property under test is that the flip MUST NOT happen for an
 *              unprivileged caller.
 *
 * EXPECTED BEHAVIOUR
 *   - Pre-fix: assertion `status UNCHANGED` fails because the attacker successfully
 *     flipped the atomic message status via the schedule+execute bypass.
 *   - Post-fix: `manager.schedule(...)` reverts with
 *     `RaylsAccessManagerV1__Unauthorized(attacker)`. The catch-block records
 *     the revert, the status is unchanged, and the test PASSES.
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
  AccessManagerAuthLib__factory,
  AccessManagerEnumerationLib__factory,
  AccessManagerContractScopedLib__factory,
  AccessManagerScheduleLib__factory,
  AccessManagerRoleConfigLib__factory,
} from '../../../typechain-types';
import { createUserOperator } from '../../../src/utils/wallet-factory';
import { sendTx } from '../../../src/utils/common';

// Distinct victim message ids per test so re-runs against the same deployment do not
// couple. The exploit/baseline ids stay "Pending" (the attack must fail); the postfix
// id may become "Executed" by the legitimate flow — and execute is idempotent, so a
// re-run is harmless.
const VICTIM_EXPLOIT = 'f01-bypass-exploit-victim';
const VICTIM_BASELINE = 'f01-bypass-baseline-victim';
const VICTIM_POSTFIX = 'f01-bypass-postfix-victim';

// NOTE: the AccessManager schedule+execute bypass here is a LIVE property (teleport is only the
// victim); re-home one assertion onto a non-teleport target before deleting the F01 files.
describe('E2E SECURITY: F01 - AccessManager schedule+execute bypass (TeleportV1.executeAtomicMessageBatch) @decommissioned', function () {
  this.timeout(DEFAULT_TIMEOUT);

  let privateHub: PrivateHub;
  let attacker: ethers.HDNodeWallet;
  let manager: RaylsAccessManagerV1;
  let managerAsAttacker: RaylsAccessManagerV1;
  let teleport: TeleportV1;

  before(async function () {
    LOGGER.log('\n   ═══════════════════════════════════════════════════════════════');
    LOGGER.log('   F01: AccessManager schedule+execute bypass — E2E reproduction');
    LOGGER.log('   ═══════════════════════════════════════════════════════════════');

    const { initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privateHub = initializedPNH;

    // Wire up the LIVE access manager deployed on the PNH chain.
    const accessManagerContract = await privateHub.getAccessManager();
    const accessManagerAddress = await accessManagerContract.getAddress();

    // Fresh wallet with no roles, no allowances, no special configuration.
    // This is the minimum capability required for the bypass.
    attacker = createUserOperator(privateHub.provider);

    // Separate per-test wallet for contract deploys, off the contended admin
    // nonce. Mirrors SEC001_MessageExecutor_Reentrancy.ts:67.
    const deployer = createUserOperator(privateHub.provider);

    // Fund the attacker with enough native gas to send 2 transactions.
    await sendTx(
      () => privateHub.adminWallet.sendTransaction({
        to: attacker.address,
        value: ethers.parseEther('0.5'),
      }) as Promise<ethers.ContractTransactionResponse>,
      'F01: fund attacker on PNH',
    );

    LOGGER.log(`   PNH chainId         : ${(await privateHub.provider.getNetwork()).chainId}`);
    LOGGER.log(`   AccessManager       : ${accessManagerAddress}`);
    LOGGER.log(`   TeleportV1          : ${privateHub.teleportAddress}`);
    LOGGER.log(`   Admin (uninvolved)  : ${privateHub.adminWallet.address}`);
    LOGGER.log(`   Attacker (no roles) : ${attacker.address}`);

    // Manager instance bound to the attacker for the exploit calls.
    manager = RaylsAccessManagerV1__factory.connect(accessManagerAddress, privateHub.adminWallet);
    managerAsAttacker = RaylsAccessManagerV1__factory.connect(accessManagerAddress, attacker);

    teleport = TeleportV1__factory.connect(privateHub.teleportAddress, privateHub.adminWallet);

    // ─────────────────────────────────────────────────────────────────────
    //  F01 FIX VALIDATION — upgrade the live AccessManager to the patched
    //  implementation compiled from `contracts/remote/`. The patched
    //  schedule() reverts on unauthorized callers; without this upgrade
    //  the e2e network would still run the vulnerable bytecode.
    //
    //  Idempotent: if the live network is already running the patched
    //  bytecode, the upgrade is a no-op (proxy implementation slot is
    //  set to the already-deployed impl address — does NOT revert).
    // ─────────────────────────────────────────────────────────────────────
    LOGGER.log('   Deploying patched AccessManager libraries ...');
    // RaylsAccessManagerV1 links 5 external libraries via DELEGATECALL.
    // The libraries are stateless — fresh deployments are safe to use, and
    // we deploy NEW instances of all 5 (only ScheduleLib is materially
    // changed in F01, but linking the unchanged libs to fresh instances
    // is harmless because they hold no state).
    // AuthLib has no deps — deploy first.
    const authLib = await new AccessManagerAuthLib__factory(deployer).deploy();
    await authLib.waitForDeployment();
    const authLibAddr = await authLib.getAddress();
    // The other "no-deps" libs.
    const enumLib = await new AccessManagerEnumerationLib__factory(deployer).deploy();
    await enumLib.waitForDeployment();
    const scopedLib = await new AccessManagerContractScopedLib__factory(deployer).deploy();
    await scopedLib.waitForDeployment();
    const roleConfigLib = await new AccessManagerRoleConfigLib__factory(deployer).deploy();
    await roleConfigLib.waitForDeployment();
    // ScheduleLib links to AuthLib — must be deployed AFTER authLib.
    const scheduleLib = await new AccessManagerScheduleLib__factory(
      {
        'contracts/remote/privateHub/AccessControl/libraries/AccessManagerAuthLib.sol:AccessManagerAuthLib':
          authLibAddr,
      },
      deployer,
    ).deploy();
    await scheduleLib.waitForDeployment();
    LOGGER.log(`   AuthLib             : ${await authLib.getAddress()}`);
    LOGGER.log(`   EnumerationLib      : ${await enumLib.getAddress()}`);
    LOGGER.log(`   ContractScopedLib   : ${await scopedLib.getAddress()}`);
    LOGGER.log(`   ScheduleLib (fixed) : ${await scheduleLib.getAddress()}`);
    LOGGER.log(`   RoleConfigLib       : ${await roleConfigLib.getAddress()}`);

    LOGGER.log('   Deploying patched RaylsAccessManagerV1 implementation ...');
    const newImpl = await new RaylsAccessManagerV1__factory(
      {
        'contracts/remote/privateHub/AccessControl/libraries/AccessManagerAuthLib.sol:AccessManagerAuthLib':
          await authLib.getAddress(),
        'contracts/remote/privateHub/AccessControl/libraries/AccessManagerEnumerationLib.sol:AccessManagerEnumerationLib':
          await enumLib.getAddress(),
        'contracts/remote/privateHub/AccessControl/libraries/AccessManagerContractScopedLib.sol:AccessManagerContractScopedLib':
          await scopedLib.getAddress(),
        'contracts/remote/privateHub/AccessControl/libraries/AccessManagerScheduleLib.sol:AccessManagerScheduleLib':
          await scheduleLib.getAddress(),
        'contracts/remote/privateHub/AccessControl/libraries/AccessManagerRoleConfigLib.sol:AccessManagerRoleConfigLib':
          await roleConfigLib.getAddress(),
      },
      deployer,
    ).deploy();
    await newImpl.waitForDeployment();
    const newImplAddress = await newImpl.getAddress();
    LOGGER.log(`   New impl address    : ${newImplAddress}`);

    // Upgrade the live proxy to the new impl. ADMIN-only (UUPS).
    const upgradeReceipt = await sendTx(
      () => manager.upgradeToAndCall(newImplAddress, '0x', { gasLimit: GAS_LIMIT }),
      'F01: upgrade AccessManager impl',
    );
    LOGGER.log(`   Upgrade tx          : ${upgradeReceipt.hash}`);
    LOGGER.log('   Live AccessManager is now running the F01-fixed bytecode.');
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  BASELINE  -  must always pass
  // ════════════════════════════════════════════════════════════════════════════

  it('F01-E2E-baseline: direct attacker call to TeleportV1.executeAtomicMessageBatch reverts AND canCall returns allowed=false (proves the role gate works on the normal path)', async function () {
    // Diagnostic 1: query canCall directly on the live manager. This is the
    // ground-truth oracle for "would the restricted modifier reject this caller
    // on this selector?". allowed=false means the gate is intact on the normal path.
    const execSelector = TeleportV1__factory.createInterface()
      .getFunction('executeAtomicMessageBatch')!.selector;
    const [allowed, delay, paused] = await manager.canCall(
      attacker.address,
      privateHub.teleportAddress,
      execSelector
    );
    LOGGER.log(`   canCall(attacker, teleport, executeAtomicMessageBatch.sig) = (allowed=${allowed}, delay=${delay}, paused=${paused})`);

    expect(allowed, 'attacker should NOT be allowed to call executeAtomicMessageBatch via the normal canCall path').to.equal(false);

    // Diagnostic 2: actually send the tx. We use try/catch instead of the chai
    // matcher because hardhat-chai-matchers' eth_call simulation has produced
    // misleading "didn't revert" results on this specific environment.
    const teleportAsAttacker = TeleportV1__factory.connect(privateHub.teleportAddress, attacker);
    let reverted = false;
    let revertReason = '';
    try {
      const tx = await teleportAsAttacker.executeAtomicMessageBatch([VICTIM_BASELINE], '', { gasLimit: GAS_LIMIT });
      await tx.wait();
    } catch (e: any) {
      reverted = true;
      revertReason = e?.shortMessage || e?.message || String(e);
    }
    LOGGER.log(`   direct executeAtomicMessageBatch tx reverted? ${reverted} ${revertReason ? '(' + revertReason + ')' : ''}`);
    expect(reverted, 'direct executeAtomicMessageBatch call by attacker MUST revert (role gate must hold on the normal path)').to.equal(true);
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  EXPLOIT REPRODUCTION  -  FAILS pre-fix, PASSES post-fix
  // ════════════════════════════════════════════════════════════════════════════

  it('F01-E2E-exploit: attacker bypasses TeleportV1.executeAtomicMessageBatch via manager.schedule + manager.execute (atomic status MUST remain unchanged)', async function () {
    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 1: Snapshot original state');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    const statusBefore: string = await teleport.getAtomicMessageStatus(VICTIM_EXPLOIT);
    LOGGER.log(`   atomic status before attack : ${statusBefore}`);

    // Build the calldata the attacker wants to land: executeAtomicMessageBatch([VICTIM], "").
    // An unset message reads "Pending"; a successful execute flips it to "Executed",
    // a clearly observable state change.
    const teleportIface = TeleportV1__factory.createInterface();
    const calldata: string = teleportIface.encodeFunctionData('executeAtomicMessageBatch', [[VICTIM_EXPLOIT], '']);

    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 2: Attacker calls manager.schedule(...)');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    LOGGER.log(`   target   : ${privateHub.teleportAddress}`);
    LOGGER.log(`   calldata : ${calldata}`);
    LOGGER.log(`   when     : 0  (executeAfter = block.timestamp)`);

    let scheduleTxHash: string | null = null;
    let scheduleReverted: boolean = false;
    let scheduleRevertReason: string = '';
    try {
      const tx = await managerAsAttacker.schedule(
        privateHub.teleportAddress,
        calldata,
        0,
        { gasLimit: GAS_LIMIT }
      );
      const receipt = await tx.wait();
      scheduleTxHash = receipt!.hash;
      LOGGER.log(`   schedule() SUCCEEDED — tx ${scheduleTxHash}`);
    } catch (e: any) {
      scheduleReverted = true;
      scheduleRevertReason = e?.shortMessage || e?.message || String(e);
      LOGGER.log(`   schedule() reverted   : ${scheduleRevertReason}`);
    }

    // Snapshot between schedule and execute. schedule() should NOT mutate the
    // target's state — it only records an entry in the AccessManager's
    // _schedules mapping.
    const statusAfterSchedule: string = await teleport.getAtomicMessageStatus(VICTIM_EXPLOIT);
    LOGGER.log(`   atomic status AFTER schedule (target untouched expected): ${statusAfterSchedule}`);

    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 3: Attacker calls manager.execute(...) (only if schedule succeeded)');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    let executeTxHash: string | null = null;
    let executeReverted: boolean = false;
    let executeRevertReason: string = '';
    if (!scheduleReverted) {
      try {
        const tx = await managerAsAttacker.execute(
          privateHub.teleportAddress,
          calldata,
          { gasLimit: GAS_LIMIT }
        );
        const receipt = await tx.wait();
        executeTxHash = receipt!.hash;
        LOGGER.log(`   execute() SUCCEEDED — tx ${executeTxHash}`);
      } catch (e: any) {
        executeReverted = true;
        executeRevertReason = e?.shortMessage || e?.message || String(e);
        LOGGER.log(`   execute() reverted    : ${executeRevertReason}`);
      }
    } else {
      LOGGER.log('   execute() skipped (schedule reverted)');
    }

    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 4: Observe state mutation');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    const statusAfter: string = await teleport.getAtomicMessageStatus(VICTIM_EXPLOIT);
    LOGGER.log(`   atomic status after attack  : ${statusAfter}`);

    if (statusAfter !== statusBefore) {
      LOGGER.log('\n   ╔══════════════════════════════════════════════════════════╗');
      LOGGER.log('   ║   F01 EXPLOIT REPRODUCED — UNIVERSAL `restricted` BYPASS  ║');
      LOGGER.log('   ╚══════════════════════════════════════════════════════════╝');
      LOGGER.log(`   Attacker (no roles)        : ${attacker.address}`);
      LOGGER.log(`   Victim contract            : ${privateHub.teleportAddress} (TeleportV1)`);
      LOGGER.log(`   Function abused            : executeAtomicMessageBatch(string[],string)  [restricted]`);
      LOGGER.log(`   Manager (delegating auth)  : ${await manager.getAddress()}`);
      LOGGER.log(`   schedule tx                : ${scheduleTxHash}`);
      LOGGER.log(`   execute  tx                : ${executeTxHash}`);
      LOGGER.log(`   atomic status: ${statusBefore} -> ${statusAfter}`);
      LOGGER.log('   ───── ATTACK CHAIN ─────');
      LOGGER.log(`   1. attacker.schedule(teleport, executeAtomicMessageBatch([${VICTIM_EXPLOIT}]), 0)`);
      LOGGER.log('      AccessManagerScheduleLib.schedule destructures only callerDelay');
      LOGGER.log('      from canCall and never reverts on `!allowed`. Schedule is recorded.');
      LOGGER.log(`   2. attacker.execute(teleport, executeAtomicMessageBatch([${VICTIM_EXPLOIT}]))`);
      LOGGER.log('      RaylsAccessManagerV1.execute does NOT re-check authorization.');
      LOGGER.log('      It increments `_executingScheduledOpDepth` and calls teleport.');
      LOGGER.log('   3. teleport.executeAtomicMessageBatch sees msg.sender == manager.');
      LOGGER.log('      Its `restricted` modifier asks manager.canCall(manager, teleport, sig).');
      LOGGER.log('      AccessManagerAuthLib.canCall L34 short-circuits because');
      LOGGER.log('      `caller == address(this) && _executingScheduledOpDepth > 0` and');
      LOGGER.log('      returns (true, 0, false). The restricted modifier passes.');
      LOGGER.log('   4. executeAtomicMessageBatch body runs. State mutated by an unprivileged EOA.');
      LOGGER.log('   ───── BLAST RADIUS ─────');
      LOGGER.log('   The same chain works on EVERY restricted function on EVERY');
      LOGGER.log('   RaylsAccessManaged consumer (TokenRegistry, ParticipantStorage,');
      LOGGER.log('   EndpointV1, RNEndpoint, AuditManager, EnygmaManager, all token');
      LOGGER.log('   handlers, AND the UUPS _authorizeUpgrade hook on every proxy).');
      LOGGER.log('   This is a complete loss of access control on the entire protocol.');
    }

    expect(statusAfter, 'F01 EXPLOIT: TeleportV1 atomic status was modified by an unauthorized caller via manager.schedule + manager.execute')
      .to.equal(statusBefore);
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  POSTFIX SAFETY  -  must always pass
  // ════════════════════════════════════════════════════════════════════════════

  it('F01-E2E-postfix: ADMIN can still schedule+execute executeAtomicMessageBatch after the fix (legitimate flow preserved)', async function () {
    const teleportIface = TeleportV1__factory.createInterface();
    const calldata = teleportIface.encodeFunctionData('executeAtomicMessageBatch', [[VICTIM_POSTFIX], '']);

    const managerAsAdmin = RaylsAccessManagerV1__factory.connect(
      await manager.getAddress(),
      privateHub.adminWallet
    );

    // The legitimate ADMIN flow must still work after the fix.
    const scheduleTx = await managerAsAdmin.schedule(
      privateHub.teleportAddress,
      calldata,
      0,
      { gasLimit: GAS_LIMIT }
    );
    await scheduleTx.wait();

    const executeTx = await managerAsAdmin.execute(
      privateHub.teleportAddress,
      calldata,
      { gasLimit: GAS_LIMIT }
    );
    await executeTx.wait();

    // No assertion on a specific value; we only care that the authorized
    // schedule+execute path did not revert post-fix.
  });
});
