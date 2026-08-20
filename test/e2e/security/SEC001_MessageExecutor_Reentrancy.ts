/**
 * @title E2E SECURITY: SEC-001 — Reentrancy in RNMessageExecutorV1.executeMessage()
 * @description Uses the ALREADY-DEPLOYED RNEndpointV1, RNMessageExecutorV1, and
 *              RaylsAccessManagerV1 on Bank B's Privacy Ledger.
 *
 *              Deploys a reentrant settlement target on PN-B and registers it as an
 *              authorized relayer. Delivers a legitimate 5,000 CHF settlement through
 *              the LIVE endpoint. During execution, the target re-enters the LIVE
 *              endpoint's receivePayload() with a fraudulent 50,000 CHF settlement
 *              using a DIFFERENT messageId. The LIVE executor processes both.
 *
 * VULNERABILITY:
 *   RNMessageExecutorV1.executeMessage() forwards calldata to external contracts via
 *   .call() without a receiveNonReentrant guard. A compromised target that is also an
 *   authorized relayer can re-enter via endpoint.receivePayload() with a different
 *   messageId, bypassing replay protection. Both settlements execute atomically.
 *
 * RAYLS IMPACT:
 *   Bank A sends a legitimate 5,000 CHF payment to Bank B.
 *   A compromised contract on Bank B's PL re-enters through the live endpoint with
 *   a crafted 50,000 CHF settlement. Result: 55,000 CHF settled in one transaction.
 *
 * EXPECTED BEHAVIOR:
 *   - Test FAILS when reentrancy succeeds (both settlements execute — vulnerability present)
 *   - Test PASSES when the re-entrant call reverts (receiveNonReentrant blocks it)
 */

import { formatUnits, keccak256, parseUnits, toUtf8Bytes, ZeroAddress } from 'ethers';
import { expect } from 'chai';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../src/config/env-config';
import { initializePrivacyNodes, PrivacyNodeMap } from '../../setup';
import {
  RNEndpointV1__factory,
  RNMessageExecutorV1__factory,
  RaylsAccessManagerV1__factory,
  SEC001_ReentrantSettlement__factory,
} from '../../../typechain-types';
import { createUserOperator } from '../../../src/utils/wallet-factory';

// CHF amounts
const LEGITIMATE_CHF = parseUnits('5000', 18);   // 5,000 CHF
const FRAUDULENT_CHF = parseUnits('50000', 18);  // 50,000 CHF
const BANK_A_CHAIN_ID = 10001n; // Crédit Suisse PL

