import { DEFAULT_TIMEOUT } from '../../../../src/config/env-config';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
  ProductionErc1155Dvp,
  ProductionErc1155Dvp__factory,
  ProductionErc721Dvp,
  ProductionErc721Dvp__factory,
  PNCommunicatorV1,
} from '../../../../typechain-types';
import { ERC721Wrapper } from '../../../../src/entities/tokens/ERC721Wrapper';
import { ERC1155Wrapper } from '../../../../src/entities/tokens/ERC1155Wrapper';
import { generateRandomHash } from '../../../test-utils/helpers';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { eventually, submitTx } from '../../../../src/utils/common';
import { shortHex } from '../../../../src/utils/formatters';

describe(`E2E Tests: Swap Disagreement`, function () {

  const ERC1155_MINT_AMOUNT = 100n;
  const ERC1155_DEPOSIT_AMOUNT = 10n;
  const ERC1155_PAYMENT_AMOUNT = 10n;

  const ENYGMA_MINT_AMOUNT = 100n;
  const ENYGMA_DEPOSIT_AMOUNT = 10n;
  const ENYGMA_PAYMENT_AMOUNT = 10n;

  const NFT_ID = 1n;
  const SWAP_VALIDITY = 0;
  const SWAP_ERROR_STATUS = 12;

  let privacyNodes: PrivacyNodeMap;
  let privateHub :PrivateHub;

  let enygma_erc721 : EnygmaWrapper<ProductionEnygmaToken>;
  let erc721 : ERC721Wrapper<ProductionErc721Dvp>;
  let erc721TokenId: bigint;
  let enygma_erc1155 : EnygmaWrapper<ProductionEnygmaToken>;
  let erc1155 : ERC1155Wrapper<ProductionErc1155Dvp>;

  let PNCommunicatorA: PNCommunicatorV1;
  let PNCommunicatorB: PNCommunicatorV1;
  let PNCommunicatorA2: PNCommunicatorV1;
  let PNCommunicatorB2: PNCommunicatorV1;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT * 2);
    const {initializedNodes, initializedPNH} = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    enygma_erc721 = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
    enygma_erc1155 = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
    erc721 = new ERC721Wrapper(privacyNodes.B, ProductionErc721Dvp__factory);
    erc1155 = new ERC1155Wrapper(privacyNodes.B, ProductionErc1155Dvp__factory);
    await enygma_erc721.deployViaFactory();
    await enygma_erc721.activateOnPn();
    await enygma_erc721.activateOnHub(privateHub);
    await enygma_erc1155.deployViaFactory();
    await enygma_erc1155.activateOnPn();
    await enygma_erc1155.activateOnHub(privateHub);
    await erc721.deploy();
    await erc721.activateOnPn();
    await erc721.activateOnHub(privateHub);
    await erc1155.deploy();
    await erc1155.activateOnPn();
    await erc1155.activateOnHub(privateHub);

    PNCommunicatorA = await privacyNodes.A.getPnCommunicatorForToken(enygma_erc721.symbol);
    PNCommunicatorB = await privacyNodes.B.getPnCommunicatorForToken(erc721.symbol);
    PNCommunicatorA2 = await privacyNodes.A.getPnCommunicatorForToken(enygma_erc1155.symbol);
    PNCommunicatorB2 = await privacyNodes.B.getPnCommunicatorForToken(erc1155.symbol);

    await enygma_erc721.mintAndAwait(privateHub, { amount: ENYGMA_MINT_AMOUNT, toAddress: enygma_erc721.userWallet.address });
    await enygma_erc1155.mintAndAwait(privateHub, { amount: ENYGMA_MINT_AMOUNT, toAddress: enygma_erc1155.userWallet.address });

    erc721TokenId = await erc721.mintAndAwait(privateHub, { toAddress: erc721.userWallet.address })
    await erc1155.mintAndAwait(privateHub,{toAddress:erc1155.userWallet.address, tokenId:NFT_ID,amount:ERC1155_MINT_AMOUNT})
  });

  it(`Should deposit ${ENYGMA_DEPOSIT_AMOUNT} enygmas(ERC721) to Dvp`, async function () {
    await enygma_erc721.depositEnygmaToDvp(
      ENYGMA_DEPOSIT_AMOUNT,
      ENYGMA_MINT_AMOUNT - ENYGMA_DEPOSIT_AMOUNT,
      privateHub,
    )
  }).timeout(DEFAULT_TIMEOUT);

  it(`Should deposit ${ENYGMA_DEPOSIT_AMOUNT} enygmas(ERC1155) to Dvp`, async function () {
    await enygma_erc1155.depositEnygmaToDvp(
      ENYGMA_DEPOSIT_AMOUNT,
      ENYGMA_MINT_AMOUNT - ENYGMA_DEPOSIT_AMOUNT,
      privateHub,
    )
    }).timeout(DEFAULT_TIMEOUT);

  it(`Should deposit ERC721 token to Dvp`, async function () {
    await erc721.depositNftToDvp(privateHub,erc721TokenId);
  }).timeout(DEFAULT_TIMEOUT);

  it(`Should deposit ${ERC1155_DEPOSIT_AMOUNT} ERC1155 tokens to Dvp`, async function () {
    await erc1155.depositNftToDvp(privateHub,NFT_ID, ERC1155_DEPOSIT_AMOUNT);
  }).timeout(DEFAULT_TIMEOUT);

  it(`Should trigger swap error ENYGMA -> ERC721 due to mismatched enygma value on Enygma side`, async function () {
    const sharedId = generateRandomHash();
    const blockNumber = await privateHub.provider.getBlockNumber();

    await submitTx(() => enygma_erc721.contract.swapWithDvpForERC721(
       erc721TokenId,
        erc721.resourceId,
        ENYGMA_PAYMENT_AMOUNT,
        privacyNodes.B.chainId,
        sharedId,
        SWAP_VALIDITY
    ),"erc721-swap-with-dvp-for-erc721")

    await privateHub.waitForSwapInitialized(sharedId, blockNumber, PNCommunicatorA);

    await submitTx(() => erc721.contract.swapWithDvpForEnygma(
      erc721TokenId,
      BigInt(ENYGMA_PAYMENT_AMOUNT)-BigInt(1n),
      enygma_erc721.resourceId,
      privacyNodes.A.chainId,
      sharedId,
      SWAP_VALIDITY
    ),"erc721-swap-with-dvp-for-enygma")

    await assertSwapError(sharedId, PNCommunicatorB);
  }).timeout(DEFAULT_TIMEOUT);

  it(`Should trigger swap error ENYGMA -> ERC721 due to mismatched enygma value on ERC721 side`, async function () {
    const sharedId = generateRandomHash();
    const blockNumber = await privateHub.provider.getBlockNumber();

    await submitTx(() => erc721.contract.swapWithDvpForEnygma(
        erc721TokenId,
        ENYGMA_PAYMENT_AMOUNT,
       enygma_erc721.resourceId,
       privacyNodes.A.chainId,
      sharedId,
      SWAP_VALIDITY
    ),"erc721-swap-with-dvp-for-enygma")

    await privateHub.waitForSwapInitialized(sharedId, blockNumber, PNCommunicatorB);

    await submitTx(() => enygma_erc721.contract.swapWithDvpForERC721(
      erc721TokenId,
      erc721.resourceId,
      BigInt(ENYGMA_PAYMENT_AMOUNT)-BigInt(1n),
      privacyNodes.B.chainId,
      sharedId,
      SWAP_VALIDITY
    ),"erc721-swap-with-dvp-for-erc721")

    await assertSwapError(sharedId, PNCommunicatorA);
  }).timeout(DEFAULT_TIMEOUT);

  it(`Should trigger swap error ENYGMA -> ERC1155 due to mismatched enygma value on Enygma side`, async function () {
    const sharedId = generateRandomHash();
    const blockNumber = await privateHub.provider.getBlockNumber();

    await submitTx(() => erc1155.contract.swapWithDvpForEnygma(
      NFT_ID,
      ERC1155_PAYMENT_AMOUNT,
      "0x",
      ENYGMA_PAYMENT_AMOUNT,
      enygma_erc1155.resourceId,
      privacyNodes.A.chainId,
      sharedId,
      SWAP_VALIDITY
    ),"erc1155-swap-with-dvp-for-enygma")

    await privateHub.waitForSwapInitialized(sharedId, blockNumber, PNCommunicatorB2);

    await submitTx(() => enygma_erc1155.contract.swapWithDvpForERC1155(
        NFT_ID,
      ERC1155_PAYMENT_AMOUNT,
        erc1155.resourceId,
      BigInt(ENYGMA_PAYMENT_AMOUNT)-BigInt(1n),
        privacyNodes.B.chainId,
        sharedId,
        SWAP_VALIDITY
    ),"erc1155-swap-with-dvp-for-erc1155")

    await assertSwapError(sharedId, PNCommunicatorA2);
  }).timeout(DEFAULT_TIMEOUT);

  it(`Should trigger swap error ENYGMA -> ERC1155 due to mismatched enygma value on ERC1155 side`, async function () {
    const sharedId = generateRandomHash();
    const blockNumber = await privateHub.provider.getBlockNumber();

    await submitTx(
      () => enygma_erc1155.contract.swapWithDvpForERC1155(
      NFT_ID,
      ERC1155_PAYMENT_AMOUNT,
      erc1155.resourceId,
      ENYGMA_PAYMENT_AMOUNT,
      privacyNodes.B.chainId,
      sharedId,
      SWAP_VALIDITY
    ),"erc1155-swap-with-dvp-for-erc1155")

    await privateHub.waitForSwapInitialized(sharedId, blockNumber, PNCommunicatorA2);

    await submitTx(
      () => erc1155.contract.swapWithDvpForEnygma(
      NFT_ID,
      ERC1155_PAYMENT_AMOUNT,
      "0x",
      BigInt(ENYGMA_PAYMENT_AMOUNT)-BigInt(1n),
      enygma_erc1155.resourceId,
      privacyNodes.A.chainId,
      sharedId,
      SWAP_VALIDITY
    ),"erc1155-swap-with-dvp-for-enygma")

    await assertSwapError(sharedId, PNCommunicatorB2);
  }).timeout(DEFAULT_TIMEOUT);

  async function assertSwapError(sharedId: string, PNCommunicator: PNCommunicatorV1) {
     await eventually<boolean>({
       check: async () => {
         const sharedInfoOnA = await PNCommunicator.getAllSharedInfo(sharedId);
         if (sharedInfoOnA[1].length === 0) {
           return false;
         }
         const lastHistory = sharedInfoOnA[1][sharedInfoOnA[1].length - 1];
         return lastHistory.status === BigInt(SWAP_ERROR_STATUS);
       },
       interval: 5000,
       attempts: 10,
       message: `Waiting for PNCommunicator history → SwapError (sharedId=${shortHex(sharedId)}, status=${SWAP_ERROR_STATUS})`,
     });
    }
});

