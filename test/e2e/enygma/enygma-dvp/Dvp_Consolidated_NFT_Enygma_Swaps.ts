import { generateRandomHash } from '../../../test-utils/helpers';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { DEFAULT_TIMEOUT } from '../../../../src/config/env-config';
import {
  shouldCrossTransferEnygma,
} from '../../../../src/flows/tokens/token-flows';
import { ERC721Wrapper } from '../../../../src/entities/tokens/ERC721Wrapper';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory, ProductionErc1155Dvp, ProductionErc1155Dvp__factory,
  ProductionErc721Dvp,
  ProductionErc721Dvp__factory,
} from '../../../../typechain-types';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { ERC1155Wrapper } from '../../../../src/entities/tokens/ERC1155Wrapper';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { EnygmaCrossTransfer } from '../../../../src/types';

describe('Dvp Consolidated NFT-EnygmaWrapper Swaps', function () {
  // DvP tests have irreversible on-chain side effects (deposits, swaps, proofs).
  // Retries corrupt relayer DB state (balance commitment mismatch). Disable retries.
  this.retries(0);

  describe('Dvp NFT-EnygmaWrapper Swaps', function () {
  // Privacy Ledger setup
  let privacyNodes: PrivacyNodeMap;
  let privateHub : PrivateHub;

  let enygmaToken: EnygmaWrapper<ProductionEnygmaToken>;
  let nft: ERC721Wrapper<ProductionErc721Dvp>;
  let singerAddressA = "";
  let singerAddressB= "";

    beforeEach(async function () {
    this.timeout(DEFAULT_TIMEOUT);
      const {initializedNodes,
        initializedPNH} = await initializePrivacyNodesAndPnh(2);
      privacyNodes = initializedNodes;
      privateHub = initializedPNH;
    // FACTORY-mode production Enygma: the seeded-template codehash matches the programmability gate,
    // so the cross-transfer settlement mint (crossMintStandard) clears it. A constructor-deployed
    // ProductionEnygmaToken has a non-seeded codehash and its B→A settlement is gate-rejected.
    enygmaToken = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
    nft = new ERC721Wrapper(privacyNodes.B, ProductionErc721Dvp__factory);
    singerAddressA = await enygmaToken.userWallet.getAddress();
    singerAddressB = await nft.userWallet.getAddress();
    await enygmaToken.deployViaFactory();
    await enygmaToken.activateOnPn();
    await enygmaToken.activateOnHub(privateHub);
    await nft.deploy();
    await nft.activateOnPn();
    await nft.activateOnHub(privateHub);
  });

  // @smoke single-deposit swap moved to Dvp_Swap_NFT_Enygma_Smoke.ts for parallel execution.

  it('should perform NFT-EnygmaWrapper swap with ten deposits @regression @dvp @swap', async function () {
    const DEPOSIT_AMOUNT = BigInt(100);
    const AMOUNT_OF_DEPOSITS = BigInt(10);
    const CHANGE_AMOUNT = BigInt(0);
    const MINT_AMOUNT = DEPOSIT_AMOUNT * AMOUNT_OF_DEPOSITS + CHANGE_AMOUNT;
    const PAYMENT_AMOUNT = MINT_AMOUNT - CHANGE_AMOUNT;

    // Setup: Mint tokens
    await enygmaToken.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: singerAddressA });
    const tokenId = await nft.mintAndAwait(privateHub, { toAddress: singerAddressB });

    // Setup: Deposit tokens into Dvp
    await enygmaToken.depositEnygmaToDvp(MINT_AMOUNT, BigInt(0), privateHub);
    await nft.depositNftToDvp(privateHub, tokenId);

    // Test: Perform swap
    const sharedId = generateRandomHash();
    const swapBlockNumber = await privateHub.provider.getBlockNumber();
    await nft.swapForEnygma(privateHub, {
      nftId: tokenId, enygmaAmount: PAYMENT_AMOUNT, enygmaResourceId: enygmaToken.resourceId,
      enygmaPLChainId: privacyNodes.A.chainId, sharedId, validity: 0,
    });
    await enygmaToken.swapForERC721(privateHub, {
      nftId: tokenId, nftResourceId: nft.resourceId, enygmaAmount: PAYMENT_AMOUNT,
      nftPLChainId: privacyNodes.B.chainId, sharedId, validity: 0,
    });
    await privateHub.waitForSwapCompleted(sharedId, swapBlockNumber);

    // Test: Withdraw swapped assets
    const nftOnA = await nft.forNode(privacyNodes.A, true, enygmaToken.userWallet);
    await nftOnA.withdrawNftFromDvp(privateHub, tokenId, singerAddressA);
    const enygmaOnB = await enygmaToken.forNode(privacyNodes.B, true, nft.userWallet);
    await enygmaOnB.withdrawEnygmaFromDvp(PAYMENT_AMOUNT, privateHub);
  }).timeout(DEFAULT_TIMEOUT);

  it('should perform NFT-EnygmaWrapper swap with eleven deposits (consolidation behavior) @regression @dvp @swap @consolidation', async function () {
    const MINT_AMOUNT = BigInt(110);
    const DEPOSIT_AMOUNT = BigInt(10);
    const AMOUNT_OF_DEPOSITS = BigInt(11);
    const PAYMENT_AMOUNT = DEPOSIT_AMOUNT * AMOUNT_OF_DEPOSITS;

    // Setup: Mint tokens
    await enygmaToken.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: singerAddressA });
    const tokenId = await nft.mintAndAwait(privateHub, { toAddress: singerAddressB });

    const blockNumber = await privateHub.provider.getBlockNumber();
    // Setup: Perform multiple deposits to trigger consolidation
    let totalDeposited = BigInt(0);
    for (let depositNumber = 1; depositNumber <= AMOUNT_OF_DEPOSITS; depositNumber++) {
      totalDeposited += DEPOSIT_AMOUNT;
      await enygmaToken.depositEnygmaToDvp(
        DEPOSIT_AMOUNT,
        MINT_AMOUNT - totalDeposited,
        privateHub,
      );
    }

    await enygmaToken.waitForDepositsToComplete(Number(AMOUNT_OF_DEPOSITS), privateHub, blockNumber);
    await nft.depositNftToDvp(privateHub, tokenId);

    // Test: Perform swap
    const sharedId = generateRandomHash();
    const swapBlockNumber = await privateHub.provider.getBlockNumber();
    await nft.swapForEnygma(privateHub, {
      nftId: tokenId, enygmaAmount: PAYMENT_AMOUNT, enygmaResourceId: enygmaToken.resourceId,
      enygmaPLChainId: privacyNodes.A.chainId, sharedId, validity: 0,
    });
    await enygmaToken.swapForERC721(privateHub, {
      nftId: tokenId, nftResourceId: nft.resourceId, enygmaAmount: PAYMENT_AMOUNT,
      nftPLChainId: privacyNodes.B.chainId, sharedId, validity: 0,
    });
    await privateHub.waitForSwapCompleted(sharedId, swapBlockNumber);

    // Test: Withdraw swapped assetss
    const nftOnA = await nft.forNode(privacyNodes.A, true, enygmaToken.userWallet);
    await nftOnA.withdrawNftFromDvp(privateHub, tokenId, singerAddressA);
    const enygmaOnB = await enygmaToken.forNode(privacyNodes.B, true, nft.userWallet);
    await enygmaOnB.withdrawEnygmaFromDvp(PAYMENT_AMOUNT, privateHub);
  }).timeout(8 * 60 * 1000); // Increased timeout for consolidation test

  it('should handle variable deposit amounts @regression @dvp @swap', async function () {
    const MINT_AMOUNT = BigInt(300);
    const DEPOSIT_AMOUNTS = [BigInt(50), BigInt(100), BigInt(150)]; // Variable deposit amounts
    const TOTAL_DEPOSIT_AMOUNT =  BigInt(50) + BigInt(100) + BigInt(150);

    // Setup: Mint tokens
    await enygmaToken.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: singerAddressA });
    const tokenId = await nft.mintAndAwait(privateHub, { toAddress: singerAddressB });
    const blockNumber = await privateHub.provider.getBlockNumber();
    // Setup: Perform variable deposits
    let cumulativeDeposited = BigInt(0);
    for (let i = 0; i < DEPOSIT_AMOUNTS.length; i++) {
      const depositAmount = DEPOSIT_AMOUNTS[i];
      cumulativeDeposited += depositAmount;
      await enygmaToken.depositEnygmaToDvp(
        depositAmount,
        MINT_AMOUNT - cumulativeDeposited,
        privateHub,
      );
    }

    await enygmaToken.waitForDepositsToComplete(DEPOSIT_AMOUNTS.length, privateHub, blockNumber);
    await nft.depositNftToDvp(privateHub, tokenId);

    // Test: Perform swap for partial amount
    const SWAP_AMOUNT = BigInt(250); // Partial swap amount
    const CHANGE_AMOUNT = TOTAL_DEPOSIT_AMOUNT - SWAP_AMOUNT;

    const sharedId = generateRandomHash();
    const swapBlockNumber = await privateHub.provider.getBlockNumber();
    await nft.swapForEnygma(privateHub, {
      nftId: tokenId, enygmaAmount: SWAP_AMOUNT, enygmaResourceId: enygmaToken.resourceId,
      enygmaPLChainId: privacyNodes.A.chainId, sharedId, validity: 0,
    });
    await enygmaToken.swapForERC721(privateHub, {
      nftId: tokenId, nftResourceId: nft.resourceId, enygmaAmount: SWAP_AMOUNT,
      nftPLChainId: privacyNodes.B.chainId, sharedId, validity: 0,
    });
    await privateHub.waitForSwapCompleted(sharedId, swapBlockNumber);

    // Test: Withdraw swapped assets and remaining change
    const nftOnA = await nft.forNode(privacyNodes.A, true, enygmaToken.userWallet);
    await nftOnA.withdrawNftFromDvp(privateHub, tokenId, singerAddressA);
    const enygmaOnB = await enygmaToken.forNode(privacyNodes.B, true, nft.userWallet);
    await enygmaOnB.withdrawEnygmaFromDvp(SWAP_AMOUNT, privateHub);
    await enygmaToken.withdrawEnygmaFromDvp(CHANGE_AMOUNT, privateHub);

  }).timeout(DEFAULT_TIMEOUT);

  it('should handle heavy consolidation with 22+ deposits @regression @dvp @swap @consolidation', async function () {
    const MINT_AMOUNT = BigInt(220);
    const DEPOSIT_AMOUNT = BigInt(10);
    const AMOUNT_OF_DEPOSITS = BigInt(22);
    const PAYMENT_AMOUNT = DEPOSIT_AMOUNT * AMOUNT_OF_DEPOSITS;

    // Setup: Mint tokens
    await enygmaToken.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: singerAddressA });
    const tokenId = await nft.mintAndAwait(privateHub, { toAddress: singerAddressB });

    const blockNumber = await privateHub.provider.getBlockNumber();
    // Setup: Perform many deposits to trigger heavy consolidation
    let totalDeposited = BigInt(0);
    for (let depositNumber = 1; depositNumber <= AMOUNT_OF_DEPOSITS; depositNumber++) {
      totalDeposited += DEPOSIT_AMOUNT;
      await enygmaToken.depositEnygmaToDvp(
        DEPOSIT_AMOUNT,
        MINT_AMOUNT - totalDeposited,
        privateHub,
      );
    }

    await enygmaToken.waitForDepositsToComplete(Number(AMOUNT_OF_DEPOSITS), privateHub, blockNumber);
    await nft.depositNftToDvp(privateHub, tokenId);

    // Test: Perform swap
    const sharedId = generateRandomHash();
    const swapBlockNumber = await privateHub.provider.getBlockNumber();
    await nft.swapForEnygma(privateHub, {
      nftId: tokenId, enygmaAmount: PAYMENT_AMOUNT, enygmaResourceId: enygmaToken.resourceId,
      enygmaPLChainId: privacyNodes.A.chainId, sharedId, validity: 0,
    });
    await enygmaToken.swapForERC721(privateHub, {
      nftId: tokenId, nftResourceId: nft.resourceId, enygmaAmount: PAYMENT_AMOUNT,
      nftPLChainId: privacyNodes.B.chainId, sharedId, validity: 0,
    });
    await privateHub.waitForSwapCompleted(sharedId, swapBlockNumber);

    // Test: Withdraw swapped assets
    const nftOnA = await nft.forNode(privacyNodes.A, true, enygmaToken.userWallet);
    await nftOnA.withdrawNftFromDvp(privateHub, tokenId, singerAddressA);
    const enygmaOnB = await enygmaToken.forNode(privacyNodes.B, true, nft.userWallet);
    await enygmaOnB.withdrawEnygmaFromDvp(PAYMENT_AMOUNT, privateHub);
  }).timeout(12 * 60 * 1000); // Increased timeout for heavy consolidation

  // Test for reverse swap direction - the swap is initiated from EnygmaWrapper side to NFT side
  it('should perform EnygmaWrapper-NFT swap with eleven deposits (reverse direction consolidation) @regression @dvp @swap @consolidation', async function () {
    const MINT_AMOUNT = BigInt(110);
    const DEPOSIT_AMOUNT = BigInt(10);
    const AMOUNT_OF_DEPOSITS = BigInt(11);
    const PAYMENT_AMOUNT = DEPOSIT_AMOUNT * AMOUNT_OF_DEPOSITS;

    // Setup: Mint tokens
    await enygmaToken.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: singerAddressA });
    const tokenId = await nft.mintAndAwait(privateHub, { toAddress: singerAddressB });

    const blockNumber = await privateHub.provider.getBlockNumber();
    // Setup: Perform multiple deposits to trigger consolidation
    let totalDeposited = BigInt(0);
    for (let depositNumber = 1; depositNumber <= AMOUNT_OF_DEPOSITS; depositNumber++) {
      totalDeposited += DEPOSIT_AMOUNT;
      await enygmaToken.depositEnygmaToDvp(
        DEPOSIT_AMOUNT,
        MINT_AMOUNT - totalDeposited,
        privateHub,
      );
    }

    await enygmaToken.waitForDepositsToComplete(Number(AMOUNT_OF_DEPOSITS), privateHub, blockNumber);
    await nft.depositNftToDvp(privateHub, tokenId);

    // Test: Perform swap (reverse direction - EnygmaWrapper side initiates)
    const sharedId = generateRandomHash();
    const swapBlockNumber = await privateHub.provider.getBlockNumber();
    await nft.swapForEnygma(privateHub, {
      nftId: tokenId, enygmaAmount: PAYMENT_AMOUNT, enygmaResourceId: enygmaToken.resourceId,
      enygmaPLChainId: privacyNodes.A.chainId, sharedId, validity: 0,
    });
    await enygmaToken.swapForERC721(privateHub, {
      nftId: tokenId, nftResourceId: nft.resourceId, enygmaAmount: PAYMENT_AMOUNT,
      nftPLChainId: privacyNodes.B.chainId, sharedId, validity: 0,
    });
    await privateHub.waitForSwapCompleted(sharedId, swapBlockNumber);

    // Test: Withdraw swapped assets
    const nftOnA = await nft.forNode(privacyNodes.A, true, enygmaToken.userWallet);
    await nftOnA.withdrawNftFromDvp(privateHub, tokenId, singerAddressA);
    const enygmaOnB = await enygmaToken.forNode(privacyNodes.B, true, nft.userWallet);
    await enygmaOnB.withdrawEnygmaFromDvp(PAYMENT_AMOUNT, privateHub);
  }).timeout(10 * 60 * 1000); // Increased timeout for consolidation test

