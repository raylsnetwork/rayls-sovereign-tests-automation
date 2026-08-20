/**
 * E2E checks for `DvpErc1155PNH.burn` data-lifecycle correctness:
 *   1. Partial burn must NOT clear `_tokenIdToChainId[id]` — chainId is per
 *      token id, not per holder.
 *   2. Full burn (totalSupply hits zero) must clear `_tokenIdToChainId`,
 *      `tokenExtraData`, `tokenRegisteredToGroup` and `tokenIsFungible` so a
 *      future re-mint of the same id starts from a clean slate.
 */

import { expect } from 'chai';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../src/config/env-config';
import { submitTx } from '../../../src/utils/common';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { ERC1155Wrapper } from '../../../src/entities/tokens/ERC1155Wrapper';
import {
  ProductionErc1155Dvp,
  ProductionErc1155Dvp__factory,
  DvpErc1155PNH,
  DvpErc1155PNH__factory,
} from '../../../typechain-types';

describe('E2E SECURITY: DvpErc1155PNH burn data-lifecycle @security @erc1155 @dvp', function () {
  this.retries(0);
  this.timeout(DEFAULT_TIMEOUT);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let nftWrapper: ERC1155Wrapper<ProductionErc1155Dvp>;
  let dvpErc1155Pnh: DvpErc1155PNH;

  before(async function () {
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    nftWrapper = new ERC1155Wrapper<ProductionErc1155Dvp>(privacyNodes.A, ProductionErc1155Dvp__factory);
    nftWrapper.setFields('dvp1155-burn-life');
    await nftWrapper.deploy();
    await nftWrapper.activateOnPn();
    await nftWrapper.activateOnHub(privateHub);

    const cached = privateHub.getPNHContract<DvpErc1155PNH>(nftWrapper.symbol);
    const pnhTokenAddress = await cached.getAddress();
    dvpErc1155Pnh = DvpErc1155PNH__factory.connect(pnhTokenAddress, privateHub.adminWallet);

    LOGGER.log(`   PNH chainId             : ${(await privateHub.provider.getNetwork()).chainId}`);
    LOGGER.log(`   DvpErc1155PNH address   : ${pnhTokenAddress}`);
  });

  it('partial burn preserves the per-id chainId mapping', async function () {
    const tokenId = 0xC1EA0n;
    const chainId = 42n;
    const initial = 100n;
    const burned  = 60n;
    const owner = privateHub.adminWallet.address;

    await submitTx(
      () => dvpErc1155Pnh.mint(owner, tokenId, initial, '0x', chainId, [], { gasLimit: GAS_LIMIT }),
      `dvp1155 burn-life: partial-burn mint id=0x${tokenId.toString(16)}`,
    );

    expect(await dvpErc1155Pnh.getChainIdByTokenId(tokenId)).to.equal(chainId);

    await submitTx(
      () => dvpErc1155Pnh.burn(owner, tokenId, burned, { gasLimit: GAS_LIMIT }),
      `dvp1155 burn-life: partial burn id=0x${tokenId.toString(16)}`,
    );

    expect(
      await dvpErc1155Pnh.balanceOf(owner, tokenId),
      'remaining balance after partial burn',
    ).to.equal(initial - burned);

    expect(
      await dvpErc1155Pnh.getChainIdByTokenId(tokenId),
      'chainId must persist while supply > 0',
    ).to.equal(chainId);
  });

  it('full burn clears chainId and tokenExtraData; re-mint starts clean', async function () {
    const tokenId = 0xBEEFn;
    const chainId = 7n;
    const seededExtra = { key: 'color', value: 'red', isPublic: true };
    const owner = privateHub.adminWallet.address;

    await submitTx(
      () => dvpErc1155Pnh.mint(owner, tokenId, 100, '0x', chainId, [seededExtra], { gasLimit: GAS_LIMIT }),
      `dvp1155 burn-life: full-burn mint id=0x${tokenId.toString(16)}`,
    );

    const beforeBurn = await dvpErc1155Pnh.getTokenExtraData(tokenId);
    expect(beforeBurn.length, 'pre-state: extras seeded').to.equal(1);
    expect(await dvpErc1155Pnh.isTokenRegistered(tokenId), 'pre-state: token registered').to.equal(true);
    expect(await dvpErc1155Pnh.getTokenFungibility(tokenId), 'pre-state: token fungible').to.equal(true);

    await submitTx(
      () => dvpErc1155Pnh.burn(owner, tokenId, 100, { gasLimit: GAS_LIMIT }),
      `dvp1155 burn-life: full burn id=0x${tokenId.toString(16)}`,
    );

    // `totalSupply` is overloaded (totalSupply() and totalSupply(uint256));
    // select the per-id variant explicitly.
    expect(
      await dvpErc1155Pnh['totalSupply(uint256)'](tokenId),
      'supply zeroed',
    ).to.equal(0n);
    expect(
      await dvpErc1155Pnh.getChainIdByTokenId(tokenId),
      'chainId cleared on full burn',
    ).to.equal(0n);

    const afterBurn = await dvpErc1155Pnh.getTokenExtraData(tokenId);
    LOGGER.log(`   tokenExtraData after full burn: length=${afterBurn.length}`);
    expect(afterBurn.length, 'tokenExtraData cleared on full burn').to.equal(0);
    expect(
      await dvpErc1155Pnh.isTokenRegistered(tokenId),
      'tokenRegisteredToGroup cleared on full burn',
    ).to.equal(false);

    // Re-mint with no extras — must observe a fresh empty array and the
    // first-mint registration block must run again on the cleared id.
    await submitTx(
      () => dvpErc1155Pnh.mint(owner, tokenId, 1, '0x', 99, [], { gasLimit: GAS_LIMIT }),
      `dvp1155 burn-life: re-mint clean id=0x${tokenId.toString(16)}`,
    );

    const afterRemint = await dvpErc1155Pnh.getTokenExtraData(tokenId);
    expect(afterRemint.length, 're-mint must not inherit stale extras').to.equal(0);
    expect(await dvpErc1155Pnh.isTokenRegistered(tokenId), 'token re-registered after re-mint').to.equal(true);
    expect(await dvpErc1155Pnh.getTokenFungibility(tokenId), 'token fungibility set after re-mint').to.equal(true);
  });
});
