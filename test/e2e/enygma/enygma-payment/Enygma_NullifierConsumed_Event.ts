import { expect } from 'chai';
import { HDNodeWallet, Wallet } from 'ethers';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
  EnygmaV1,
  EnygmaV1__factory,
} from '../../../../typechain-types';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { DEFAULT_TIMEOUT, LOGGER } from '../../../../src/config/env-config';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { linearTransferEnygma } from '../../../../src/flows/tokens/token-flows';
import { eventually } from '../../../../src/utils/common';
import { shortHex } from '../../../../src/utils/formatters';

/**
 * Audit trail (#208): EnygmaV1 emits `NullifierConsumed(resourceId, nullifier, blockNumber, txType)`
 * once per consumed nullifier, on the PNH (commit-chain) instance where `transferBatch` runs. This is
 * the on-chain surface an off-chain indexer/reconciler reads. The test stands in for that consumer:
 * after a cross-chain transfer it queries the PNH EnygmaV1 logs and asserts the event was emitted.
 *
 * NOTE: requires the EnygmaV1 typechain types to be regenerated after the contract change (the new
 * event), same as any ABI update — `filters.NullifierConsumed` does not exist on the old types.
 */
describe('E2E Tests: EnygmaV1 NullifierConsumed audit event', function () {
  let signerA: HDNodeWallet | Wallet;
  let tokenOnPNA: EnygmaWrapper<ProductionEnygmaToken>;
  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let enygmaOnPNH: EnygmaV1;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    tokenOnPNA = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
    signerA = tokenOnPNA.userWallet;
    await tokenOnPNA.deployViaFactory();
    await tokenOnPNA.activateOnPn();
    await tokenOnPNA.activateOnHub(privateHub);
    await tokenOnPNA.mintAndAwait(privateHub, { amount: 1000n, toAddress: signerA.address });

    // NullifierConsumed is emitted by transferBatch on the PNH (commit-chain) EnygmaV1 instance.
    enygmaOnPNH = await privateHub.setContractByResourceId<EnygmaV1>(
      EnygmaV1__factory.name,
      tokenOnPNA.resourceId,
      tokenOnPNA.symbol,
    );
  });

  it('emits NullifierConsumed on the PNH for a cross-chain transfer @enygma', async function () {
    const fromBlock = await privateHub.provider.getBlockNumber();

    await linearTransferEnygma(
      {
        destinationAddress: signerA.address,
        amount: 10n,
        destinationChainId: privacyNodes.B.chainId,
        programData: [],
      },
      2,
      10n,
      privateHub,
      privacyNodes.A,
      privacyNodes.B,
      tokenOnPNA,
    );

    const filter = enygmaOnPNH.filters.NullifierConsumed();

    const logs = await eventually({
      check: async () => {
        const toBlock = await privateHub.provider.getBlockNumber();
        const result = await enygmaOnPNH.queryFilter(filter, fromBlock, toBlock);
        return result.length > 0 ? result : undefined;
      },
      interval: 1000,
      attempts: 60,
      tolerateErrors: true,
      message: `Waiting for NullifierConsumed on PNH (resourceId=${shortHex(tokenOnPNA.resourceId)})`,
    });

    // resourceId topic must match this token; nullifier + blockNumber must be non-zero/real.
    expect(logs[0].args.resourceId).to.equal(tokenOnPNA.resourceId);
    expect(logs[0].args.nullifier).to.not.equal(0n);
    expect(logs[0].args.blockNumber).to.be.greaterThan(0n);

    LOGGER.log(`✅ NullifierConsumed emitted ${logs.length} time(s) on PNH for resourceId ${shortHex(tokenOnPNA.resourceId)}`);
  }).timeout(5 * 60 * 1000);
});
