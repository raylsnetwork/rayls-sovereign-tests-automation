/**
 * E2E check: `DvpErc721PNH.burn` must clear `nftExtraData[id]` so a future
 * re-mint of the same id does not inherit stale metadata entries.
 */

import { expect } from 'chai';
import { ethers } from 'ethers';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../src/config/env-config';
import { submitTx } from '../../../src/utils/common';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { ERC721Wrapper } from '../../../src/entities/tokens/ERC721Wrapper';
import {
  ProductionErc721Dvp,
  ProductionErc721Dvp__factory,
  DvpErc721PNH,
  DvpErc721PNH__factory,
} from '../../../typechain-types';

describe('E2E SECURITY: DvpErc721PNH burn clears nftExtraData @security @erc721 @dvp', function () {
  this.retries(0);
  this.timeout(DEFAULT_TIMEOUT);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let nftWrapper: ERC721Wrapper<ProductionErc721Dvp>;
  let dvpErc721Pnh: DvpErc721PNH;

  before(async function () {
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    nftWrapper = new ERC721Wrapper<ProductionErc721Dvp>(privacyNodes.A, ProductionErc721Dvp__factory);
    nftWrapper.setFields('dvp721-extras');
    await nftWrapper.deploy();
    await nftWrapper.activateOnPn();
    await nftWrapper.activateOnHub(privateHub);

    const cached = privateHub.getPNHContract<DvpErc721PNH>(nftWrapper.symbol);
    const pnhTokenAddress = await cached.getAddress();
    dvpErc721Pnh = DvpErc721PNH__factory.connect(pnhTokenAddress, privateHub.adminWallet);

    LOGGER.log(`   PNH chainId             : ${(await privateHub.provider.getNetwork()).chainId}`);
    LOGGER.log(`   DvpErc721PNH address    : ${pnhTokenAddress}`);
  });

  it('clears nftExtraData on burn so re-mint does not inherit stale entries', async function () {
    const tokenId = 0xC1EA0n;
    const owner = privateHub.adminWallet.address;
    const seededExtra = { key: 'color', value: 'red', isPublic: true };

    // ── Mint with one extra-data entry ──
    await submitTx(
      () => dvpErc721Pnh.mint(owner, tokenId, 1, [seededExtra], { gasLimit: GAS_LIMIT }),
      `dvp721 burn-extras: mint seeded id=0x${tokenId.toString(16)}`,
    );

    const beforeBurn = await dvpErc721Pnh.getNftExtradaData(tokenId);
    expect(beforeBurn.length, 'pre-state: extras seeded').to.equal(1);
    expect(beforeBurn[0].value).to.equal('red');

    // ── Burn ──
    await submitTx(
      () => dvpErc721Pnh.burn(tokenId, { gasLimit: GAS_LIMIT }),
      `dvp721 burn-extras: burn id=0x${tokenId.toString(16)}`,
    );

    const afterBurn = await dvpErc721Pnh.getNftExtradaData(tokenId);
    LOGGER.log(`   nftExtraData after burn: length=${afterBurn.length}`);
    expect(afterBurn.length, 'extras must be cleared on burn').to.equal(0);

    // ── Re-mint with no extras; must observe a fresh empty array ──
    await submitTx(
      () => dvpErc721Pnh.mint(owner, tokenId, 1, [], { gasLimit: GAS_LIMIT }),
      `dvp721 burn-extras: re-mint clean id=0x${tokenId.toString(16)}`,
    );

    const afterRemint = await dvpErc721Pnh.getNftExtradaData(tokenId);
    expect(afterRemint.length, 're-mint must not inherit stale extras').to.equal(0);
  });
});