it('should perform NFT-EnygmaWrapper swap with zero-value deposits @regression @dvp @swap', async function () {
    const DEPOSIT_AMOUNT = BigInt(0);
    const AMOUNT_OF_DEPOSITS = BigInt(1);
    const CHANGE_AMOUNT = BigInt(0);
    const MINT_AMOUNT = DEPOSIT_AMOUNT * AMOUNT_OF_DEPOSITS + CHANGE_AMOUNT;
    const PAYMENT_AMOUNT = MINT_AMOUNT - CHANGE_AMOUNT;

    // Setup: Mint tokens (zero amount for enygma, but still mint NFT)
    const tokenId = await nft.mintAndAwait(privateHub, { toAddress: singerAddressB });

    // Setup: Deposit tokens into Dvp
    await enygmaToken.depositEnygmaToDvp(MINT_AMOUNT, BigInt(0), privateHub);
    await nft.depositNftToDvp(privateHub, tokenId);

    // Test: Perform swap with zero payment amount
    const sharedId = generateRandomHash();
    const swapBlockNumber = await privateHub.provider.getBlockNumber();
    await nft.swapForEnygma(privateHub, {
      nftId: tokenId, enygmaAmount: PAYMENT_AMOUNT, enygmaResourceId: enygmaToken.resourceId,
      enygmaPLChainId: privacyNodes.A.chainId, sharedId, validity: 0,
    });
    await enygmaToken.swapForERC721(privateHub, {
      nftId: tokenId, nftResourceId: nft.resourceId, enygmaAmount: PAYMENT_AMOUNT,
      nftPLChainId: privacyNodes.B.chainId, sharedId, validity: 0,
    });
    await privateHub.waitForSwapCompleted(sharedId, swapBlockNumber);

    // Test: Withdraw swapped assets
    const nftOnA = await nft.forNode(privacyNodes.A, true, enygmaToken.userWallet);
    await nftOnA.withdrawNftFromDvp(privateHub, tokenId, singerAddressA);
}).timeout(DEFAULT_TIMEOUT);

