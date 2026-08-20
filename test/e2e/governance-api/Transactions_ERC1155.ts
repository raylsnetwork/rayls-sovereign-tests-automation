/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
import { Interface } from 'ethers';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { ERC1155Wrapper } from '../../../src/entities/tokens/ERC1155Wrapper';
import GovernanceController from '../../../src/api/GovernanceController';
import { DEFAULT_TIMEOUT, GAS_LIMIT, GOVERNANCE_API_URL } from '../../../src/config/env-config';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { MessageType, Protocol, TransactionStatus } from '../../../src/types';
import { getMessageId, eventually, submitTx } from '../../../src/utils/common';
import { RaylsErc1155Example, RaylsErc1155Example__factory } from '../../../typechain-types';
import { assertRevertDataTransaction, assertTransactionResponse, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_TX } from '../../test-utils/helpers';

describe('E2E Tests: Deploy ERC1155 -> Make transaction using the token -> Assert the response body @decommissioned', function () {
  this.retries(0);

  const AMOUNT = 50n;
  const TOKEN_ID = 1n;

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let ERC1155: ERC1155Wrapper<RaylsErc1155Example>;
  let ERC1155OnB: RaylsErc1155Example;
  const GovController = new GovernanceController(GOVERNANCE_API_URL);
  before(async function () {
    this.timeout(DEFAULT_TIMEOUT*2);
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    ERC1155 = new ERC1155Wrapper<RaylsErc1155Example>(privacyNodes.A, RaylsErc1155Example__factory);
    await ERC1155.deploy();
    await ERC1155.activateOnPn();
    await ERC1155.activateOnHub(privateHub);

    await ERC1155.mintAndAwait(privateHub, {
      toAddress: ERC1155.userWallet.address,
      amount: AMOUNT,
      tokenId: TOKEN_ID,
    });
  });

  it('Should teleport Atomic from A to B and assert the transaction endpoint response body @smoke', async function () {
    const receipt = await submitTx(() => ERC1155.contract.teleportAtomic(
      ERC1155.userWallet.address,
      TOKEN_ID,
      AMOUNT,
      privacyNodes.B.chainId,
      '0x',
      { gasLimit: GAS_LIMIT }
    ), `Teleporting from A to B...`);

    const endpointContract = privacyNodes.A.getEndpointV1();
    const endpointAddr = privacyNodes.A.endpointAddress.toLowerCase();
    const endpointInterface: Interface = endpointContract.interface;
    const messageIdHex = await getMessageId(receipt, endpointAddr, endpointInterface);
    const messageId = messageIdHex.replace(/^0x/, '');

    ERC1155OnB = await privacyNodes.B.setContractByResourceId(
      RaylsErc1155Example__factory.name,
      ERC1155.resourceId,
      ERC1155.symbol,
      ERC1155.userWallet.connect(privacyNodes.B.provider)
    );

    const transactionData = await GovController.waitForTransactionStatus(messageId, TransactionStatus.EXECUTED, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_TX);

    await eventually<boolean>({
      check: async () => {
        const currentBalanceB = await ERC1155OnB.balanceOf(ERC1155.userWallet.address, TOKEN_ID);
        return currentBalanceB === AMOUNT;
      },
      message: `Checking balance on B`,
    });

    await assertTransactionResponse(transactionData, ERC1155, {
      sourceChainId: privacyNodes.A.chainId,
      destinationChainId: privacyNodes.B.chainId,
      messageType: MessageType.ERC1155,
      status: TransactionStatus.EXECUTED,
      sourceAddress: ERC1155.userWallet.address,
      destinationAddress: ERC1155.userWallet.address,
      amount: Number(AMOUNT),
      protocol: Protocol.ATOMIC,
      ercId: TOKEN_ID.toString(),
    });
  }).timeout(DEFAULT_TIMEOUT);

  it('Should teleport atomic from B to A and assert the transaction enpoint response body', async function () {
    const receipt = await submitTx(() => ERC1155OnB.teleportAtomic(
      ERC1155.userWallet.address,
      TOKEN_ID,
      AMOUNT,
      privacyNodes.A.chainId,
      '0x',
      { gasLimit: GAS_LIMIT }
    ), `Teleporting from B to A...`);

    const endpointContract = privacyNodes.B.getEndpointV1();
    const endpointAddr = privacyNodes.B.endpointAddress.toLowerCase();
    const endpointInterface = endpointContract.interface;
    const messageIdHex = await getMessageId(receipt, endpointAddr, endpointInterface);
    const messageId = messageIdHex.replace(/^0x/, '');

    const transactionData = await GovController.waitForTransactionStatus(messageId, TransactionStatus.EXECUTED, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_TX);

    await eventually<boolean>({
      check: async () => {
        const currentBalanceA = await ERC1155.contract.balanceOf(ERC1155.userWallet.address, TOKEN_ID);
        const currentBalanceB = await ERC1155OnB.balanceOf(ERC1155.userWallet.address, TOKEN_ID);

        return (
          currentBalanceB === 0n &&
          currentBalanceA === AMOUNT
        );
      },
      message: `Checking balances`,
    });

    await assertTransactionResponse(transactionData, ERC1155, {
      sourceChainId: privacyNodes.B.chainId,
      destinationChainId: privacyNodes.A.chainId,
      messageType: MessageType.ERC1155,
      status: TransactionStatus.EXECUTED,
      sourceAddress: ERC1155.userWallet.address,
      destinationAddress: ERC1155.userWallet.address,
      amount: Number(AMOUNT),
      protocol: Protocol.ATOMIC,
      ercId: TOKEN_ID.toString(),
    });
  }).timeout(DEFAULT_TIMEOUT);

  it('Should teleport atomic from A to B, fail when reaching B and revert then assert the transaction enpoint response body', async function () {
    const balanceBeforeA = await ERC1155.contract.balanceOf(ERC1155.userWallet.address, TOKEN_ID);
    const addressToFailA = await ERC1155.contract.addressToFail();
    const failBalanceBeforeB = await ERC1155OnB.balanceOf(addressToFailA, TOKEN_ID);

    const receipt = await submitTx(() => ERC1155.contract.teleportAtomic(
      addressToFailA,
      TOKEN_ID,
      AMOUNT,
      privacyNodes.B.chainId,
      '0x',
      { gasLimit: GAS_LIMIT }
    ), `Teleporting from A to B, failing at B...`);

    const endpointContract = privacyNodes.A.getEndpointV1();
    const endpointAddr = privacyNodes.A.endpointAddress.toLowerCase();
    const endpointInterface = endpointContract.interface;
    const messageIdHex = await getMessageId(receipt, endpointAddr, endpointInterface);
    const messageId = messageIdHex.replace(/^0x/, '');

    const transactionData = await GovController.waitForTransactionStatus(messageId, TransactionStatus.REVERTED, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_TX);

    await eventually<boolean>({
      check: async () => {
        const currentBalanceA = await ERC1155.contract.balanceOf(ERC1155.userWallet.address, TOKEN_ID);
        const currentFailBalanceB = await ERC1155OnB.balanceOf(addressToFailA, TOKEN_ID);

        return (
          currentFailBalanceB === failBalanceBeforeB &&
          currentBalanceA === balanceBeforeA
        );
      },
      message: `Checking balances unchanged post-revert`,
    });

    await assertTransactionResponse(transactionData, ERC1155, {
      sourceChainId: privacyNodes.A.chainId,
      destinationChainId: privacyNodes.B.chainId,
      messageType: MessageType.ERC1155,
      status: TransactionStatus.REVERTED,
      sourceAddress: ERC1155.userWallet.address,
      destinationAddress: addressToFailA,
      amount: Number(AMOUNT),
      protocol: Protocol.ATOMIC,
      ercId: TOKEN_ID.toString(),
    });

    // Validate revert data if populated (arrives via AtomicMessageAdditionalDataBatch event)
    const refreshedTx = await GovController.getTransactionByMessageId(messageId);
    if (refreshedTx.revertDataTransaction) {
      assertRevertDataTransaction(refreshedTx.revertDataTransaction);
    }
  }).timeout(DEFAULT_TIMEOUT);
});
