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
  DvpTeleport,
} from '../../../../typechain-types';
import { ERC721Wrapper } from '../../../../src/entities/tokens/ERC721Wrapper';
import { ERC1155Wrapper } from '../../../../src/entities/tokens/ERC1155Wrapper';
import { generateRandomHash } from '../../../test-utils/helpers';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { eventually, submitTx } from '../../../../src/utils/common';
import { shortHex } from '../../../../src/utils/formatters';

describe(`E2E Tests: Swap Cancellation`, function () {

  const ERC1155_MINT_AMOUNT = 100n;
  const ERC1155_DEPOSIT_AMOUNT = 10n;
  const ERC1155_PAYMENT_AMOUNT = 10n;

  const ENYGMA_MINT_AMOUNT = 100n;
  const ENYGMA_DEPOSIT_AMOUNT = 10n;
  const ENYGMA_PAYMENT_AMOUNT = 10n;

  const NFT_ID = 1n;
  const SWAP_VALIDITY = 0;
  // Status 14 = SwapCancelled (set on receiver side)
  const SWAP_CANCELLED_STATUS = 14;
  const SWAP_TIMEDOUT_STATUS = 15;

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let dvpTeleport: DvpTeleport;

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
    dvpTeleport = privateHub.getContract<DvpTeleport>('DvpTeleport');

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

  it(`Should cancel ENYGMA -> ERC721 swap from Enygma side`, async function () {
    const sharedId = generateRandomHash();
    const blockNumber = await privateHub.provider.getBlockNumber();

    await submitTx(
      () => (enygma_erc721.contract as any).swapWithDvpForERC721(
        erc721TokenId, erc721.resourceId, ENYGMA_PAYMENT_AMOUNT, privacyNodes.B.chainId, sharedId, SWAP_VALIDITY
      ), 'swap-enygma-erc721'
    );

    await privateHub.waitForSwapInitialized(sharedId, blockNumber, PNCommunicatorA);

    await submitTx(() => enygma_erc721.contract.cancelERC721Swap(
      sharedId,
      privacyNodes.B.chainId,
      erc721TokenId,
      erc721.resourceId,
      ENYGMA_PAYMENT_AMOUNT
    ),"swap-enygma-erc721-cancel-enygma")

    await assertSwapCancelled(sharedId, dvpTeleport, blockNumber, PNCommunicatorA, PNCommunicatorB);

    const secondSwapSharedId = generateRandomHash();
    const secondBlockNumber = await privateHub.provider.getBlockNumber();

    await submitTx(
      () => (enygma_erc721.contract as any).swapWithDvpForERC721(
        erc721TokenId, erc721.resourceId, ENYGMA_PAYMENT_AMOUNT, privacyNodes.B.chainId, secondSwapSharedId, SWAP_VALIDITY
      ), 'second-swap-enygma-erc721'
    );

    await privateHub.waitForSwapInitialized(secondSwapSharedId, secondBlockNumber, PNCommunicatorA);

    await submitTx(() => enygma_erc721.contract.cancelERC721Swap(
      secondSwapSharedId,
      privacyNodes.B.chainId,
      erc721TokenId,
      erc721.resourceId,
      ENYGMA_PAYMENT_AMOUNT
    ),"second-swap-enygma-erc721-cancel-enygma")

    await assertSwapCancelled(secondSwapSharedId, dvpTeleport, secondBlockNumber, PNCommunicatorA, PNCommunicatorB);

  }).timeout(DEFAULT_TIMEOUT);

  it(`Should cancel ENYGMA -> ERC721 swap from ERC721 side`, async function () {
    const sharedId = generateRandomHash();
    const blockNumber = await privateHub.provider.getBlockNumber();

    await submitTx(
      () => (enygma_erc721.contract as any).swapWithDvpForERC721(
        erc721TokenId, erc721.resourceId, ENYGMA_PAYMENT_AMOUNT, privacyNodes.B.chainId, sharedId, SWAP_VALIDITY
      ), 'swap-enygma-erc721'
    );

    await privateHub.waitForSwapInitialized(sharedId, blockNumber, PNCommunicatorA);

    await submitTx(() => erc721.contract.cancelSwap(
      sharedId,
      privacyNodes.A.chainId,
      erc721TokenId,
      ENYGMA_PAYMENT_AMOUNT,
      enygma_erc721.resourceId
    ),"swap-enygma-erc721-cancel-erc721")

    await assertSwapCancelled(sharedId, dvpTeleport, blockNumber, PNCommunicatorB, PNCommunicatorA);
  }).timeout(DEFAULT_TIMEOUT);

  it(`Should cancel ERC721 -> ENYGMA swap from ERC721 side`, async function () {
    const sharedId = generateRandomHash();
    const blockNumber = await privateHub.provider.getBlockNumber();

    await erc721.swapForEnygma(privateHub, {
      nftId: erc721TokenId, enygmaAmount: ENYGMA_PAYMENT_AMOUNT, enygmaResourceId: enygma_erc721.resourceId,
      enygmaPLChainId: privacyNodes.A.chainId, sharedId, validity: 0,
    })

    await privateHub.waitForSwapInitialized(sharedId, blockNumber);

    await submitTx(() => erc721.contract.cancelSwap(
      sharedId,
      privacyNodes.A.chainId,
      erc721TokenId,
      ENYGMA_PAYMENT_AMOUNT,
      enygma_erc721.resourceId
    ),"erc721-cancel-swap")

    await assertSwapCancelled(sharedId, dvpTeleport, blockNumber, PNCommunicatorB, PNCommunicatorA);
  }).timeout(DEFAULT_TIMEOUT);

  it(`Should cancel ERC721 -> ENYGMA swap from ENYGMA side`, async function () {
    const sharedId = generateRandomHash();
    const blockNumber = await privateHub.provider.getBlockNumber();

    await erc721.swapForEnygma(privateHub, {
      nftId: erc721TokenId, enygmaAmount: ENYGMA_PAYMENT_AMOUNT, enygmaResourceId: enygma_erc721.resourceId,
      enygmaPLChainId: privacyNodes.A.chainId, sharedId, validity: 0,
    })

    await privateHub.waitForSwapInitialized(sharedId, blockNumber);

    await submitTx(() => enygma_erc721.contract.cancelERC721Swap(
      sharedId,
      privacyNodes.B.chainId,
      erc721TokenId,
      erc721.resourceId,
      ENYGMA_PAYMENT_AMOUNT
    ),"swap-erc721-enygma-cancel-erc721")

    await assertSwapCancelled(sharedId, dvpTeleport, blockNumber, PNCommunicatorA, PNCommunicatorB);
  }).timeout(DEFAULT_TIMEOUT);

  it(`Should cancel ENYGMA -> ERC1155 swap from Enygma side`, async function () {
    const sharedId = generateRandomHash();
    const blockNumber = await privateHub.provider.getBlockNumber();

    await enygma_erc1155.swapForERC1155(privateHub, {
      nftId: NFT_ID, nftAmount: ERC1155_PAYMENT_AMOUNT, nftResourceId: erc1155.resourceId,
      enygmaAmount: ENYGMA_PAYMENT_AMOUNT, nftPLChainId: privacyNodes.B.chainId, sharedId,
      validity: 0,
    })

    await privateHub.waitForSwapInitialized(sharedId, blockNumber);

    await submitTx(() => enygma_erc1155.contract.cancelERC1155Swap(
      sharedId,
      privacyNodes.B.chainId,
      NFT_ID,
      ERC1155_PAYMENT_AMOUNT,
      erc1155.resourceId,
      ENYGMA_PAYMENT_AMOUNT
    ),"enygma-cancel-erc1155-swap")

    await assertSwapCancelled(sharedId, dvpTeleport, blockNumber, PNCommunicatorA2, PNCommunicatorB2);
  }).timeout(DEFAULT_TIMEOUT);

  it(`Should cancel ENYGMA -> ERC1155 swap from ERC1155 side`, async function () {
    const sharedId = generateRandomHash();
    const blockNumber = await privateHub.provider.getBlockNumber();

    await enygma_erc1155.swapForERC1155(privateHub, {
      nftId: NFT_ID, nftAmount: ERC1155_PAYMENT_AMOUNT, nftResourceId: erc1155.resourceId,
      enygmaAmount: ENYGMA_PAYMENT_AMOUNT, nftPLChainId: privacyNodes.B.chainId, sharedId,
      validity: 0,
    })

    await privateHub.waitForSwapInitialized(sharedId, blockNumber);

    await submitTx(() => erc1155.contract.cancelSwap(
      sharedId,
      privacyNodes.A.chainId,
      NFT_ID,
      ERC1155_PAYMENT_AMOUNT,
      enygma_erc1155.resourceId,
      ENYGMA_PAYMENT_AMOUNT
    ),"swap-enygma-erc1155-cancel-erc1155")

    await assertSwapCancelled(sharedId, dvpTeleport, blockNumber, PNCommunicatorB2, PNCommunicatorA2);
  }).timeout(DEFAULT_TIMEOUT);

  it(`Should cancel ERC1155 -> ENYGMA swap from ERC1155 side`, async function () {
    const sharedId = generateRandomHash();
    const blockNumber = await privateHub.provider.getBlockNumber();

    await erc1155.swapForEnygma(privateHub, {
      nftId: NFT_ID, nftAmount: ERC1155_PAYMENT_AMOUNT, data: '0x', enygmaAmount: ENYGMA_PAYMENT_AMOUNT,
      enygmaResourceId: enygma_erc1155.resourceId, enygmaPLChainId: privacyNodes.A.chainId, sharedId,
      validity: 0,
    })

    await privateHub.waitForSwapInitialized(sharedId, blockNumber);

    await submitTx(() => erc1155.contract.cancelSwap(
      sharedId,
      privacyNodes.A.chainId,
      NFT_ID,
      ERC1155_PAYMENT_AMOUNT,
      enygma_erc1155.resourceId,
      ENYGMA_PAYMENT_AMOUNT
    ),"swap-erc1155-enygma-cancel-erc1155")

    await assertSwapCancelled(sharedId, dvpTeleport, blockNumber, PNCommunicatorB2, PNCommunicatorA2);
  }).timeout(DEFAULT_TIMEOUT);

  it(`Should cancel ERC1155 -> ENYGMA swap from ENYGMA side`, async function () {
    const sharedId = generateRandomHash();
    const blockNumber = await privateHub.provider.getBlockNumber();

    await erc1155.swapForEnygma(privateHub, {
      nftId: NFT_ID, nftAmount: ERC1155_PAYMENT_AMOUNT, data: '0x', enygmaAmount: ENYGMA_PAYMENT_AMOUNT,
      enygmaResourceId: enygma_erc1155.resourceId, enygmaPLChainId: privacyNodes.A.chainId, sharedId,
      validity: 0,
    })

    await privateHub.waitForSwapInitialized(sharedId, blockNumber);

    await submitTx(() => enygma_erc1155.contract.cancelERC1155Swap(
      sharedId,
      privacyNodes.B.chainId,
      NFT_ID,
      ERC1155_PAYMENT_AMOUNT,
      erc1155.resourceId,
      ENYGMA_PAYMENT_AMOUNT
    ),"swap-erc1155-enygma-cancel-enygma")

    await assertSwapCancelled(sharedId, dvpTeleport, blockNumber, PNCommunicatorA2, PNCommunicatorB2);
  }).timeout(DEFAULT_TIMEOUT);

  async function assertSwapCancelled(
    sharedId: string,
    dvpTeleport: DvpTeleport,
    fromBlockNumber: number,
    senderPNCommunicator: PNCommunicatorV1,
    receiverPNCommunicator: PNCommunicatorV1
  ) {
    await eventually<boolean>({
      check: async () => {
        const toBlockNumber = await privateHub.provider.getBlockNumber();
        const swapCancelledFilter = dvpTeleport.filters.SwapCancelled(sharedId);
        const logs = await dvpTeleport.queryFilter(
          swapCancelledFilter,
          fromBlockNumber,
          toBlockNumber
        );
        return logs.length > 0;
      },
      interval: 1000,
      attempts: 30,
      message: `Waiting for DvpTeleport SwapCancelled event on PNH (sharedId=${shortHex(sharedId)})`,
    }),
    `Checking teleport state...`;

    // Check sender PNCommunicator - SwapCancelled (14)
    await eventually<boolean>({
      check: async () => {
        const sharedInfoOnA = await senderPNCommunicator.getAllSharedInfo(sharedId);
        if (sharedInfoOnA[1].length === 0) {
          return false;
        }
        const history = sharedInfoOnA[1][sharedInfoOnA[1].length - 1];
        return history.status === BigInt(SWAP_CANCELLED_STATUS);
      },
      interval: 1000,
      attempts: 30,
      message: `Waiting for sender PNCommunicator → SwapCancelled (sharedId=${shortHex(sharedId)}, status=${SWAP_CANCELLED_STATUS})`,
    }),
    `Checking sender PNCommunicator status...`;

    // Check receiver PNCommunicator - SwapCancelled (14)
    await eventually<boolean>({
      check: async () => {
        const sharedInfoOnB = await receiverPNCommunicator.getAllSharedInfo(sharedId);
        if (sharedInfoOnB[1].length === 0) {
          return false;
        }
        const history = sharedInfoOnB[1][sharedInfoOnB[1].length - 1];
        return history.status === BigInt(SWAP_CANCELLED_STATUS);
      },
      interval: 1000,
      attempts: 30,
      message: `Waiting for receiver PNCommunicator → SwapCancelled (sharedId=${shortHex(sharedId)}, status=${SWAP_CANCELLED_STATUS})`,
    }),
    `Checking receiver PNCommunicator status...`;
  }
});
