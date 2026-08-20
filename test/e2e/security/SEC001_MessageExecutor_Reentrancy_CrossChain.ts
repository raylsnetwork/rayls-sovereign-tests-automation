/**
 * @title E2E SECURITY: SEC-001 — Cross-Chain Variant (CC Executor / Path A)
 * @description Tests the same reentrancy vulnerability as the direct variant, but
 *              targets the PRIVATE HUB's executor (RaylsMessageExecutorV1) instead
 *              of a Privacy Ledger's executor (RNMessageExecutorV1).
 *
 *              The PNH has its own execution pipeline:
 *                EndpointV1.receivePayload() (onlyRelayerAuthorized)
 *                  → MessageReceiver.receivePayload() (onlyEndpoint)
 *                  → RaylsMessageExecutorV1.executeMessage() (onlyMessageReceiver)
 *                  → MessageLib.executeMessage() → to.call(abi.encodePacked(data, ...))
 *
 *              The PNH uses RaylsMessage (not PrivacyNodeMessage) and a protocol-level
 *              RaylsAccessManagerV1. The executor delegates to MessageLib which
 *              appends (messageId, fromChainId, from) via abi.encodePacked to calldata.
 *
 * CROSS-CHAIN PATH ARCHITECTURE (see THREAT_MODEL Section 13.1):
 *   Path A — Protocol Endpoint → CC: token registration, RaylsApp comms
 *   Path B — RN Endpoint → pub relayer (ERC20 teleports, PL bridging)
 *   Path C — Enygma events → Relayer (initiator) → CC (ZK proof) → Relayer (receiver) → crossMint()
 *
 *   This test targets the PNH's executor on Path A. The direct variant
 *   (SEC001_MessageExecutor_Reentrancy.ts) targets PL-B's executor on Path B.
 *
 * WHY BOTH TESTS ARE NEEDED:
 *   - The PNH uses a DIFFERENT executor contract (RaylsMessageExecutorV1 + MessageLib)
 *     than PNs (RNMessageExecutorV1)
 *   - Both inherit separate reentrancy guard implementations
 *     (RaylsReentrancyGuardV1 vs RNReentrancyGuardV1)
 *   - The PNH executor must independently have receiveNonReentrant applied
 *
 * SHORTCUT:
 *   We call EndpointV1.receivePayload() directly on the CC, simulating what
 *   a pub relayer does when delivering a message from a PL. This is equivalent
 *   because the relay adds no security — it's a delivery service.
 *
 * EXPECTED BEHAVIOR:
 *   - Test FAILS when reentrancy succeeds (both settlements execute — vulnerability present)
 *   - Test PASSES when the re-entrant call reverts (receiveNonReentrant blocks it)
 */

import { ethers } from 'ethers';
import { expect } from 'chai';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import {
  EndpointV1__factory,
  RaylsAccessManagerV1__factory,
  SEC001_PNHReentrantSettlement__factory,
} from '../../../typechain-types';
import { createUserOperator } from '../../../src/utils/wallet-factory';

// CHF amounts
const LEGITIMATE_CHF = ethers.parseUnits('5000', 18);   // 5,000 CHF
const FRAUDULENT_CHF = ethers.parseUnits('50000', 18);  // 50,000 CHF
const PL_A_CHAIN_ID = 10001n; // simulated source PL

