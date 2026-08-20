/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
import { expect } from 'chai';
import { ParticipantStorageV1, ParticipantStorageReplicaV1__factory, TokenExample, TokenExample__factory } from '../../typechain-types';
import { PrivateHub } from '../../src/entities/PrivateHub';
import { DEFAULT_TIMEOUT, GAS_LIMIT } from '../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../setup';
import { ERC20Wrapper } from '../../src/entities/tokens/ERC20Wrapper';
import { createRandomWallet, eventually, submitTx } from '../../src/utils/common';
import { syncParticipantStatusOnReplicas } from '../test-utils/freeze-helpers';

describe('E2E Tests: Erc20 (erc20) @serial @decommissioned', function () {
  const AMOUNT = 30n;

  let privacyNodes: PrivacyNodeMap;
  let privateHub : PrivateHub;

  let token : ERC20Wrapper<TokenExample>;
  let tokenOnB : TokenExample;
  let thirdPartyWallet: ReturnType<typeof createRandomWallet>;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const {initializedNodes, initializedPNH} = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    thirdPartyWallet = createRandomWallet(privacyNodes.B.provider);

    token = new ERC20Wrapper<TokenExample>(privacyNodes.A, TokenExample__factory);
    await token.deploy();
    await token.activateOnPn();
    await token.activateOnHub(privateHub);
  });

  it('Should teleport Vanilla from A to B (automatic contract deploy on B) @smoke', async function () {
    await submitTx(
      () => token.contract.teleport(
        token.userWallet.address,
        AMOUNT,
        privacyNodes.B.chainId,
        { gasLimit: GAS_LIMIT }
      ),
      `Teleporting ${AMOUNT} to ${privacyNodes.B.chainId}...`
    );

    tokenOnB = await privacyNodes.B.setContractByResourceId(TokenExample__factory.name, token.resourceId, token.symbol, token.userWallet.connect(privacyNodes.B.provider));

    await eventually<boolean>({
      check: async () => {
        const balance = await tokenOnB.balanceOf(token.userWallet.address);

        return balance === BigInt(AMOUNT);
      },
      message: `Checking balance`,
    });
  }).timeout(DEFAULT_TIMEOUT);

  it('Should teleport atomic from B to A @smoke', async function () {
    const balanceBeforeA = await token.contract.balanceOf(token.userWallet.address);
    const balanceBeforeB = await tokenOnB.balanceOf(token.userWallet.address);

    await submitTx(
      () => tokenOnB.teleportAtomic(
        token.userWallet.address,
        AMOUNT,
        privacyNodes.A.chainId,
        { gasLimit: GAS_LIMIT }
      ),
      `Teleporting ${AMOUNT} to ${privacyNodes.A.chainId}`
    );

    await eventually<boolean>({
      check: async () => {
        const balanceAfterA = await token.contract.balanceOf(token.userWallet.address);
        const balanceAfterB = await tokenOnB.balanceOf(token.userWallet.address)

        return balanceAfterB === balanceBeforeB - BigInt(AMOUNT) &&
          balanceAfterA === balanceBeforeA + BigInt(AMOUNT);
      },
      message: `Checking balances`,
    });
  }).timeout(DEFAULT_TIMEOUT);

  it('Should teleport atomic from A to B, fail when reaching B and revert', async function () {
    const addressToFail = await token.contract.addressToFail();
    const balanceBeforeA = await token.contract.balanceOf(token.userWallet.address);
    const balanceBeforeB = await tokenOnB.balanceOf(addressToFail);

    await submitTx(
      () => token.contract.teleportAtomic(
        addressToFail,
        AMOUNT,
        privacyNodes.B.chainId,
        { gasLimit: GAS_LIMIT }
      ),
      `Teleporting from A to fail address on B...`
    );

    await eventually<boolean>({
      check: async () => {
        const balanceAfterA = await token.contract.balanceOf(token.userWallet.address);
        const balanceAfterB = await tokenOnB.balanceOf(addressToFail);

        return balanceAfterA === balanceBeforeA && balanceAfterB === balanceBeforeB;
      },
      message: `Checking balances`,
    });
  }).timeout(DEFAULT_TIMEOUT);

  it('Should teleport vanilla and atomic as a 3rd Party from A to B (automatic contract deploy on B)', async function () {
    const balanceBeforeA = await token.contract.balanceOf(token.userWallet.address);
    const balanceBeforeB = await tokenOnB.balanceOf(token.userWallet.address);

    await submitTx(
      () => token.contract.approve(
        thirdPartyWallet.address,
        AMOUNT,
        { gasLimit: GAS_LIMIT }
      ),
      `Approving third party...`
    );

    const thirdPartyOnA = thirdPartyWallet.connect(privacyNodes.A.provider);

    await submitTx(
      () => token.contract.connect(
        thirdPartyOnA
      ).teleportFrom(
        token.userWallet.address,
        token.userWallet.address,
        AMOUNT,
        privacyNodes.B.chainId,
        { gasLimit: GAS_LIMIT }
      ),
      `Teleporting...`
    );

    await eventually<boolean>({
      check: async () => {
        const balanceAfterA = await token.contract.balanceOf(token.userWallet.address);
        const balanceAfterB = await tokenOnB.balanceOf(token.userWallet.address);

        return balanceAfterA === balanceBeforeA - BigInt(AMOUNT) &&
          balanceAfterB === balanceBeforeB + BigInt(AMOUNT);
      },
      message: `Checking balances`,
    });
  }).timeout(DEFAULT_TIMEOUT);

  it('Should teleport atomic from A to B, then revert because B frozen', async function () {
    const balanceBeforeA = await token.contract.balanceOf(token.userWallet.address);

    const STATUS_FROZEN = BigInt(3);
    const psResourceId = await privateHub.getContract<ParticipantStorageV1>('ParticipantStorageV1').resourceId();
    const replicaAddr = await privacyNodes.A.getEndpointV1().getAddressByResourceId(psResourceId);
    const replica = ParticipantStorageReplicaV1__factory.connect(replicaAddr, privacyNodes.A.provider);

    const participant = await privateHub
      .getContract<ParticipantStorageV1>('ParticipantStorageV1')
      .getParticipant(privacyNodes.B.chainId);
    const participantsNeedToBeFrozen = participant.status !== STATUS_FROZEN;

    if (participantsNeedToBeFrozen) {
      await privateHub.updateParticipantStatus(privacyNodes.B.chainId, STATUS_FROZEN);

      // Wait for the PNH's automatic broadcast to propagate the freeze to PN-A's replica.
      // PNH._broadCastParticipant sends addOrUpdateParticipants to all PNs via cross-chain.
      await eventually<boolean>({
        check: async () => {
          const participants = await replica.getAllParticipants();
          const pB = participants.find(p => p.chainId === BigInt(privacyNodes.B.chainId));
          return pB?.status === STATUS_FROZEN;
        },
        message: `Waiting for freeze broadcast → PN-A replica`,
      });
    }

    // Verify the teleport reverts when destination participant is frozen.
    // No gasLimit — let gas estimation catch the revert (matches FreezeTokens pattern).
    await expect(
      privacyNodes.A.getContract<TokenExample>(token.symbol).teleportAtomic(
        token.userWallet.address,
        AMOUNT,
        privacyNodes.B.chainId,
      )
    ).to.be.revertedWithCustomError(replica, 'ParticipantStorageReplicaV1__ParticipantNotActive');

    await eventually<boolean>({
      check: async () => {
        const balanceAfterA = await token.contract.balanceOf(token.userWallet.address);

        return balanceAfterA === balanceBeforeA;
      },
      message: `Checking balances`,
    });

    const STATUS_ACTIVE = BigInt(1);
    const updatedParticipant = await privateHub
      .getContract<ParticipantStorageV1>('ParticipantStorageV1')
      .getParticipant(privacyNodes.B.chainId);
    const participantsNeedToBeActivated = updatedParticipant.status !== STATUS_ACTIVE;

    if (participantsNeedToBeActivated) {
      await privateHub.updateParticipantStatus(privacyNodes.B.chainId, STATUS_ACTIVE);

      // Trigger PL replica sync so subsequent tests don't hit stale frozen status
      await syncParticipantStatusOnReplicas(
        privateHub, Object.values(privacyNodes), privacyNodes.B.chainId, STATUS_ACTIVE,
      );
    }
  }).timeout(DEFAULT_TIMEOUT);
});
