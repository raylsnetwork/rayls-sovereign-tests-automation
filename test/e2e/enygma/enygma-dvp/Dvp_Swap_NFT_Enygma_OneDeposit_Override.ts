import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { ERC721Wrapper } from '../../../../src/entities/tokens/ERC721Wrapper';
import { DEFAULT_TIMEOUT } from '../../../../src/config/env-config';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
  Erc721DvpOverrideExample__factory,
   Erc721DvpOverrideExample,
} from '../../../../typechain-types';
import { generateRandomHash } from '../../../test-utils/helpers';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';

describe('E2E Tests: DvpSwap - One Deposit', function () {
  // Parameters for this scenario
  const CHANGE_AMOUNT = BigInt(10);
  const PAYMENT_AMOUNT = BigInt(100);
  const MINT_AMOUNT = PAYMENT_AMOUNT + CHANGE_AMOUNT;

  let enygmaToken: EnygmaWrapper<ProductionEnygmaToken>;
  let nft: ERC721Wrapper<Erc721DvpOverrideExample>;
  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  beforeEach(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const {initializedNodes,
      initializedPNH} = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    enygmaToken = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
    nft = new ERC721Wrapper(privacyNodes.B, Erc721DvpOverrideExample__factory);

    // Enygma is seeded → FACTORY-mode. The override NFT is the un-seeded holdout: it has no seeded
    // factory key, so it stays on the constructor deploy() + activateOnPn() + activateOnHub() path.
    await enygmaToken.deployViaFactory();
    await enygmaToken.activateOnPn();
    await enygmaToken.activateOnHub(privateHub);
    await nft.deploy();
    await nft.activateOnPn();
    await nft.activateOnHub(privateHub);
  });

  it('should perform NFT-EnygmaWrapper swap with single deposit using override NFT @smoke @dvp @swap', async function () {
    // Setup: Mint tokens
    const singerAddressPLA = await enygmaToken.userWallet.getAddress();
    const singerAddressPLB = await nft.userWallet.getAddress();

    await enygmaToken.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: singerAddressPLA });
    const tokenId = await nft.mintAndAwait(privateHub, { toAddress: singerAddressPLB });

    // Setup: Deposit tokens into Dvp (one deposit for all Enygmas + deposit NFT)
    await enygmaToken.depositEnygmaToDvp(MINT_AMOUNT, BigInt(0), privateHub);
    await nft.depositNftToDvp(privateHub, tokenId);

    // Test: Perform swap (helper includes verification of calldata executions and swap completion)
    const sharedId = generateRandomHash();
    const blockNumber = await privateHub.provider.getBlockNumber();
    await nft.swapForEnygma(privateHub, {
      nftId: tokenId, enygmaAmount: PAYMENT_AMOUNT, enygmaResourceId: enygmaToken.resourceId,
      enygmaPLChainId: privacyNodes.A.chainId, sharedId, validity: 0,
    });
    await enygmaToken.swapForERC721(privateHub, {
      nftId: tokenId, nftResourceId: nft.resourceId, enygmaAmount: PAYMENT_AMOUNT,
      nftPLChainId: privacyNodes.B.chainId, sharedId, validity: 0,
    });
    await privateHub.waitForSwapCompleted(sharedId, blockNumber);

    // Test: Withdraw swapped assets and verify via wrapper checks
    const nftOnA = await nft.forNode(privacyNodes.A, true, enygmaToken.userWallet);
    await nftOnA.withdrawNftFromDvp(privateHub, tokenId, singerAddressPLA);
    const enygmaOnB = await enygmaToken.forNode(privacyNodes.B, true, nft.userWallet);
    await enygmaOnB.withdrawEnygmaFromDvp(PAYMENT_AMOUNT, privateHub);
    await enygmaToken.withdrawEnygmaFromDvp(CHANGE_AMOUNT, privateHub);
  }).timeout(10 * 60 * 1000);
});
