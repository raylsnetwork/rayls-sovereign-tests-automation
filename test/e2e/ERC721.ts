/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
import { ProductionErc721Token, ProductionErc721Token__factory } from '../../typechain-types';
import { ERC721Wrapper } from '../../src/entities/tokens/ERC721Wrapper';
import { DEFAULT_TIMEOUT, GAS_LIMIT } from '../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../setup';
import { eventually, submitTx } from '../../src/utils/common';

describe('E2E Tests: Erc721 (erc721) @decommissioned', function () {
  let privacyNodes: PrivacyNodeMap;
  let privateHub: any;

  let nft: ERC721Wrapper<ProductionErc721Token>;
  let nftOnB: ProductionErc721Token;
  let tokenId: bigint;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    nft = new ERC721Wrapper<ProductionErc721Token>(privacyNodes.A, ProductionErc721Token__factory);
    await nft.deploy();
    await nft.activateOnPn();
    await nft.activateOnHub(privateHub);
    tokenId = await nft.mintAndAwait(privateHub, { toAddress: nft.userWallet.address })
  });

  it('Should teleport Vanilla from A to B (automatic contract deploy on B) @smoke', async function () {
    await submitTx(
      () => nft.contract.teleport(
        nft.userWallet.address,
        tokenId,
        privacyNodes.B.chainId,
        { gasLimit: GAS_LIMIT }
      ),
      `Teleporting NFT to ${privacyNodes.B.chainId}...`
    );

    nftOnB = await privacyNodes.B.setContractByResourceId(
      ProductionErc721Token__factory.name,
      nft.resourceId,
      nft.symbol,
      nft.userWallet.connect(privacyNodes.B.provider)
    );

    await eventually<boolean>({
      check: async () => {
        const balanceB = await nftOnB.balanceOf(nft.userWallet.address);
        return balanceB === 1n;
      },
      message: `Checking balance on B`,
    });
  }).timeout(DEFAULT_TIMEOUT);

  it('Should teleport atomic from B to A @smoke', async function () {
    const balanceBeforeA = await nft.contract.balanceOf(nft.userWallet.address);
    const balanceBeforeB = await nftOnB.balanceOf(nft.userWallet.address);

    await submitTx(
      () => nftOnB.teleportAtomic(
        nft.userWallet.address,
        tokenId,
        privacyNodes.A.chainId,
        { gasLimit: GAS_LIMIT }
      ),
      `Teleporting NFT back to ${privacyNodes.A.chainId}...`
    );

    await eventually<boolean>({
      check: async () => {
        const balanceAfterA = await nft.contract.balanceOf(nft.userWallet.address);
        const balanceAfterB = await nftOnB.balanceOf(nft.userWallet.address);
        return balanceAfterA === balanceBeforeA + 1n && balanceAfterB === balanceBeforeB - 1n;
      },
      message: `Checking balances`,
    });
  }).timeout(DEFAULT_TIMEOUT);
});
