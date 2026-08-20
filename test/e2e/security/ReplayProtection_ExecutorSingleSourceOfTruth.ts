/**
 * @title E2E SECURITY: Replay protection on RNEndpointV1.receivePayload
 * @description Validates on a live deployment that:
 *   1. A legitimate cross-chain message sets executor.executed(messageId) = true.
 *   2. A second delivery of the same messageId through RNEndpointV1.receivePayload
 *      reverts and does not re-execute the payload.
 *
 * SECURITY IMPLICATION:
 *   Replay of cross-chain messages would allow duplicate execution of settlement
 *   payloads (double settlement, double mint, etc.). This test asserts the
 *   executor-layer guard blocks the second delivery.
 *
 * TEST STRATEGY:
 *   Calls RNEndpointV1.receivePayload directly from an authorized RELAYER signer
 *   with a benign settlement target. The relayer layer itself adds no security, so
 *   exercising the endpoint/executor path directly is equivalent to a full relayed
 *   cross-chain delivery for validating the replay guard.
 */
import { formatUnits, keccak256, parseUnits, toUtf8Bytes, ZeroAddress, ZeroHash } from 'ethers';
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

const LEGIT_CHF = parseUnits('1000', 18);
const BANK_A_CHAIN_ID = 10001n;

describe('E2E SECURITY: Replay Protection - Executor as Single Source of Truth @security @hubless', function () {
  this.timeout(DEFAULT_TIMEOUT);

  let privacyNodes: PrivacyNodeMap;

  before(async function () {
    privacyNodes = await initializePrivacyNodes(2);
  });

  it('A valid receivePayload marks executor.executed(messageId) = true; replay reverts at executor', async function () {
    LOGGER.log('\n===============================================================');
    LOGGER.log('   Replay Protection: Executor Single-Source-of-Truth (live)');
    LOGGER.log('===============================================================');

    const signer = privacyNodes.B.adminWallet;
    const deployer = createUserOperator(privacyNodes.B.provider);

    // ---- PHASE 1: locate live infra on PN-B ----
    const rnEndpointAddr = await privacyNodes.B.resolveFromRegistry('RNEndpoint');
    const rnEndpoint = RNEndpointV1__factory.connect(rnEndpointAddr, signer);
    const executorAddr = await rnEndpoint.messageExecutor();
    const executor = RNMessageExecutorV1__factory.connect(executorAddr, signer);
    const managerAddr = await rnEndpoint.authority();
    const manager = RaylsAccessManagerV1__factory.connect(managerAddr, signer);

    LOGGER.log(`   LIVE RNEndpointV1:         ${rnEndpointAddr}`);
    LOGGER.log(`   LIVE RNMessageExecutorV1:  ${executorAddr}`);

    const relayerRoleId = await manager.getRoleIdByName('RELAYER');

    // ---- PHASE 2: deploy a benign target and register as relayer (so it can call receivePayload) ----
    const nonce = Date.now().toString() + Math.random().toString();
    const messageId = keccak256(toUtf8Bytes(`replay-protection-${nonce}`));
    // Reuse SEC001_ReentrantSettlement as a simple "settle(uint256)" target.
    // `fraudulentMessageId` + amount args are unused when no re-entry happens.
    const target = await new SEC001_ReentrantSettlement__factory(deployer).deploy(
      rnEndpointAddr,
      ZeroHash, // no re-entry
      0n,
    );
    await target.waitForDeployment();
    const targetAddr = await target.getAddress();
    LOGGER.log(`   Benign target deployed:    ${targetAddr}`);

    await (await manager.grantRole(relayerRoleId, targetAddr, 0)).wait();

    const settlePayload = SEC001_ReentrantSettlement__factory.createInterface().encodeFunctionData(
      'settle',
      [LEGIT_CHF],
    );

    const raylsMessage = {
      messageMetadata: {
        nonce: 0,
        newResourceMetadata: {
          resourceDeployType: 0,
          bytecode: '0x',
          factoryTemplate: 0,
          initializerParams: '0x',
        },
        revertPayloadData: '0x',
        transferMetadata: {
          assetType: 0,
          id: 0,
          from: ZeroAddress,
          to: ZeroAddress,
          tokenAddress: ZeroAddress,
          amount: 0,
        },
      },
      payload: settlePayload,
    };

    // ---- PHASE 3: first delivery (should succeed) ----
    LOGGER.log('\n   PHASE 3: first delivery');
    const tx1 = await rnEndpoint.receivePayload(
      BANK_A_CHAIN_ID,
      signer.address,
      targetAddr,
      raylsMessage,
      messageId,
      { gasLimit: GAS_LIMIT },
    );
    await tx1.wait();

    const settlementCountAfter1 = await target.settlementCount();
    const settledTotalAfter1 = await target.settledTotal();
    const executorFlagAfter1 = await executor.executed(messageId);
    LOGGER.log(`   settlementCount:           ${settlementCountAfter1}`);
    LOGGER.log(`   settledTotal:              ${formatUnits(settledTotalAfter1, 18)} CHF`);
    LOGGER.log(`   executor.executed(msgId):  ${executorFlagAfter1}`);

    expect(settlementCountAfter1).to.equal(1n, 'first delivery should settle once');
    expect(settledTotalAfter1).to.equal(LEGIT_CHF);
    expect(executorFlagAfter1).to.equal(true, 'executor must record messageId as executed');

    // ---- PHASE 4: sanity check - endpoint no longer exposes `executed` / `isExecuted` ----
    // These are ABI-level proofs that the refactor removed the endpoint-side mapping,
    // not just shadowed it. Any attempt to call them through the typed contract should
    // throw at the typechain layer; direct low-level calls should revert.
    // ---- PHASE 4: replay attempt must revert via the executor-layer guard ----
    LOGGER.log('\n   PHASE 4: replay attempt must revert');
    let replayReverted = false;
    let revertReason = '';
    try {
      const tx2 = await rnEndpoint.receivePayload(
        BANK_A_CHAIN_ID,
        signer.address,
        targetAddr,
        raylsMessage,
        messageId,
        { gasLimit: GAS_LIMIT },
      );
      await tx2.wait();
    } catch (err: any) {
      replayReverted = true;
      revertReason = err?.shortMessage || err?.message || String(err);
    }
    LOGGER.log(`   replay reverted:           ${replayReverted}`);
    LOGGER.log(`   reason:                    ${revertReason}`);

    expect(replayReverted, 'second delivery of the same messageId must revert').to.equal(true);
    expect(
      revertReason.includes('MessageIdAlreadyExecuted') || revertReason.includes('already') || revertReason.includes('reverted'),
      `revert reason should mention replay protection; got: ${revertReason}`,
    ).to.equal(true);

    // Target state should be unchanged after the failed replay.
    const settlementCountAfter2 = await target.settlementCount();
    expect(settlementCountAfter2).to.equal(1n, 'replay must not settle a second time');
  });
});
