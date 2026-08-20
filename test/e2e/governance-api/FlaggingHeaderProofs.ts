// NOTE: Teleport is only the vehicle for a live non-teleport feature — migrate to Enygma/DVP on removal; do not delete this test.
import { expect } from 'chai';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import GovernanceController from '../../../src/api/GovernanceController';
import { DEFAULT_TIMEOUT, GAS_LIMIT, GOVERNANCE_API_URL } from '../../../src/config/env-config';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { ERC20Wrapper } from '../../../src/entities/tokens/ERC20Wrapper';
import { ProductionErc20Token, ProductionErc20Token__factory } from '../../../typechain-types';
import { Participant } from '../../../src/types';
import { eventually, submitTx } from '../../../src/utils/common';

describe('E2E Tests: Header proof liveliness flagging', function () {
  let privacyNodes: PrivacyNodeMap = {};
  let privateHub: PrivateHub;
  let ERC20: ERC20Wrapper<ProductionErc20Token>;
  const GovController = new GovernanceController(GOVERNANCE_API_URL);

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    // Deploy and teleport to ensure header proofs are submitted for both chains
    ERC20 = new ERC20Wrapper(privacyNodes.A, ProductionErc20Token__factory);
    await ERC20.deploy();
    await ERC20.activateOnPn();
    await ERC20.activateOnHub(privateHub);
    // ProductionErc20Token has no constructor premint → mint before teleporting.
    await ERC20.mintAndAwait(privateHub, { toAddress: ERC20.userWallet.address, amount: 2_000_000n * 10n ** 18n });

    await submitTx(() => ERC20.contract.teleportAtomic(
      ERC20.userWallet.address,
      10n,
      privacyNodes.B.chainId,
      { gasLimit: GAS_LIMIT }
    ), 'Teleporting ERC20 for header proof flagging tests...');
  });

  it('Should return participant with flagging fields in the API response @smoke', async function () {
    const participant = await eventually<Participant>({
      check: async () => {
        const p = await GovController.getParticipantByChainId(privacyNodes.A.chainId);
        if (p && p.chainId) return p;
      },
      interval: 6000,
      attempts: 6,
      message: `Waiting for participant with flagging fields (chain=${privacyNodes.A.chainId})`,
    });

    expect(participant).to.have.property('isFlagged');
    expect(participant.isFlagged).to.be.a('boolean');
    expect(participant).to.have.property('chainId');
    expect(participant).to.have.property('name');
    expect(participant).to.have.property('status');
    expect(participant).to.have.property('role');

  }).timeout(DEFAULT_TIMEOUT);

  it('Should show active participant as NOT flagged when proofs are being submitted @smoke', async function () {
    const participantA = await GovController.getParticipantByChainId(privacyNodes.A.chainId);

    expect(participantA.isFlagged, 'Participant A should not be flagged after recent activity').to.be.false;

    expect(participantA.flagReason).to.satisfy(
      (v: any) => v === undefined || v === null || v === '',
      'flagReason should be empty when not flagged'
    );
    expect(participantA.flaggedAt).to.satisfy(
      (v: any) => v === undefined || v === null || v === '',
      'flaggedAt should be empty when not flagged'
    );
  }).timeout(DEFAULT_TIMEOUT);

  it('Should return flagged transactions endpoint response structure @smoke', async function () {
    const response = await GovController.getFlaggedTransactions();

    expect(response).to.have.property('flagged');

    // API returns null when no flagged transactions exist, treat as empty array
    const flagged = response.flagged ?? [];
    expect(flagged).to.be.an('array');

    for (const item of flagged) {
      expect(item).to.have.property('id').that.is.a('string');
      expect(item).to.have.property('transactionId').that.is.a('string');
      expect(item).to.have.property('createdAt').that.is.a('string');
      expect(item).to.have.property('updatedAt').that.is.a('string');
    }

  }).timeout(DEFAULT_TIMEOUT);
});
