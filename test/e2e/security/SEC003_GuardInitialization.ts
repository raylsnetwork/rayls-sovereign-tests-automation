/**
 * @title E2E SECURITY: SEC-003 — Reentrancy Guard Initialization Bug
 * @description Deploys a fresh contract replicating RaylsReentrancyGuardV1's initialize()
 *              on a live Privacy Ledger and verifies the guard states after initialization.
 *
 * VULNERABILITY:
 *   RaylsReentrancyGuardV1.initialize() has the state-setting lines commented out:
 *     //   _send_entered_state = 1;
 *     //  _receive_entered_state = 1;
 *   Both variables default to 0. The guard modifiers check require(state == 1), so
 *   every guarded function reverts on first call after a fresh deployment.
 *
 * RAYLS IMPACT:
 *   When a new financial institution joins the Rayls network and deploys fresh Privacy
 *   Ledger contracts, the reentrancy guard bricks ALL guarded functions from day one.
 *   No cross-chain messages can be received, no Enygma transfers, no DVP settlements,
 *   no Atomic Teleports. The institution appears online but is completely non-functional.
 *   The error message "Rayls: no send/receive reentrancy" is misleading — it suggests
 *   an attack is being blocked when the guard itself is misconfigured.
 *
 * EXPECTED BEHAVIOR:
 *   - Test FAILS when initialize() doesn't set states (vulnerability present)
 *   - Test PASSES when initialize() correctly sets states to _NOT_ENTERED (1)
 */

import { expect } from 'chai';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../src/config/env-config';
import { initializePrivacyNodes, PrivacyNodeMap } from '../../setup';
import { SEC003_GuardInitChecker, SEC003_GuardInitChecker__factory } from '../../../typechain-types';

describe('E2E SECURITY: SEC-003 — Reentrancy Guard Initialization Bug @hubless', function () {
  this.timeout(DEFAULT_TIMEOUT);

  let privacyNodes: PrivacyNodeMap;

  before(async function () {
    privacyNodes = await initializePrivacyNodes(2);
  });

  it('SEC-003-E2E-001: Guard states must be _NOT_ENTERED (1) after initialize()', async function () {
    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   SEC-003: REENTRANCY GUARD INITIALIZATION CHECK');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    // --- PHASE 1: Deploy fresh guard checker (replicates RaylsReentrancyGuardV1) ---
    LOGGER.log('\n   PHASE 1: DEPLOY FRESH CONTRACT');
    LOGGER.log('   Deploying SEC003_GuardInitChecker on PN-A...');
    LOGGER.log('   This contract replicates RaylsReentrancyGuardV1 exactly as deployed.');

    const factory = new SEC003_GuardInitChecker__factory(privacyNodes.A.userWallet);
    const checker: SEC003_GuardInitChecker = await factory.deploy();
    await checker.waitForDeployment();
    const checkerAddress = await checker.getAddress();
    LOGGER.log(`   Deployed at: ${checkerAddress}`);

    // --- PHASE 2: Call initialize() ---
    LOGGER.log('\n   PHASE 2: CALL initialize()');
    const initTx = await checker.initialize({ gasLimit: GAS_LIMIT });
    await initTx.wait();
    LOGGER.log('   initialize() executed successfully.');

    // --- PHASE 3: Read guard states ---
    LOGGER.log('\n   PHASE 3: READ GUARD STATES');
    const [sendState, receiveState] = await checker.getGuardStates();
    LOGGER.log(`   _send_entered_state:    ${sendState} (expected: 1 = _NOT_ENTERED)`);
    LOGGER.log(`   _receive_entered_state: ${receiveState} (expected: 1 = _NOT_ENTERED)`);

    const sendStateCorrect = Number(sendState) === 1;
    const receiveStateCorrect = Number(receiveState) === 1;

    // --- PHASE 4: Try calling guarded functions ---
    LOGGER.log('\n   PHASE 4: TEST GUARDED FUNCTIONS');

    let sendGuardWorks = false;
    let receiveGuardWorks = false;
    let sendError = '';
    let receiveError = '';

    try {
      const sendTx = await checker.guardedSend({ gasLimit: GAS_LIMIT });
      await sendTx.wait();
      sendGuardWorks = true;
      LOGGER.log('   guardedSend():    ✅ succeeded');
    } catch (error: any) {
      sendError = error.message || String(error);
      LOGGER.log(`   guardedSend():    ❌ REVERTED`);
      if (sendError.includes('no send reentrancy')) {
        LOGGER.log('   Reason: "Rayls: no send reentrancy" — guard state is 0, not 1');
      }
    }

    try {
      const receiveTx = await checker.guardedReceive({ gasLimit: GAS_LIMIT });
      await receiveTx.wait();
      receiveGuardWorks = true;
      LOGGER.log('   guardedReceive(): ✅ succeeded');
    } catch (error: any) {
      receiveError = error.message || String(error);
      LOGGER.log(`   guardedReceive(): ❌ REVERTED`);
      if (receiveError.includes('no receive reentrancy')) {
        LOGGER.log('   Reason: "Rayls: no receive reentrancy" — guard state is 0, not 1');
      }
    }

    // --- PHASE 5: Report ---
    if (!sendGuardWorks || !receiveGuardWorks) {
      LOGGER.log('\n═══════════════════════════════════════════════════════════════');
      LOGGER.log('   ⚠️  VULNERABILITY DETECTED: SEC-003');
      LOGGER.log('═══════════════════════════════════════════════════════════════');
      LOGGER.log(`   Guard states after initialize():  send=${sendState}, receive=${receiveState}`);
      LOGGER.log('   Expected: both should be 1 (_NOT_ENTERED)');
      LOGGER.log('   Actual: both are 0 (Solidity default — commented-out assignments)');
      LOGGER.log('');
      LOGGER.log('   IMPACT ON FINANCIAL INSTITUTIONS:');
      LOGGER.log('   Any new institution joining the Rayls network that deploys fresh');
      LOGGER.log('   Privacy Ledger contracts will have ALL guarded functions bricked.');
      LOGGER.log('   This means:');
      LOGGER.log('     - No cross-chain messages can be received (executeMessage reverts)');
      LOGGER.log('     - No Enygma private transfers');
      LOGGER.log('     - No DVP atomic settlements');
      LOGGER.log('     - No Atomic Teleports');
      LOGGER.log('   The institution appears live on the network but is completely');
      LOGGER.log('   non-functional. The misleading error "Rayls: no reentrancy"');
      LOGGER.log('   suggests an attack is being blocked, masking the real cause.');
      LOGGER.log('');
      LOGGER.log('   Existing institutions are NOT affected (their storage already');
      LOGGER.log('   holds correct values from prior initialization).');
      LOGGER.log('═══════════════════════════════════════════════════════════════');
    }

    expect(sendGuardWorks).to.equal(
      true,
      `VULNERABILITY SEC-003: guardedSend() reverted after initialize(). ` +
      `_send_entered_state is ${sendState} (should be 1). ` +
      `New institutions joining Rayls will have all cross-chain messaging bricked on day one.`
    );

    expect(receiveGuardWorks).to.equal(
      true,
      `VULNERABILITY SEC-003: guardedReceive() reverted after initialize(). ` +
      `_receive_entered_state is ${receiveState} (should be 1). ` +
      `New institutions joining Rayls will have all cross-chain messaging bricked on day one.`
    );
  });
});