it('should perform NFT-EnygmaWrapper swap with cross-chain transfer @regression @dvp @swap @transfer', async function () {
    const DEPOSIT_AMOUNT = BigInt(100);
    const CHANGE_AMOUNT = BigInt(10);
    const MINT_AMOUNT = DEPOSIT_AMOUNT + CHANGE_AMOUNT;
    const PAYMENT_AMOUNT = MINT_AMOUNT - CHANGE_AMOUNT;
    const TRANSFER_AMOUNT = PAYMENT_AMOUNT;

    // Setup: Mint tokens
    await enygmaToken.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: singerAddressA });
    const tokenId = await nft.mintAndAwait(privateHub, { toAddress: singerAddressB });

    // Setup: Deposit tokens into Dvp
    await enygmaToken.depositEnygmaToDvp(MINT_AMOUNT, BigInt(0), privateHub);
    await nft.depositNftToDvp(privateHub, tokenId);

    // Test: Perform swap
    const sharedId = generateRandomHash();
    const swapBlockNumber = await privateHub.provider.getBlockNumber();
    await nft.swapForEnygma(privateHub, {
      nftId: tokenId, enygmaAmount: PAYMENT_AMOUNT, enygmaResourceId: enygmaToken.resourceId,
      enygmaPLChainId: privacyNodes.A.chainId, sharedId, validity: 0,
    });
    await enygmaToken.swapForERC721(privateHub, {
      nftId: tokenId, nftResourceId: nft.resourceId, enygmaAmount: PAYMENT_AMOUNT,
      nftPLChainId: privacyNodes.B.chainId, sharedId, validity: 0,
    });
    await privateHub.waitForSwapCompleted(sharedId, swapBlockNumber);

    // Test: Withdraw swapped assets
  const nftOnA = await nft.forNode(privacyNodes.A, true, enygmaToken.userWallet);
  await nftOnA.withdrawNftFromDvp(privateHub, tokenId, singerAddressA);
    const enygmaOnB = await enygmaToken.forNode(privacyNodes.B, true, nft.userWallet);
    await enygmaOnB.withdrawEnygmaFromDvp(PAYMENT_AMOUNT, privateHub);

    // Test: Cross-chain transfer - EnygmaWrapper from PN B to PN A
    // Snapshot balance before transfer — tests share state so node A has accumulated balance
    const balanceBeforeTransfer = await enygmaToken.getBalanceOf(enygmaToken.userWallet.address);

    const transfer: EnygmaCrossTransfer = {
        destinationAddresses: [enygmaToken.userWallet.address],
        amounts: [TRANSFER_AMOUNT],
        destinationChainIds: [privacyNodes.A.chainId],
        programData: [[]],
    };

    const expectedBalances = {
        [privacyNodes.A.chainId]: balanceBeforeTransfer + TRANSFER_AMOUNT,
    };

    const destinations = [privacyNodes.A];

    await shouldCrossTransferEnygma(transfer, 2, expectedBalances, privateHub, privacyNodes.B, destinations, enygmaToken);

    // Test: Withdraw remaining change amount for PN A
    await enygmaToken.withdrawEnygmaFromDvp(
        CHANGE_AMOUNT,
        privateHub,
    );
  }).timeout(8 * 60 * 1000); // Increased timeout for cross-chain transfer test
  });

  describe('Dvp ERC1155-EnygmaWrapper Swaps', function () {
  // Privacy Ledger setup
  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let enygmaToken: EnygmaWrapper<ProductionEnygmaToken>;
  let erc1155: ERC1155Wrapper<ProductionErc1155Dvp>;
  const ERC1155_ID = BigInt(1);
  let singerAddressA = "";
  let singerAddressB = "";

  beforeEach(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const {initializedNodes,
      initializedPNH} = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;
    // FACTORY-mode production Enygma: seeded-template codehash clears the programmability gate so the
    // cross-transfer settlement mint lands (see the NFT-Enygma block above for the full rationale).
    enygmaToken = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
    erc1155 = new ERC1155Wrapper(privacyNodes.B,ProductionErc1155Dvp__factory);
    singerAddressA = enygmaToken.userWallet.address;
    singerAddressB = erc1155.userWallet.address;

    await enygmaToken.deployViaFactory();
    await enygmaToken.activateOnPn();
    await enygmaToken.activateOnHub(privateHub);
    await erc1155.deploy();
    await erc1155.activateOnPn();
    await erc1155.activateOnHub(privateHub);
  });

  // @smoke single-deposit ERC1155 swap moved to Dvp_Swap_NFT_Enygma_Smoke.ts for parallel execution.

  it('should perform ERC1155-EnygmaWrapper swap with single deposit (with change) @regression @dvp @swap @erc1155', async function () {
    const ERC1155_DEPOSIT_AMOUNT = BigInt(10);
    const ERC1155_CHANGE_AMOUNT = BigInt(5);
    const ENYGMA_DEPOSIT_AMOUNT = BigInt(10);
    const ENYGMA_CHANGE_AMOUNT = BigInt(5);
    const ERC1155_MINT_AMOUNT = ERC1155_DEPOSIT_AMOUNT;
    const ENYGMA_MINT_AMOUNT = ENYGMA_DEPOSIT_AMOUNT;

    // Setup: Mint tokens
    await enygmaToken.mintAndAwait(privateHub, { amount: ENYGMA_MINT_AMOUNT, toAddress: singerAddressA });
    await erc1155.mintAndAwait(privateHub, { toAddress: singerAddressB, tokenId: BigInt(ERC1155_ID), amount: BigInt(ERC1155_MINT_AMOUNT) });

    // Setup: Deposit tokens into Dvp
    await enygmaToken.depositEnygmaToDvp(ENYGMA_MINT_AMOUNT, BigInt(0), privateHub);
    await erc1155.depositNftToDvp(privateHub, ERC1155_ID, ERC1155_MINT_AMOUNT);

    // Test: Perform swap (ERC1155 initiator) with change
    const sharedId = generateRandomHash();
    const swapBlockNumber = await privateHub.provider.getBlockNumber();
    await erc1155.swapForEnygma(privateHub, {
      nftId: ERC1155_ID, nftAmount: ERC1155_MINT_AMOUNT - ERC1155_CHANGE_AMOUNT, data: '0x',
      enygmaAmount: ENYGMA_DEPOSIT_AMOUNT - ENYGMA_CHANGE_AMOUNT, enygmaResourceId: enygmaToken.resourceId,
      enygmaPLChainId: privacyNodes.A.chainId, sharedId, validity: 0,
    });
    await enygmaToken.swapForERC1155(privateHub, {
      nftId: ERC1155_ID, nftAmount: ERC1155_MINT_AMOUNT - ERC1155_CHANGE_AMOUNT, nftResourceId: erc1155.resourceId,
      enygmaAmount: ENYGMA_DEPOSIT_AMOUNT - ENYGMA_CHANGE_AMOUNT, nftPLChainId: privacyNodes.B.chainId, sharedId,
      validity: 0,
    });
    await privateHub.waitForSwapCompleted(sharedId, swapBlockNumber);

    // Test: Withdraw swapped assets and change
    const erc1155OnA = await erc1155.forNode(privacyNodes.A, true, enygmaToken.userWallet);
    await erc1155OnA.withdrawNftFromDvp(
      privateHub,
      ERC1155_ID,
      ERC1155_MINT_AMOUNT - ERC1155_CHANGE_AMOUNT
      ,singerAddressA
    );
    const enygmaOnB = await enygmaToken.forNode(privacyNodes.B, true, erc1155.userWallet);
    await enygmaOnB.withdrawEnygmaFromDvp(
      ENYGMA_DEPOSIT_AMOUNT - ENYGMA_CHANGE_AMOUNT,
      privateHub,
    );
    await enygmaToken.withdrawEnygmaFromDvp(
      ENYGMA_CHANGE_AMOUNT,
      privateHub,
    );
  }).timeout(DEFAULT_TIMEOUT);

  it('should perform ERC1155-EnygmaWrapper swap with eleven deposits (consolidation behavior) @regression @dvp @swap @erc1155 @consolidation', async function () {
    const ERC1155_DEPOSIT_AMOUNT = BigInt(10);
    const ENYGMA_DEPOSIT_AMOUNT = BigInt(10);
    const ENYGMA_NUMBER_OF_DEPOSITS = 11;
    const ERC1155_MINT_AMOUNT = ERC1155_DEPOSIT_AMOUNT;
    const ENYGMA_MINT_AMOUNT = ENYGMA_DEPOSIT_AMOUNT * BigInt(ENYGMA_NUMBER_OF_DEPOSITS);

    // Setup: Mint tokens
    await enygmaToken.mintAndAwait(privateHub, { amount: ENYGMA_MINT_AMOUNT, toAddress: singerAddressA });
    await erc1155.mintAndAwait(privateHub, { toAddress: singerAddressB, tokenId: BigInt(ERC1155_ID), amount: BigInt(ERC1155_MINT_AMOUNT) });

    const blockNumber = await privateHub.provider.getBlockNumber();
    // Setup: Deposit tokens into Dvp (multiple EnygmaWrapper deposits, single ERC1155 deposit)
    // Multiple EnygmaWrapper deposits to trigger consolidation behavior
    let totalDeposited = BigInt(0);
    for (let depositNumber = 1; depositNumber <= ENYGMA_NUMBER_OF_DEPOSITS; depositNumber++) {
      totalDeposited += ENYGMA_DEPOSIT_AMOUNT;
      await enygmaToken.depositEnygmaToDvp(
        ENYGMA_DEPOSIT_AMOUNT,
        ENYGMA_MINT_AMOUNT - totalDeposited,
        privateHub,
      );
    }
    await enygmaToken.waitForDepositsToComplete(ENYGMA_NUMBER_OF_DEPOSITS, privateHub, blockNumber);
    // Single ERC1155 deposit
    await erc1155.depositNftToDvp(privateHub, ERC1155_ID, ERC1155_MINT_AMOUNT);

    // Test: Perform swap (ERC1155 initiator)
    const sharedId = generateRandomHash();
    const swapBlockNumber = await privateHub.provider.getBlockNumber();
    await erc1155.swapForEnygma(privateHub, {
      nftId: ERC1155_ID, nftAmount: ERC1155_MINT_AMOUNT, data: '0x', enygmaAmount: ENYGMA_MINT_AMOUNT,
      enygmaResourceId: enygmaToken.resourceId, enygmaPLChainId: privacyNodes.A.chainId, sharedId,
      validity: 0,
    });
    await enygmaToken.swapForERC1155(privateHub, {
      nftId: ERC1155_ID, nftAmount: ERC1155_MINT_AMOUNT, nftResourceId: erc1155.resourceId,
      enygmaAmount: ENYGMA_MINT_AMOUNT, nftPLChainId: privacyNodes.B.chainId, sharedId,
      validity: 0,
    });
    await privateHub.waitForSwapCompleted(sharedId, swapBlockNumber);

    // Test: Withdraw swapped assets
    const erc1155OnA = await erc1155.forNode(privacyNodes.A, true, enygmaToken.userWallet);
    await erc1155OnA.withdrawNftFromDvp(privateHub, ERC1155_ID, ERC1155_MINT_AMOUNT,singerAddressA);
    const enygmaOnB = await enygmaToken.forNode(privacyNodes.B, true, erc1155.userWallet);
    await enygmaOnB.withdrawEnygmaFromDvp(
      ENYGMA_MINT_AMOUNT,
      privateHub,
    );
  }).timeout(8 * 60 * 1000); // Increased timeout for consolidation test

  it('should perform EnygmaWrapper-ERC1155 swap with single deposit (reverse direction) @regression @dvp @swap @erc1155', async function () {
    const ERC1155_DEPOSIT_AMOUNT = BigInt(10);
    const ENYGMA_DEPOSIT_AMOUNT = BigInt(10);
    const ERC1155_MINT_AMOUNT = ERC1155_DEPOSIT_AMOUNT;
    const ENYGMA_MINT_AMOUNT = ENYGMA_DEPOSIT_AMOUNT;

    // Setup: Mint tokens
    await enygmaToken.mintAndAwait(privateHub, { amount: ENYGMA_MINT_AMOUNT, toAddress: singerAddressA });
    await erc1155.mintAndAwait(privateHub, { toAddress: singerAddressB, tokenId: BigInt(ERC1155_ID), amount: BigInt(ERC1155_MINT_AMOUNT) });

    // Setup: Deposit tokens into Dvp
    await enygmaToken.depositEnygmaToDvp(ENYGMA_MINT_AMOUNT, BigInt(0), privateHub);
    await erc1155.depositNftToDvp(privateHub, ERC1155_ID, ERC1155_MINT_AMOUNT);

    // Test: Perform swap (EnygmaWrapper initiator)
    const sharedId = generateRandomHash();
    const swapBlockNumber = await privateHub.provider.getBlockNumber();
    await erc1155.swapForEnygma(privateHub, {
      nftId: ERC1155_ID, nftAmount: ERC1155_MINT_AMOUNT, data: '0x', enygmaAmount: ENYGMA_DEPOSIT_AMOUNT,
      enygmaResourceId: enygmaToken.resourceId, enygmaPLChainId: privacyNodes.A.chainId, sharedId,
      validity: 0,
    });
    await enygmaToken.swapForERC1155(privateHub, {
      nftId: ERC1155_ID, nftAmount: ERC1155_MINT_AMOUNT, nftResourceId: erc1155.resourceId,
      enygmaAmount: ENYGMA_DEPOSIT_AMOUNT, nftPLChainId: privacyNodes.B.chainId, sharedId,
      validity: 0,
    });
    await privateHub.waitForSwapCompleted(sharedId, swapBlockNumber);

    // Test: Withdraw swapped assets
    const erc1155OnA = await erc1155.forNode(privacyNodes.A, true, enygmaToken.userWallet);
    await erc1155OnA.withdrawNftFromDvp(privateHub, ERC1155_ID, ERC1155_MINT_AMOUNT,singerAddressA);
    const enygmaOnB = await enygmaToken.forNode(privacyNodes.B, true, erc1155.userWallet);
    await enygmaOnB.withdrawEnygmaFromDvp(
      ENYGMA_DEPOSIT_AMOUNT,
      privateHub,
    );
  }).timeout(DEFAULT_TIMEOUT);

  it('should perform EnygmaWrapper-ERC1155 swap with single deposit (with change) @regression @dvp @swap @erc1155', async function () {
    const ERC1155_DEPOSIT_AMOUNT = BigInt(10);
    const ERC1155_CHANGE_AMOUNT = BigInt(5);
    const ENYGMA_DEPOSIT_AMOUNT = BigInt(10);
    const ENYGMA_CHANGE_AMOUNT = BigInt(5);
    const ERC1155_MINT_AMOUNT = ERC1155_DEPOSIT_AMOUNT;
    const ENYGMA_MINT_AMOUNT = ENYGMA_DEPOSIT_AMOUNT;

    // Setup: Mint tokens
    await enygmaToken.mintAndAwait(privateHub, { amount: ENYGMA_MINT_AMOUNT, toAddress: singerAddressA });
    await erc1155.mintAndAwait(privateHub, { toAddress: singerAddressB, tokenId: BigInt(ERC1155_ID), amount: BigInt(ERC1155_MINT_AMOUNT) });

    // Setup: Deposit tokens into Dvp
    await enygmaToken.depositEnygmaToDvp(ENYGMA_MINT_AMOUNT, BigInt(0), privateHub);
    await erc1155.depositNftToDvp(privateHub, ERC1155_ID, ERC1155_MINT_AMOUNT);

    // Test: Perform swap (EnygmaWrapper initiator) with change
    const sharedId = generateRandomHash();
    const swapBlockNumber = await privateHub.provider.getBlockNumber();
    await erc1155.swapForEnygma(privateHub, {
      nftId: ERC1155_ID, nftAmount: ERC1155_MINT_AMOUNT - ERC1155_CHANGE_AMOUNT, data: '0x',
      enygmaAmount: ENYGMA_DEPOSIT_AMOUNT - ENYGMA_CHANGE_AMOUNT, enygmaResourceId: enygmaToken.resourceId,
      enygmaPLChainId: privacyNodes.A.chainId, sharedId, validity: 0,
    });
    await enygmaToken.swapForERC1155(privateHub, {
      nftId: ERC1155_ID, nftAmount: ERC1155_MINT_AMOUNT - ERC1155_CHANGE_AMOUNT, nftResourceId: erc1155.resourceId,
      enygmaAmount: ENYGMA_DEPOSIT_AMOUNT - ENYGMA_CHANGE_AMOUNT, nftPLChainId: privacyNodes.B.chainId, sharedId,
      validity: 0,
    });
    await privateHub.waitForSwapCompleted(sharedId, swapBlockNumber);

    // Test: Withdraw swapped assets and change
    const erc1155OnA = await erc1155.forNode(privacyNodes.A, true, enygmaToken.userWallet);
    await erc1155OnA.withdrawNftFromDvp(
      privateHub,
      ERC1155_ID,
      ERC1155_MINT_AMOUNT - ERC1155_CHANGE_AMOUNT,
      singerAddressA
    );
    const enygmaOnB = await enygmaToken.forNode(privacyNodes.B, true, erc1155.userWallet);
    await enygmaOnB.withdrawEnygmaFromDvp(
      ENYGMA_DEPOSIT_AMOUNT - ENYGMA_CHANGE_AMOUNT,
      privateHub,
    );
    // Withdraw change back to original owner
    await erc1155.withdrawNftFromDvp(privateHub, ERC1155_ID, ERC1155_CHANGE_AMOUNT,singerAddressB);
  }).timeout(DEFAULT_TIMEOUT);

  it('should perform EnygmaWrapper-ERC1155 swap with eleven deposits (consolidation behavior) @regression @dvp @swap @erc1155 @consolidation', async function () {
    const ERC1155_DEPOSIT_AMOUNT = BigInt(10);
    const ENYGMA_DEPOSIT_AMOUNT = BigInt(10);
    const ENYGMA_NUMBER_OF_DEPOSITS = 11;
    const ERC1155_MINT_AMOUNT = ERC1155_DEPOSIT_AMOUNT;
    const ENYGMA_MINT_AMOUNT = ENYGMA_DEPOSIT_AMOUNT * BigInt(ENYGMA_NUMBER_OF_DEPOSITS);

    // Setup: Mint tokens
    await enygmaToken.mintAndAwait(privateHub, { amount: ENYGMA_MINT_AMOUNT, toAddress: singerAddressA });
    await erc1155.mintAndAwait(privateHub, { toAddress: singerAddressB, tokenId: BigInt(ERC1155_ID), amount: BigInt(ERC1155_MINT_AMOUNT) });

    const blockNumber = await privateHub.provider.getBlockNumber();
    // Setup: Deposit tokens into Dvp (multiple EnygmaWrapper deposits)
    for (let i = 0; i < ENYGMA_NUMBER_OF_DEPOSITS; i++) {
      await enygmaToken.depositEnygmaToDvp(
        ENYGMA_DEPOSIT_AMOUNT,
        ENYGMA_MINT_AMOUNT - ENYGMA_DEPOSIT_AMOUNT * BigInt(i + 1),
        privateHub,
      );
    }
    await enygmaToken.waitForDepositsToComplete(ENYGMA_NUMBER_OF_DEPOSITS, privateHub, blockNumber);
    await erc1155.depositNftToDvp(privateHub, ERC1155_ID, ERC1155_MINT_AMOUNT);

    // Test: Perform swap (EnygmaWrapper initiator)
    const sharedId = generateRandomHash();
    const swapBlockNumber = await privateHub.provider.getBlockNumber();
    await erc1155.swapForEnygma(privateHub, {
      nftId: ERC1155_ID, nftAmount: ERC1155_MINT_AMOUNT, data: '0x', enygmaAmount: ERC1155_DEPOSIT_AMOUNT,
      enygmaResourceId: enygmaToken.resourceId, enygmaPLChainId: privacyNodes.A.chainId, sharedId,
      validity: 0,
    });
    await enygmaToken.swapForERC1155(privateHub, {
      nftId: ERC1155_ID, nftAmount: ERC1155_MINT_AMOUNT, nftResourceId: erc1155.resourceId,
      enygmaAmount: ERC1155_DEPOSIT_AMOUNT, nftPLChainId: privacyNodes.B.chainId, sharedId,
      validity: 0,
    });
    await privateHub.waitForSwapCompleted(sharedId, swapBlockNumber);

    // Test: Withdraw swapped assets
    const erc1155OnA = await erc1155.forNode(privacyNodes.A, true, enygmaToken.userWallet);
    await erc1155OnA.withdrawNftFromDvp(privateHub, ERC1155_ID, ERC1155_MINT_AMOUNT,singerAddressA);
    const enygmaOnB = await enygmaToken.forNode(privacyNodes.B, true, erc1155.userWallet);
    await enygmaOnB.withdrawEnygmaFromDvp(
      BigInt(ERC1155_DEPOSIT_AMOUNT),
      privateHub,
    );
  }).timeout(8 * 60 * 1000); // Increased timeout for consolidation test

  it('should perform ERC1155-EnygmaWrapper swap with cross-chain transfer @regression @dvp @swap @erc1155 @transfer', async function () {
    const DEPOSIT_AMOUNT = BigInt(100);
    const CHANGE_AMOUNT = BigInt(10);
    const MINT_AMOUNT = DEPOSIT_AMOUNT + CHANGE_AMOUNT;
    const PAYMENT_AMOUNT = MINT_AMOUNT - CHANGE_AMOUNT;
    const TRANSFER_AMOUNT = BigInt(10);
    const NFT_MINT_AMOUNT = BigInt(10);

    // Setup: Mint tokens
    await enygmaToken.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: singerAddressA });
    await erc1155.mintAndAwait(privateHub, { toAddress: singerAddressB, tokenId: BigInt(ERC1155_ID), amount: BigInt(NFT_MINT_AMOUNT) });

    // Setup: Deposit tokens into Dvp
    await enygmaToken.depositEnygmaToDvp(MINT_AMOUNT, BigInt(0), privateHub);
    await erc1155.depositNftToDvp(privateHub, ERC1155_ID, NFT_MINT_AMOUNT);

    // Test: Perform swap (ERC1155 for Enygmas)
    const sharedId = generateRandomHash();
    const swapBlockNumber = await privateHub.provider.getBlockNumber();
    await erc1155.swapForEnygma(privateHub, {
      nftId: ERC1155_ID, nftAmount: NFT_MINT_AMOUNT, data: '0x', enygmaAmount: PAYMENT_AMOUNT,
      enygmaResourceId: enygmaToken.resourceId, enygmaPLChainId: privacyNodes.A.chainId, sharedId,
      validity: 0,
    });
    await enygmaToken.swapForERC1155(privateHub, {
      nftId: ERC1155_ID, nftAmount: NFT_MINT_AMOUNT, nftResourceId: erc1155.resourceId,
      enygmaAmount: PAYMENT_AMOUNT, nftPLChainId: privacyNodes.B.chainId, sharedId,
      validity: 0,
    });
    await privateHub.waitForSwapCompleted(sharedId, swapBlockNumber);

    // Test: Withdraw swapped assets
    const erc1155OnA = await erc1155.forNode(privacyNodes.A, true, enygmaToken.userWallet);
    await erc1155OnA.withdrawNftFromDvp(privateHub, ERC1155_ID, NFT_MINT_AMOUNT, singerAddressA);
    const enygmaOnB = await enygmaToken.forNode(privacyNodes.B, true, erc1155.userWallet);
    await enygmaOnB.withdrawEnygmaFromDvp(PAYMENT_AMOUNT, privateHub);

    // Test: Cross-chain transfer - EnygmaWrapper from PN B to PN A
    // Snapshot balance before transfer — tests share state so node A has accumulated balance
    const balanceBeforeTransfer = await enygmaToken.getBalanceOf(enygmaToken.userWallet.address);

    const transfer: EnygmaCrossTransfer = {
      destinationAddresses: [enygmaToken.userWallet.address],
      amounts: [TRANSFER_AMOUNT],
      destinationChainIds: [privacyNodes.A.chainId],
      programData: [[]],
    };

    const expectedBalances = {
      [privacyNodes.A.chainId]: balanceBeforeTransfer + TRANSFER_AMOUNT,
    };

    const destinations = [privacyNodes.A];

    await shouldCrossTransferEnygma(transfer, 2, expectedBalances, privateHub, privacyNodes.B, destinations, enygmaToken);

    // Test: Withdraw remaining change amount for PN A
    await enygmaToken.withdrawEnygmaFromDvp(
      CHANGE_AMOUNT,
      privateHub,
    );
  }).timeout(8 * 60 * 1000); // Increased timeout for cross-chain transfer test
  });
});
