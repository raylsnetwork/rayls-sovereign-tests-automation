import { expect } from 'chai';
import {
  EnygmaTokenExample,
  EnygmaTokenExample__factory,
  Erc721DvpOverrideExample,
  Erc721DvpOverrideExample__factory,
} from '../../../typechain-types';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { DEFAULT_TIMEOUT, GOVERNANCE_API_URL, LOGGER } from '../../../src/config/env-config';
import { EnygmaWrapper } from '../../../src/entities/tokens/EnygmaWrapper';
import { ERC721Wrapper } from '../../../src/entities/tokens/ERC721Wrapper';
import { eventually, never, submitTx } from '../../../src/utils/common';
import {
  DvpSwapStatus,
  MessageType,
  Protocol
} from '../../../src/types';
import GovernanceController from '../../../src/api/GovernanceController';
import {
  assertDvpDepositWithdrawItem,
  assertDvpSwapTransactionResponse,
  GOV_POLL_INTERVAL_MS,
  GOV_POLL_ATTEMPTS_MEDIUM,
  GOV_POLL_ATTEMPTS_LONG,
  GOV_POLL_ATTEMPTS_TX,
  GOV_POLL_ATTEMPTS_XLONG,
} from './governance-assertions';
import { generateRandomHash } from '../../test-utils/helpers';
import { PrivateHub } from '../../../src/entities/PrivateHub';