describe('E2E SECURITY: SEC-001 — CC Message Executor Reentrancy (Double CHF Settlement)', function () {
  this.timeout(DEFAULT_TIMEOUT);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  before(async function () {
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;
  });

  it('SEC-001-E2E-002: Re-entrant executeMessage on PNH executor must be blocked', async function () {
    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   SEC-001 CC: DOUBLE CHF SETTLEMENT INJECTION');
    LOGGER.log('   Targeting the LIVE EndpointV1 + RaylsMessageExecutorV1 on PNH');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    // adminWallet is the owner of RelayAuthorizationRegistry on PNH
    const ccSigner = privateHub.adminWallet;
    // Fresh wallet for contract deployment to avoid nonce contention in parallel runs
    const deployer = createUserOperator(privateHub.provider);

    // --- PHASE 1: Locate LIVE infrastructure on PNH ---
    LOGGER.log('\n   PHASE 1: LOCATE LIVE INFRASTRUCTURE ON PRIVATE HUB');

    const ccEndpointAddr = privateHub.endpointAddress;
    const ccEndpoint = EndpointV1__factory.connect(ccEndpointAddr, ccSigner);

    // Get the access manager from the PNH endpoint
    const managerAddr = await ccEndpoint.authority();
    const manager = RaylsAccessManagerV1__factory.connect(managerAddr, ccSigner);

    // Get the message executor from the PNH endpoint (via messageReceiver → executor)
    // The PNH endpoint delegates to MessageReceiver which delegates to RaylsMessageExecutorV1
    // We need the executor address for verification
    const messageReceiverAddr = await ccEndpoint.messageReceiver();

    LOGGER.log(`   LIVE CC EndpointV1:            ${ccEndpointAddr}`);
    LOGGER.log(`   LIVE CC RaylsAccessManagerV1:   ${managerAddr}`);
    LOGGER.log(`   LIVE CC MessageReceiver:        ${messageReceiverAddr}`);

    // Get the RELAYER role id for granting
    const relayerRoleId = await manager.getRoleIdByName('RELAYER');
    LOGGER.log(`   CC signer:                      ${ccSigner.address}`);

    // --- PHASE 2: Deploy attack contract on PNH and register as relayer ---
    LOGGER.log('\n   PHASE 2: DEPLOY ATTACK INFRASTRUCTURE ON CC');

    const nonce = Date.now().toString() + Math.random().toString();
    const legitimateMessageId = ethers.keccak256(ethers.toUtf8Bytes(`sec001-cc-legit-chf-${nonce}`));
    const fraudulentMessageId = ethers.keccak256(ethers.toUtf8Bytes(`sec001-cc-fraud-chf-${nonce}`));

    const target = await new SEC001_PNHReentrantSettlement__factory(deployer).deploy(
      ccEndpointAddr,
      fraudulentMessageId,
      FRAUDULENT_CHF
    );
    await target.waitForDeployment();
    const targetAddr = await target.getAddress();
    LOGGER.log(`   Reentrant target deployed:      ${targetAddr}`);

    // Grant the target RELAYER so it can call receivePayload()
    await (await manager.grantRole(relayerRoleId, targetAddr, 0)).wait();
    const [targetIsRelayer] = await manager.hasRole(relayerRoleId, targetAddr);
    LOGGER.log(`   Target granted RELAYER:         ${targetIsRelayer}`);

    // --- PHASE 3: DELIVER MESSAGE THROUGH CC's LIVE ENDPOINT ---
    LOGGER.log('\n   PHASE 3: EXECUTE DOUBLE SETTLEMENT ATTACK ON CC');
    LOGGER.log(`   Legitimate: 5,000 CHF (messageId: ${legitimateMessageId.slice(0, 18)}...)`);
    LOGGER.log(`   Fraudulent: 50,000 CHF (messageId: ${fraudulentMessageId.slice(0, 18)}...)`);

    // Build the legitimate settlement payload
    const settlePayload = SEC001_PNHReentrantSettlement__factory.createInterface().encodeFunctionData(
      'settle',
      [LEGITIMATE_CHF]
    );

    // Build the RaylsMessage struct (CC uses RaylsMessage, not PrivacyNodeMessage)
    const raylsMessage = {
      messageMetadata: {
        valid: true,
        nonce: 0,
        newResourceMetadata: {
          valid: false,
          resourceDeployType: 0, // BYTECODE
          bytecode: '0x',
          factoryTemplate: 0,   // CUSTOM
          initializerParams: '0x',
        },
        resourceId: ethers.ZeroHash,
        lockData: '0x',
        revertPayloadDataSender: '0x',
        revertPayloadDataReceiver: '0x',
        transferMetadata: {
          assetType: 0,         // CUSTOM
          id: 0,
          from: ethers.ZeroAddress,
          to: ethers.ZeroAddress,
          tokenAddress: ethers.ZeroAddress,
          amount: 0,
        },
        ignoresNonce: true,     // bypass nonce validation for this test
      },
      payload: settlePayload,
    };

    // -----------------------------------------------------------------------
    // SHORTCUT: We call receivePayload() directly on the PNH's EndpointV1.
    //
    // In production, messages arrive at the PNH via pub relayers delivering
    // from PNs. The relayer just calls EndpointV1.receivePayload() — no
    // additional validation. This shortcut is equivalent.
    //
    // The CC's execution pipeline:
    //   EndpointV1.receivePayload() → MessageReceiver.receivePayload()
    //   → RaylsMessageExecutorV1.executeMessage()
    //   → MessageLib.executeMessage() → to.call(abi.encodePacked(data, ...))
    // -----------------------------------------------------------------------
    const attackTx = await ccEndpoint.receivePayload(
      PL_A_CHAIN_ID,
      ccSigner.address,    // srcAddress (simulated PL-A sender)
      targetAddr,           // dstAddress (our reentrant target on PNH)
      raylsMessage,
      legitimateMessageId,
      { gasLimit: GAS_LIMIT }
    );
    await attackTx.wait();

    // --- PHASE 4: MEASURE IMPACT ---
    LOGGER.log('\n   PHASE 4: MEASURE IMPACT');

    const settledTotal = await target.settledTotal();
    const settlementCount = await target.settlementCount();
    const reentrySucceeded = await target.reentrySucceeded();

    LOGGER.log(`   Settlements received:         ${settlementCount}`);
    LOGGER.log(`   Total CHF settled:            ${ethers.formatUnits(settledTotal, 18)} CHF`);
    LOGGER.log(`   Re-entry succeeded:           ${reentrySucceeded}`);

    // --- PHASE 5: IMPACT REPORT ---
    if (reentrySucceeded) {
      LOGGER.log('\n═══════════════════════════════════════════════════════════════');
      LOGGER.log('   ⚠️  VULNERABILITY CONFIRMED: SEC-001 (CC EXECUTOR)');
      LOGGER.log('═══════════════════════════════════════════════════════════════');
      LOGGER.log(`   DOUBLE SETTLEMENT on the PNH's LIVE executor.`);
      LOGGER.log('');
      LOGGER.log(`   Legitimate: 5,000 CHF  (${legitimateMessageId.slice(0, 18)}...)`);
      LOGGER.log(`   Fraudulent: 50,000 CHF (${fraudulentMessageId.slice(0, 18)}...)`);
      LOGGER.log(`   TOTAL:      ${ethers.formatUnits(settledTotal, 18)} CHF`);
      LOGGER.log('');
      LOGGER.log('   The attack went through the CC\'s LIVE infrastructure:');
      LOGGER.log(`     EndpointV1                (${ccEndpointAddr.slice(0, 18)}...)`);
      LOGGER.log(`     RaylsMessageExecutorV1    (via MessageLib.executeMessage())`);
      LOGGER.log('');
      LOGGER.log('   The target re-entered via CC EndpointV1.receivePayload() with a');
      LOGGER.log('   different messageId. Both settlements executed atomically.');
      LOGGER.log('═══════════════════════════════════════════════════════════════');
    }

    // Clean up: revoke the target's RELAYER role
    try {
      await (await manager.revokeRole(relayerRoleId, targetAddr)).wait();
      LOGGER.log('\n   Cleaned up: revoked RELAYER from target on PNH');
    } catch { /* best effort */ }

    // ASSERTION: reentrancy must be BLOCKED
    expect(reentrySucceeded).to.equal(
      false,
      `VULNERABILITY SEC-001 (CC EXECUTOR) CONFIRMED: Re-entrant executeMessage() succeeded on ` +
      `the PNH's RaylsMessageExecutorV1 (via MessageLib). Target re-entered through the PNH's ` +
      `EndpointV1 (${ccEndpointAddr}) and injected 50,000 CHF alongside a legitimate 5,000 CHF ` +
      `settlement (total: ${ethers.formatUnits(settledTotal, 18)} CHF). ` +
      `The receiveNonReentrant modifier must be applied to the PNH executor's executeMessage().`
    );
  });
});
