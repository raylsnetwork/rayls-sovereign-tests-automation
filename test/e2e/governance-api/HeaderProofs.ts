// NOTE: Teleport is only the vehicle for a live non-teleport feature — migrate to Enygma/DVP on removal; do not delete this test.
import { expect } from 'chai';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { ERC20Wrapper } from '../../../src/entities/tokens/ERC20Wrapper';
import GovernanceController from '../../../src/api/GovernanceController';
import { DEFAULT_TIMEOUT, GAS_LIMIT, GOVERNANCE_API_URL } from '../../../src/config/env-config';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { ProductionErc20Token, ProductionErc20Token__factory } from '../../../typechain-types';
import { eventually, submitTx } from '../../../src/utils/common';
import { HeaderProofListResponse } from '../../../src/types';

describe('E2E Tests: Header Proofs - Assert the governance API returns header proofs after cross-chain activity', function () {
  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let ERC20: ERC20Wrapper<ProductionErc20Token>;
  const GovController = new GovernanceController(GOVERNANCE_API_URL);

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    ERC20 = new ERC20Wrapper(privacyNodes.A, ProductionErc20Token__factory);
    await ERC20.deploy();
    await ERC20.activateOnPn();
    await ERC20.activateOnHub(privateHub);
    // ProductionErc20Token has no constructor premint → mint before teleporting.
    await ERC20.mintAndAwait(privateHub, { toAddress: ERC20.userWallet.address, amount: 2_000_000n * 10n ** 18n });
  });

  it('Should return header proofs for a participant chain after a teleport @smoke', async function () {
    const startBlock = await privateHub.provider.getBlockNumber();

    // Teleport to generate block activity and trigger proof submission
    const receipt = await submitTx(() => ERC20.contract.teleportAtomic(
      ERC20.userWallet.address,
      50n,
      privacyNodes.B.chainId,
      { gasLimit: GAS_LIMIT }
    ), 'Teleporting ERC20 from A to B...');

    const endBlock = await privateHub.provider.getBlockNumber();

    // Poll until the governance API has indexed header proofs for chain A
    const proofResponse = await eventually<HeaderProofListResponse>({
      check: async () => {
        const res = await GovController.getHeaderProofs({
          chainId: privacyNodes.A.chainId,
          startBlock: '0',
          endBlock: String(endBlock),
        });
        if (res.data.length > 0) return res;
      },
      interval: 6000,
      attempts: 10,
      message: `Waiting for header proofs indexed (chain=${privacyNodes.A.chainId})`,
    });

    // Assert pagination metadata
    expect(proofResponse.pagination).to.have.property('currentPage');
    expect(proofResponse.pagination).to.have.property('pageSize');
    expect(proofResponse.pagination).to.have.property('totalRecords');
    expect(proofResponse.pagination).to.have.property('totalPages');
    expect(proofResponse.pagination.totalRecords).to.be.greaterThan(0);

    // Assert proof entries structure
    const proofs = proofResponse.data;
    expect(proofs).to.be.an('array').that.is.not.empty;

    for (const proof of proofs) {
      expect(proof).to.have.property('id');
      expect(proof).to.have.property('chainId');
      expect(proof).to.have.property('blockNumber');
      expect(proof).to.have.property('blockHash');
      expect(proof).to.have.property('createdAt');
      expect(proof.chainId).to.equal(privacyNodes.A.chainId);
      expect(proof.blockHash).to.match(/^0x[a-fA-F0-9]{64}$/);
    }

    // Assert block numbers are ordered
    const blockNumbers = proofs.map(p => BigInt(p.blockNumber));
    for (let i = 1; i < blockNumbers.length; i++) {
      expect(blockNumbers[i]).to.be.greaterThanOrEqual(blockNumbers[i - 1]);
    }
  }).timeout(DEFAULT_TIMEOUT);

  it('Should return paginated header proofs with correct page metadata', async function () {
    const endBlock = await privateHub.provider.getBlockNumber();

    const proofResponse = await GovController.getHeaderProofs({
      chainId: privacyNodes.A.chainId,
      startBlock: '0',
      endBlock: String(endBlock),
      page: 1,
      pageSize: 2,
    });

    expect(proofResponse.pagination.currentPage).to.equal(1);
    expect(proofResponse.pagination.pageSize).to.equal(2);
    expect(proofResponse.data.length).to.be.at.most(2);

    if (proofResponse.pagination.totalRecords > 2) {
      expect(proofResponse.pagination.totalPages).to.be.greaterThan(1);
    }
  }).timeout(DEFAULT_TIMEOUT);

  it('Should return empty array when no proofs exist for a non-existent chain', async function () {
    const proofResponse = await GovController.getHeaderProofs({
      chainId: '999999999',
      startBlock: '0',
      endBlock: '100',
    });

    expect(proofResponse.data).to.be.an('array').that.is.empty;
    expect(proofResponse.pagination.totalRecords).to.equal(0);
  }).timeout(DEFAULT_TIMEOUT);
});