describe('E2E Tests: DvP Flow -> Assert Governance API', function () {
  // DvP tests have irreversible on-chain side effects (deposits burn tokens).
  // Retries would re-run the test body against already-mutated state, causing
  // ERC20InsufficientBalance on the second attempt. Disable retries.
  this.retries(0);

  let enygmaToken: EnygmaWrapper<EnygmaTokenExample>;
  let nft: ERC721Wrapper<Erc721DvpOverrideExample>;

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  let dvpIntegrationAddress: string;

  const govController = new GovernanceController(GOVERNANCE_API_URL);

  const CHANGE_AMOUNT = 10n;
  const PAYMENT_AMOUNT = 100n;
  const MINT_AMOUNT = PAYMENT_AMOUNT + CHANGE_AMOUNT;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    enygmaToken = new EnygmaWrapper(privacyNodes.A, EnygmaTokenExample__factory);
    nft = new ERC721Wrapper(privacyNodes.B, Erc721DvpOverrideExample__factory);

    // nft is Erc721DvpOverrideExample (factory holdout): keep the explicit deploy +
    // grant + activateOnPn + activateOnHub path. Only the Enygma token migrates to FACTORY mode.
    await nft.deploy();
    await privacyNodes.B.grantEndpointSender([nft.address[privacyNodes.B.chainId]]);
    await enygmaToken.deployViaFactory();
    await enygmaToken.activateOnPn();
    await enygmaToken.activateOnHub(privateHub);
    await nft.activateOnPn();
    await nft.activateOnHub(privateHub);
    await enygmaToken.mintAndAwait(privateHub, { amount: 6n * MINT_AMOUNT, toAddress: enygmaToken.userWallet.address });

    dvpIntegrationAddress = await enygmaToken.getDvpIntegrationAddress(privateHub);
  });

  it('Complete DvP flow (deposit, swap, withdraw) shows as Executed', async function () {
    const nftTokenId = await nft.mintAndAwait(privateHub, { toAddress: nft.userWallet.address, tokenId: nft.nextTokenId });

    // ── Phase 1: Deposits ──────────────────────────────────────────────
    // DvP deposits are stored without messageId, so idType should be equal 'transaction_id'
    const depositInitiatedAt = Math.floor(Date.now() / 1000);

    const enygmaDepositReceipt = await enygmaToken.depositEnygmaToDvp(MINT_AMOUNT, 1n, privateHub);
    const nftDepositReceipt = await nft.depositNftToDvp(privateHub, nftTokenId);

    const enygmaDepositListItem = await govController.waitForTransaction({
      messageType: MessageType.ENYGMA,
      fromAddress: enygmaToken.userWallet.address,
      sourceChainId: privacyNodes.A.chainId,
      initiatedAfter: depositInitiatedAt,
    }, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_LONG);

    const nftDepositListItem = await govController.waitForTransaction({
      messageType: MessageType.DVP_ERC721,
      fromAddress: nft.userWallet.address,
      sourceChainId: privacyNodes.B.chainId,
      initiatedAfter: depositInitiatedAt,
    }, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_LONG);

    LOGGER.log(`Asserting Enygma deposit: idType=${enygmaDepositListItem.idType}, type=${enygmaDepositListItem.type}`);
    expect(enygmaDepositListItem.idType).to.equal('transaction_id');
    const enygmaDepositDetail = await govController.getTransactionByTransactionId(enygmaDepositListItem.id);
    await assertDvpDepositWithdrawItem(enygmaDepositDetail, enygmaToken, {
      protocol: Protocol.DVP_DEPOSIT,
      sourceChainId: privacyNodes.A.chainId,
      sourceAddress: enygmaToken.userWallet.address,
      messageType: MessageType.ENYGMA,
      amount: Number(MINT_AMOUNT),
      sourceTransactionHash: enygmaDepositReceipt.hash,
      destinationChainId: privateHub.chainId,
      destinationAddress: dvpIntegrationAddress,
    }, privateHub);

    LOGGER.log(`Asserting NFT deposit: idType=${nftDepositListItem.idType}, type=${nftDepositListItem.type}`);
    expect(nftDepositListItem.idType).to.equal('transaction_id');
    const nftDepositDetail = await govController.getTransactionByTransactionId(nftDepositListItem.id);
    await assertDvpDepositWithdrawItem(nftDepositDetail, nft, {
      protocol: Protocol.DVP_DEPOSIT,
      sourceChainId: privacyNodes.B.chainId,
      sourceAddress: nft.userWallet.address,
      messageType: MessageType.DVP_ERC721,
      amount: 1,
      sourceTransactionHash: nftDepositReceipt.hash,
      destinationChainId: privateHub.chainId,
      destinationAddress: privateHub.dvpAddress,
      ercId: nftTokenId.toString(),
    }, privateHub);

    // ── Phase 2: Swap ──────────────────────────────────────────────────
    const sharedId = generateRandomHash();
    const sharedIdForApi = sharedId.replace(/^0x/, '');

    // NFT side (B) initiates the swap
    const nftSwapReceipt = await nft.swapForEnygma(privateHub, {
      nftId: nftTokenId,
      enygmaAmount: PAYMENT_AMOUNT,
      enygmaResourceId: enygmaToken.resourceId,
      enygmaPLChainId: privacyNodes.A.chainId,
      sharedId,
      validity: 0,
    });

    // Enygma side (A) responds to complete the swap
    const enygmaSwapReceipt = await enygmaToken.swapForERC721(privateHub, {
      nftId: nftTokenId,
      nftResourceId: nft.resourceId,
      enygmaAmount: PAYMENT_AMOUNT,
      nftPLChainId: privacyNodes.B.chainId,
      sharedId,
      validity: 0,
    });

    // Identify the swap by idType='shared_id' from the LIST endpoint, NOT by
    // a timestamp-after-deposit filter.
    //
    // We previously did:
    //   await waitForTransaction({ messageType: DVP_ERC721, fromAddress, sourceChainId,
    //                              initiatedAfter: Math.floor(Date.now()/1000) })
    // and expected the result to have idType='shared_id'. The governance audit
    // index records timestamps at second precision (destinationTimestamp), and
    // the same-second deposit boundary case (deposit.destinationTimestamp ==
    // swapInitiatedAt) racing with the swap-event index lag (~55ms behind the
    // tx receipt) routinely caused the deposit (idType='transaction_id') to
    // satisfy the filter first — the swap wasn't indexed yet on the same polling
    // tick.
    //
    // The fix: polling the LIST endpoint (which carries the `idType` field), and
    // filter client-side for `idType === 'shared_id'`. That is the precise
    // shape we want to assert exists; finding it terminates the polling. The
    // shared_id endpoint is wrong for this assertion because its response
    // type (DvpSwapTransaction) does not carry the `idType` field — `idType`
    // is implicit there. We keep the (messageType, fromAddress, sourceChainId)
    // server-side filter for efficiency.
    const swapListItem = await eventually({
      check: async () => {
        const result = await govController.getTransactions({
          messageType: MessageType.DVP_ERC721,
          fromAddress: nft.userWallet.address,
          sourceChainId: privacyNodes.B.chainId,
        });
        return result.data.find(t => t.idType === 'shared_id');
      },
      interval: GOV_POLL_INTERVAL_MS,
      attempts: GOV_POLL_ATTEMPTS_LONG,
      message: 'Waiting for DVP_ERC721 swap leg (idType=shared_id) in Gov API',
    });

    expect(swapListItem.idType).to.equal('shared_id');
    LOGGER.log(`Swap found with sharedId = ${sharedIdForApi}`);

    // Poll until both swap legs appear and are marked as Completed (SwapStateChanged must be processed)
    const dvpTxs = await eventually({
      check: async () => {
        const txs = await govController.getTransactionsBySharedId(sharedIdForApi);
        if (txs.length < 2) return undefined;
        if (!txs.every((tx) => tx.status === DvpSwapStatus.COMPLETED)) return undefined;
        return txs;
      },
      interval: GOV_POLL_INTERVAL_MS,
      attempts: GOV_POLL_ATTEMPTS_TX,
      message: 'Waiting for both DvP legs → COMPLETED',
    });

    LOGGER.log(`Found ${dvpTxs.length} DvP swap legs`);

    const sharedSwapFields = {
      sourceTransactionHash: nftSwapReceipt.hash,
      destinationTransactionHash: enygmaSwapReceipt.hash,
      status: DvpSwapStatus.COMPLETED,
      protocol: Protocol.DVP_SWAP,
    };

    const nftSwapLeg = dvpTxs.find(tx => tx.messageType === MessageType.DVP_ERC721)!;
    LOGGER.log(`Asserting NFT swap leg: status=${nftSwapLeg.status}`);
    await assertDvpSwapTransactionResponse(nftSwapLeg, nft, {
      messageType: MessageType.DVP_ERC721,
      sourceChainId: privacyNodes.B.chainId,
      sourceAddress: nft.userWallet.address,
      destinationChainId: privacyNodes.A.chainId,
      amount: 1,
      ercId: nftTokenId.toString(),
      ...sharedSwapFields,
    }, privateHub);

    const enygmaSwapLeg = dvpTxs.find(tx => tx.messageType === MessageType.ENYGMA)!;
    LOGGER.log(`Asserting Enygma swap leg: status=${enygmaSwapLeg.status}`);
    await assertDvpSwapTransactionResponse(enygmaSwapLeg, enygmaToken, {
      messageType: MessageType.ENYGMA,
      sourceChainId: privacyNodes.A.chainId,
      sourceAddress: enygmaToken.userWallet.address,
      destinationChainId: privacyNodes.B.chainId,
      amount: Number(PAYMENT_AMOUNT),
      ...sharedSwapFields,
    }, privateHub);

    // ── Phase 3: Withdrawals ───────────────────────────────────────────
    // DvP withdrawals are stored without messageId, so idType should be equal 'transaction_id'
    const withdrawInitiatedAt = Math.floor(Date.now() / 1000);

    const nftOnA = await nft.forNode(privacyNodes.A, true, enygmaToken.userWallet);
    const nftWithdrawReceipt = await nftOnA.withdrawNftFromDvp(privateHub, nftTokenId, enygmaToken.userWallet.address);
    const enygmaOnB = await enygmaToken.forNode(privacyNodes.B, true, nft.userWallet);
    const enygmaWithdrawBReceipt = await enygmaOnB.withdrawEnygmaFromDvp(PAYMENT_AMOUNT, privateHub);
    const enygmaWithdrawAReceipt = await enygmaToken.withdrawEnygmaFromDvp(CHANGE_AMOUNT, privateHub);

    const nftWithdrawListItem = await govController.waitForTransaction({
      messageType: MessageType.DVP_ERC721,
      fromAddress: enygmaToken.userWallet.address,
      sourceChainId: privacyNodes.A.chainId,
      initiatedAfter: withdrawInitiatedAt,
    }, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_LONG);

    const enygmaWithdrawBListItem = await govController.waitForTransaction({
      messageType: MessageType.ENYGMA,
      fromAddress: nft.userWallet.address,
      sourceChainId: privacyNodes.B.chainId,
      initiatedAfter: withdrawInitiatedAt,
    }, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_LONG);

    const enygmaWithdrawAListItem = await govController.waitForTransaction({
      messageType: MessageType.ENYGMA,
      fromAddress: enygmaToken.userWallet.address,
      sourceChainId: privacyNodes.A.chainId,
      initiatedAfter: withdrawInitiatedAt,
    }, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_LONG);


    LOGGER.log(`Asserting NFT withdrawal: idType=${nftWithdrawListItem.idType}, type=${nftWithdrawListItem.type}`);
    expect(nftWithdrawListItem.idType).to.equal('transaction_id');
    const nftWithdrawDetail = await govController.getTransactionByTransactionId(nftWithdrawListItem.id);
    await assertDvpDepositWithdrawItem(nftWithdrawDetail, nft, {
      protocol: Protocol.DVP_WITHDRAW,
      sourceChainId: privacyNodes.A.chainId,
      sourceAddress: enygmaToken.userWallet.address,
      messageType: MessageType.DVP_ERC721,
      amount: 1,
      sourceTransactionHash: nftWithdrawReceipt.hash,
      destinationChainId: privateHub.chainId,
      destinationAddress: privateHub.dvpAddress,
      ercId: nftTokenId.toString()
    }, privateHub);

    LOGGER.log(`Asserting Enygma payment withdrawal (B): idType=${enygmaWithdrawBListItem.idType}, type=${enygmaWithdrawBListItem.type}`);
    expect(enygmaWithdrawBListItem.idType).to.equal('transaction_id');
    const enygmaWithdrawBDetail = await govController.getTransactionByTransactionId(enygmaWithdrawBListItem.id);
    await assertDvpDepositWithdrawItem(enygmaWithdrawBDetail, enygmaToken, {
      protocol: Protocol.DVP_WITHDRAW,
      sourceChainId: privacyNodes.B.chainId,
      sourceAddress: nft.userWallet.address,
      messageType: MessageType.ENYGMA,
      amount: Number(PAYMENT_AMOUNT),
      sourceTransactionHash: enygmaWithdrawBReceipt.hash,
      destinationChainId: privateHub.chainId,
      destinationAddress: dvpIntegrationAddress
    }, privateHub);

    LOGGER.log(`Enygma change withdrawal (A): idType=${enygmaWithdrawAListItem.idType}, type=${enygmaWithdrawAListItem.type}`);
    expect(enygmaWithdrawAListItem.idType).to.equal('transaction_id');
    const enygmaWithdrawADetail = await govController.getTransactionByTransactionId(enygmaWithdrawAListItem.id);
    await assertDvpDepositWithdrawItem(enygmaWithdrawADetail, enygmaToken, {
      protocol: Protocol.DVP_WITHDRAW,
      sourceChainId: privacyNodes.A.chainId,
      sourceAddress: enygmaToken.userWallet.address,
      messageType: MessageType.ENYGMA,
      amount: Number(CHANGE_AMOUNT),
      sourceTransactionHash: enygmaWithdrawAReceipt.hash,
      destinationChainId: privateHub.chainId,
      destinationAddress: dvpIntegrationAddress
    }, privateHub);

    // Initial mint: 6*MINT_AMOUNT=660 on A.
    // Deposit (Burn): A = 660 - 110 = 550.
    // Withdrawal B (Mint): B = 100. Withdrawal A change (Mint): A = 550 + 10 = 560.
    const expectedBalanceA = 6n * MINT_AMOUNT - MINT_AMOUNT + CHANGE_AMOUNT; // 560
    const expectedBalanceB = PAYMENT_AMOUNT;                                   // 100
    LOGGER.log(`Asserting Balances table after DVP: A=${expectedBalanceA}, B=${expectedBalanceB}`);
    await govController.waitForCirculatingSupply(
      enygmaToken.resourceId,
      [
        { participantId: String(privacyNodes.A.chainId), balance: String(expectedBalanceA) },
        { participantId: String(privacyNodes.B.chainId), balance: String(expectedBalanceB) },
      ],
      GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_LONG,
    );
  }).timeout(15 * 60 * 1000);

  it('DvP swap disagreement shows as Pending', async function () {
    const nftTokenId = await nft.mintAndAwait(privateHub, { toAddress: nft.userWallet.address, tokenId: nft.nextTokenId });

    // ── Phase 1: Deposits ──────────────────────────────────────────────
    await enygmaToken.depositEnygmaToDvp(PAYMENT_AMOUNT, 2n, privateHub);
    await nft.depositNftToDvp(privateHub, nftTokenId);

    // ── Phase 2: Swap with mismatched amounts ──────────────────────────
    const sharedId = generateRandomHash();
    const sharedIdForApi = sharedId.replace(/^0x/, '');
    const blockNumber = await privateHub.provider.getBlockNumber();

    // NFT side (B) submits with the correct PAYMENT_AMOUNT
    await nft.swapForEnygma(privateHub, {
      nftId: nftTokenId,
      enygmaAmount: PAYMENT_AMOUNT,
      enygmaResourceId: enygmaToken.resourceId,
      enygmaPLChainId: privacyNodes.A.chainId,
      sharedId,
      validity: 0,
    });
    await privateHub.waitForSwapInitialized(sharedId, blockNumber);

    // Enygma side (A) responds with PAYMENT_AMOUNT - 1 → mismatch → disagreement
    await enygmaToken.swapForERC721(privateHub, {
      nftId: nftTokenId,
      nftResourceId: nft.resourceId,
      enygmaAmount: PAYMENT_AMOUNT - 1n,
      nftPLChainId: privacyNodes.B.chainId,
      sharedId,
      validity: 0,
    });

    // ── Phase 3: Assert Governance API ────────────────────────────────
    const dvpTxs = await eventually({
      check: async () => {
        const txs = await govController.getTransactionsBySharedId(sharedIdForApi);
        if (txs.length < 2) return undefined;
        if (!txs.every((tx) => tx.status === DvpSwapStatus.PENDING)) return undefined;
        return txs;
      },
      interval: GOV_POLL_INTERVAL_MS,
      attempts: GOV_POLL_ATTEMPTS_XLONG,
      message: 'Waiting for both DvP legs → PENDING',
    });
    LOGGER.log(`Found ${dvpTxs.length} DvP swap legs (disagreement)`);

    // Negative wait: confirm DvP status does not advance away from PENDING within the settlement window.
    await never({
      check: async () => {
        const txs = await govController.getTransactionsBySharedId(sharedIdForApi);
        return txs.some((tx) => tx.status !== DvpSwapStatus.PENDING);
      },
      interval: GOV_POLL_INTERVAL_MS,
      attempts: GOV_POLL_ATTEMPTS_MEDIUM,
      message: `Watching DvP swap (sharedId=${sharedIdForApi.slice(0,8)}…) (must stay PENDING, settlement window)`,
    });

    const nftPendingLeg = dvpTxs.find(tx => tx.messageType === MessageType.DVP_ERC721)!;
    LOGGER.log(`Asserting NFT swap leg: status=${nftPendingLeg.status}`);
    await assertDvpSwapTransactionResponse(nftPendingLeg, nft, {
      messageType: MessageType.DVP_ERC721,
      sourceChainId: privacyNodes.B.chainId,
      sourceAddress: nft.userWallet.address,
      amount: 1,
      ercId: nftTokenId.toString(),
      status: DvpSwapStatus.PENDING,
      protocol: Protocol.DVP_SWAP,
    }, privateHub);

    const enygmaPendingLeg = dvpTxs.find(tx => tx.messageType === MessageType.ENYGMA)!;
    LOGGER.log(`Asserting Enygma swap leg: status=${enygmaPendingLeg.status}`);
    await assertDvpSwapTransactionResponse(enygmaPendingLeg, enygmaToken, {
      messageType: MessageType.ENYGMA,
      destinationChainId: privacyNodes.B.chainId,
      amount: Number(PAYMENT_AMOUNT),
      status: DvpSwapStatus.PENDING,
      protocol: Protocol.DVP_SWAP,
    }, privateHub);
  }).timeout(15 * 60 * 1000);

  it('DvP swap cancellation shows as Cancelled', async function () {
    const nftTokenId = await nft.mintAndAwait(privateHub, { toAddress: nft.userWallet.address, tokenId: nft.nextTokenId });

    // ── Phase 1: NFT deposit only (no Enygma deposit needed for cancellation) ──
    await nft.depositNftToDvp(privateHub, nftTokenId);

    // ── Phase 2: NFT side initiates swap, then cancels before Enygma side joins ──
    const sharedId = generateRandomHash();
    const sharedIdForApi = sharedId.replace(/^0x/, '');
    const blockNumber = await privateHub.provider.getBlockNumber();

    await nft.swapForEnygma(privateHub, {
      nftId: nftTokenId,
      enygmaAmount: PAYMENT_AMOUNT,
      enygmaResourceId: enygmaToken.resourceId,
      enygmaPLChainId: privacyNodes.A.chainId,
      sharedId,
      validity: 0,
    });
    await privateHub.waitForSwapInitialized(sharedId, blockNumber);

    await submitTx(
      () => nft.contract.cancelSwap(
        sharedId,
        privacyNodes.A.chainId,
        nftTokenId,
        PAYMENT_AMOUNT,
        enygmaToken.resourceId,
      ),
      'Cancelling previous swap initialization...',
    );

    // ── Phase 3: Assert Governance API ────────────────────────────────
    const dvpTxs = await eventually({
      check: async () => {
        const txs = await govController.getTransactionsBySharedId(sharedIdForApi);
        if (txs.length < 1) return undefined;
        if (!txs.every((tx) => tx.status === DvpSwapStatus.CANCELLED)) return undefined;
        return txs;
      },
      interval: GOV_POLL_INTERVAL_MS,
      attempts: GOV_POLL_ATTEMPTS_XLONG,
      message: 'Waiting for DvP leg(s) → CANCELLED',
    });

    expect(dvpTxs.length).to.be.at.least(1, 'Cancellation should produce at least 1 leg');
    const cancelledLeg = dvpTxs.find(tx => tx.messageType === MessageType.DVP_ERC721)!;
    expect(cancelledLeg, 'Expected a cancelled NFT swap leg').to.not.be.undefined;

    const cancelledNftLeg = dvpTxs.find(tx => tx.messageType === MessageType.DVP_ERC721)!;
    expect(cancelledNftLeg, 'NFT swap leg should exist').to.not.be.undefined;

    LOGGER.log(`Asserting cancelled NFT swap leg: status=${cancelledNftLeg.status}`);
    await assertDvpSwapTransactionResponse(cancelledNftLeg, nft, {
      messageType: MessageType.DVP_ERC721,
      sourceChainId: privacyNodes.B.chainId,
      sourceAddress: nft.userWallet.address,
      amount: 1,
      ercId: nftTokenId.toString(),
      status: DvpSwapStatus.CANCELLED,
      protocol: Protocol.DVP_SWAP,
    }, privateHub);

    const cancelledEnygmaLeg = dvpTxs.find(tx => tx.messageType === MessageType.ENYGMA)!;
    expect(cancelledEnygmaLeg, 'Enygma swap leg should exist').to.not.be.undefined;
    expect(cancelledEnygmaLeg.status).to.equal(DvpSwapStatus.CANCELLED);
  }).timeout(15 * 60 * 1000);
});
