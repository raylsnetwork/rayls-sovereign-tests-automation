/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
import { DEFAULT_TIMEOUT, GAS_LIMIT } from '../../src/config/env-config';
import { RaylsErc1155Example, RaylsErc1155Example__factory } from '../../typechain-types';
import { ERC1155Wrapper } from '../../src/entities/tokens/ERC1155Wrapper';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../setup';
import { eventually, submitTx } from '../../src/utils/common';

describe('E2E Tests: Erc1155 (erc1155) @decommissioned', function () {
  const AMOUNT = 30n;
  const tokenId = 1n;

  let privacyNodes: PrivacyNodeMap;
  let privateHub: any;

  let token: ERC1155Wrapper<RaylsErc1155Example>;
  let tokenOnB: RaylsErc1155Example;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    token = new ERC1155Wrapper<RaylsErc1155Example>(privacyNodes.A, RaylsErc1155Example__factory);
    await token.deploy();
    await token.activateOnPn();
    await token.activateOnHub(privateHub);
    await token.mintAndAwait(privateHub,{amount:AMOUNT,tokenId:tokenId,toAddress:token.userWallet.address})
  });

  it('Should teleport Vanilla from A to B (automatic contract deploy on B) @smoke', async function () {
    await submitTx(
      () => token.contract.teleport(
        token.userWallet.address,
        tokenId,
        AMOUNT,
        privacyNodes.B.chainId,
        token.data(),
        { gasLimit: GAS_LIMIT }
      ),
      `Teleporting ${AMOUNT} to ${privacyNodes.B.chainId}...`
    );

    const signerOnB = token.userWallet.connect(privacyNodes.B.provider);
    tokenOnB = await privacyNodes.B.setContractByResourceId(
      RaylsErc1155Example__factory.name,
      token.resourceId,
      token.symbol,
      signerOnB
    );

    await eventually<boolean>({
      check: async () => {
        const balanceB = await tokenOnB.balanceOf(token.userWallet.address, tokenId);
        return balanceB === BigInt(AMOUNT);
      },
      message: `Checking balance`,
    });
  }).timeout(DEFAULT_TIMEOUT);

  it('Should teleport atomic from B to A @smoke', async function () {
    const balanceBeforeA = await token.contract.balanceOf(token.userWallet.address,tokenId);
    const balanceBeforeB = await tokenOnB.balanceOf(token.userWallet.address,tokenId);

    await submitTx(
      () => tokenOnB.teleportAtomic(
        token.userWallet.address,
        tokenId,
        AMOUNT,
        privacyNodes.A.chainId,
        token.data(),
        { gasLimit: GAS_LIMIT }
      ),
      `Teleporting ${AMOUNT} to ${privacyNodes.A.chainId}`
    );

    await eventually<boolean>({
      check: async () => {
        const balanceAfterA = await token.contract.balanceOf(token.userWallet.address,tokenId);
        const balanceAfterB = await tokenOnB.balanceOf(token.userWallet.address,tokenId);

        return balanceAfterB === balanceBeforeB - BigInt(AMOUNT) &&
          balanceAfterA === balanceBeforeA + BigInt(AMOUNT);
      },
      message: `Checking balances`,
    });
  }).timeout(DEFAULT_TIMEOUT);

  it('Should teleport atomic from A to B, fail when reaching B and revert', async function () {
    const addressToFail = await tokenOnB.addressToFail();
    const balanceBeforeA = await token.contract.balanceOf(token.userWallet.address,tokenId);
    const balanceBeforeB = await tokenOnB.balanceOf(addressToFail,tokenId);


    await submitTx(
      () => token.contract.teleportAtomic(
        addressToFail,
        tokenId,
        AMOUNT,
        privacyNodes.B.chainId,
        token.data(),
        { gasLimit: GAS_LIMIT }
      ),
      `Teleporting from A to fail address on B...`
    );

    await eventually<boolean>({
      check: async () => {
        const balanceAfterA = await token.contract.balanceOf(token.userWallet.address,tokenId);
        const balanceAfterB = await tokenOnB.balanceOf(addressToFail,tokenId);
        return balanceAfterA === balanceBeforeA && balanceAfterB === balanceBeforeB;
      },
      message: `Checking balances`,
    });
  }).timeout(DEFAULT_TIMEOUT);
});