describe('E2E SECURITY: SEC-001 — Message Executor Reentrancy (Double CHF Settlement) @hubless', function () {
  this.timeout(DEFAULT_TIMEOUT);

  let privacyNodes: PrivacyNodeMap;

  before(async function () {
    privacyNodes = await initializePrivacyNodes(2);
  });

  it('SEC-001-E2E-001: Re-entrant executeMessage must be blocked (double settlement injection)', async function () {
    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   SEC-001: DOUBLE CHF SETTLEMENT INJECTION');
    LOGGER.log('   Targeting the LIVE RNEndpointV1 + Executor on Bank B\'s PL');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    // adminWallet is the owner of RelayAuthorizationRegistry (can register relayers)
    const signer = privacyNodes.B.adminWallet;
    // Fresh wallet for contract deployment to avoid nonce contention in parallel runs
    const deployer = createUserOperator(privacyNodes.B.provider);

    // --- PHASE 1: Locate LIVE infrastructure on PN-B ---
    LOGGER.log('\n   PHASE 1: LOCATE LIVE INFRASTRUCTURE ON PL-B');

    const rnEndpointAddr = await privacyNodes.B.resolveFromRegistry('RNEndpoint');
    const rnEndpoint = RNEndpointV1__factory.connect(rnEndpointAddr, signer);

    const executorAddr = await rnEndpoint.messageExecutor();
    const executor = RNMessageExecutorV1__factory.connect(executorAddr, signer);

    const managerAddr = await rnEndpoint.authority();
    const manager = RaylsAccessManagerV1__factory.connect(managerAddr, signer);

    LOGGER.log(`   LIVE RNEndpointV1:             ${rnEndpointAddr}`);
    LOGGER.log(`   LIVE RNMessageExecutorV1:       ${executorAddr}`);
    LOGGER.log(`   LIVE RaylsAccessManagerV1:      ${managerAddr}`);

    // Verify the signer is an admin (can grant roles)
    const relayerRoleId = await manager.getRoleIdByName('RELAYER');
    const [isRelayer] = await manager.hasRole(relayerRoleId, signer.address);
    LOGGER.log(`   Test signer:                    ${signer.address}`);
    LOGGER.log(`   Signer has RELAYER:             ${isRelayer}`);

    // --- PHASE 2: Deploy attack contract and register as relayer ---
    LOGGER.log('\n   PHASE 2: DEPLOY ATTACK INFRASTRUCTURE');

    const nonce = Date.now().toString() + Math.random().toString();
    const legitimateMessageId = keccak256(toUtf8Bytes(`sec001-legit-chf-${nonce}`));
    const fraudulentMessageId = keccak256(toUtf8Bytes(`sec001-fraud-chf-${nonce}`));

    const target = await new SEC001_ReentrantSettlement__factory(deployer).deploy(
      rnEndpointAddr,
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

    // --- PHASE 3: DELIVER MESSAGE THROUGH LIVE ENDPOINT ---
    LOGGER.log('\n   PHASE 3: EXECUTE DOUBLE SETTLEMENT ATTACK');
    LOGGER.log(`   Legitimate: 5,000 CHF (messageId: ${legitimateMessageId.slice(0, 18)}...)`);
    LOGGER.log(`   Fraudulent: 50,000 CHF (messageId: ${fraudulentMessageId.slice(0, 18)}...)`);

    // Build the legitimate settlement payload
    const settlePayload = SEC001_ReentrantSettlement__factory.createInterface().encodeFunctionData(
      'settle',
      [LEGITIMATE_CHF]
    );

    // Build the PrivacyNodeMessage struct
    const raylsMessage = {
      messageMetadata: {
        nonce: 0,
        newResourceMetadata: {
          resourceDeployType: 0, // BYTECODE
          bytecode: '0x',
          factoryTemplate: 0,   // CUSTOM
          initializerParams: '0x',
        },
        revertPayloadData: '0x',
        transferMetadata: {
          assetType: 0,         // CUSTOM
          id: 0,
          from: ZeroAddress,
          to: ZeroAddress,
          tokenAddress: ZeroAddress,
          amount: 0,
        },
      },
      payload: settlePayload,
    };

    // -----------------------------------------------------------------------
    // SHORTCUT: We call receivePayload() directly on PN-B's endpoint.
    //
    // In production, the full cross-chain flow is (Path B — two-hop via public chain):
    //   PL-A: endpoint.send(PL_B_CHAIN_ID, targetAddr, payload) → MessageDispatched
    //       → pubrelayer-a picks up → PublicRNEndpointV1.receivePayload() on public chain
    //       → public chain executor calls mirror contract
    //       → mirror re-dispatches → pubrelayer-b picks up
    //       → pubrelayer-b calls PL-B: rnEndpoint.receivePayload(srcChain, src, dst, msg, id)
    //       → PL-B Executor .call(payload) on the target contract
    //
    // We skip the PL-A → pubrelayer-a → Public Chain → pubrelayer-b → PL-B
    // relay by calling receivePayload()
    // directly. This is equivalent because:
    //   1. receivePayload() only checks onlyRelayerAuthorized (msg.sender)
    //   2. The relayer adds no security — it's a delivery service
    //   3. The vulnerability is in the Executor's .call() reentrancy,
    //      not in how the message arrives
    //   4. Any authorized relayer can call receivePayload() with any params
    //
    // NOTE: A full Path B relay test is not feasible because CUSTOM=0 tokens
    // have no mirror on the public chain, so the two-hop relay never delivers.
    // See SEC001_MessageExecutor_Reentrancy_CrossChain.ts for the PNH executor
    // variant that tests RaylsMessageExecutorV1 (protocol-level) on the CC.
    // -----------------------------------------------------------------------
    const attackTx = await rnEndpoint.receivePayload(
      BANK_A_CHAIN_ID,
      signer.address,    // srcAddress (Bank A)
      targetAddr,         // dstAddress (our reentrant target)
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

    // Check the LIVE executor's state (single source of truth post-replay-refactor).
    // The endpoint no longer maintains a mirror `executed` mapping.
    const legitimateExecuted = await executor.executed(legitimateMessageId);
    const fraudulentExecuted = await executor.executed(fraudulentMessageId);

    LOGGER.log(`   Settlements received:         ${settlementCount}`);
    LOGGER.log(`   Total CHF settled:            ${formatUnits(settledTotal, 18)} CHF`);
    LOGGER.log(`   Re-entry succeeded:           ${reentrySucceeded}`);
    LOGGER.log(`   LIVE Executor — legit msg:    ${legitimateExecuted}`);
    LOGGER.log(`   LIVE Executor — fraud msg:    ${fraudulentExecuted}`);

    // --- PHASE 5: IMPACT REPORT ---
    if (reentrySucceeded) {
      LOGGER.log('\n═══════════════════════════════════════════════════════════════');
      LOGGER.log('   ⚠️  VULNERABILITY CONFIRMED: SEC-001');
      LOGGER.log('═══════════════════════════════════════════════════════════════');
      LOGGER.log(`   DOUBLE SETTLEMENT on Bank B's LIVE executor + endpoint.`);
      LOGGER.log('');
      LOGGER.log(`   Legitimate: 5,000 CHF  (${legitimateMessageId.slice(0, 18)}...)`);
      LOGGER.log(`   Fraudulent: 50,000 CHF (${fraudulentMessageId.slice(0, 18)}...)`);
      LOGGER.log(`   TOTAL:      ${formatUnits(settledTotal, 18)} CHF`);
      LOGGER.log('');
      LOGGER.log('   The attack went through the LIVE infrastructure:');
      LOGGER.log(`     RNEndpointV1 (${rnEndpointAddr.slice(0, 18)}...) — both msgs marked executed`);
      LOGGER.log(`     Executor     (${executorAddr.slice(0, 18)}...) — both msgs marked executed`);
      LOGGER.log('');
      LOGGER.log('   The target re-entered via endpoint.receivePayload() with a');
      LOGGER.log('   different messageId. Replay protection was bypassed because');
      LOGGER.log('   the fraudulent messageId was never seen before.');
      LOGGER.log('═══════════════════════════════════════════════════════════════');
    }

    // Clean up: revoke the target's RELAYER role
    try {
      await (await manager.revokeRole(relayerRoleId, targetAddr)).wait();
      LOGGER.log('\n   Cleaned up: revoked RELAYER from target');
    } catch { /* best effort */ }

    // ASSERTION: reentrancy must be BLOCKED
    expect(reentrySucceeded).to.equal(
      false,
      `VULNERABILITY SEC-001 CONFIRMED: Re-entrant executeMessage() succeeded on the LIVE ` +
      `executor (${executorAddr}). Target re-entered through the LIVE endpoint ` +
      `(${rnEndpointAddr}) and injected 50,000 CHF alongside a legitimate 5,000 CHF ` +
      `settlement (total: ${formatUnits(settledTotal, 18)} CHF). Both messageIds ` +
      `are marked executed in the LIVE contracts. The receiveNonReentrant modifier must ` +
      `be added to executeMessage().`
    );
  });
});
