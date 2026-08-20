/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
import { TokenExample, TokenExample__factory } from '../../../typechain-types';
import { Interface } from 'ethers';
import { expect } from 'chai';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { ERC20Wrapper } from '../../../src/entities/tokens/ERC20Wrapper';
import GovernanceController from '../../../src/api/GovernanceController';
import { DEFAULT_TIMEOUT, GAS_LIMIT, GOVERNANCE_API_URL } from '../../../src/config/env-config';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { MessageType, Protocol, TransactionStatus } from '../../../src/types';
import { getMessageId, submitTx } from '../../../src/utils/common';
import { assertRevertDataTransaction, assertTransactionResponse, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_TX } from '../../test-utils/helpers';


describe('E2E Tests: Deploy ERC20 -> Make transaction using the token -> Assert the response body @decommissioned', function () {
  this.retries(0);

  const AMOUNT = 50n;

  let privacyNodes: PrivacyNodeMap = {};
  let privateHub : PrivateHub;
  let ERC20 : ERC20Wrapper<TokenExample>;
  let ERC20OnB : TokenExample;
  const GovController = new GovernanceController(GOVERNANCE_API_URL);
  before(async function () {
    this.timeout(DEFAULT_TIMEOUT*2);
    const {initializedNodes, initializedPNH} = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    ERC20 = new ERC20Wrapper(privacyNodes.A, TokenExample__factory);
    await ERC20.deploy();
    await ERC20.activateOnPn();
    await ERC20.activateOnHub(privateHub);
  });

  it('Should teleport Atomic from A to B and assert the transaction endpoint response body @smoke', async function () {
    const receipt = await submitTx(() => ERC20.contract.teleportAtomic(
      ERC20.userWallet.address,
      AMOUNT,
      privacyNodes.B.chainId,
      { gasLimit: GAS_LIMIT }
    ), `Teleporting from A to B...`);

    const endpointContract = privacyNodes.A.getEndpointV1();
    const endpointAddr = privacyNodes.A.endpointAddress.toLowerCase();
    const endpointInterface: Interface = endpointContract.interface;
    const messageIdHex = await getMessageId(receipt, endpointAddr, endpointInterface);
    const messageId = messageIdHex.replace(/^0x/, '');

    ERC20OnB = await privacyNodes.B.setContractByResourceId(TokenExample__factory.name,
      ERC20.resourceId, ERC20.symbol, ERC20.userWallet.connect(privacyNodes.B.provider));

    const transactionData = await GovController.waitForTransactionStatus(messageId, TransactionStatus.EXECUTED, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_TX);

    // The token becomes ACTIVE on registration, but circulatingSupply is
    // updated asynchronously from the lock/burn events. Polling on
    // waitForActiveToken alone races: it may return before the burn on the
    // source chain has been indexed. Use waitForCirculatingSupply to gate
    // the assertion on the expected post-teleport balance.
    const tokenAtoB = await GovController.waitForCirculatingSupply(
      ERC20.resourceId,
      [{ participantId: String(privacyNodes.B.chainId), balance: String(AMOUNT) }],
      GOV_POLL_INTERVAL_MS,
      GOV_POLL_ATTEMPTS_TX,
    );
    expect(tokenAtoB.frozenChainIds).to.not.include(String(privacyNodes.B.chainId));

    await assertTransactionResponse(transactionData, ERC20, {
      sourceChainId: privacyNodes.A.chainId,
      destinationChainId: privacyNodes.B.chainId,
      messageType: MessageType.ERC20,
      status: TransactionStatus.EXECUTED,
      sourceAddress: ERC20.userWallet.address,
      destinationAddress: ERC20.userWallet.address,
      amount: Number(AMOUNT),
      protocol: Protocol.ATOMIC,

    });
  }).timeout(DEFAULT_TIMEOUT);

  it('Should teleport atomic from B to A and assert the transaction endpoint response body', async function () {
    const receipt = await submitTx(() => ERC20OnB.teleportAtomic(
      ERC20.userWallet.address,
      AMOUNT,
      privacyNodes.A.chainId,
      { gasLimit: GAS_LIMIT }
    ), `Teleporting from B to A...`);

    const endpointContract = privacyNodes.B.getEndpointV1();
    const endpointAddr = privacyNodes.B.endpointAddress.toLowerCase();
    const endpointInterface = endpointContract.interface;
    const messageIdHex = await getMessageId(receipt, endpointAddr, endpointInterface);
    const messageId = messageIdHex.replace(/^0x/, '');

    const transactionData = await GovController.waitForTransactionStatus(messageId, TransactionStatus.EXECUTED, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_TX);

    const tokenBtoA = await GovController.waitForCirculatingSupply(
      ERC20.resourceId,
      [{ participantId: String(privacyNodes.B.chainId), balance: '0' }],
      GOV_POLL_INTERVAL_MS,
      GOV_POLL_ATTEMPTS_TX,
    );
    expect(tokenBtoA.frozenChainIds).to.not.include(String(privacyNodes.B.chainId));

    await assertTransactionResponse(transactionData, ERC20, {
      sourceChainId: privacyNodes.B.chainId,
      destinationChainId: privacyNodes.A.chainId,
      messageType: MessageType.ERC20,
      status: TransactionStatus.EXECUTED,
      sourceAddress: ERC20.userWallet.address,
      destinationAddress: ERC20.userWallet.address,
      amount: Number(AMOUNT),
      protocol: Protocol.ATOMIC,

    });
  }).timeout(DEFAULT_TIMEOUT);

  it('Should teleport atomic from A to B, fail when reaching B and revert then assert the transaction enpoint response body', async function () {
    const addressToFailA = await ERC20.contract.addressToFail();

    const receipt = await submitTx(() => ERC20.contract.teleportAtomic(
      addressToFailA,
      AMOUNT,
      privacyNodes.B.chainId,
      { gasLimit: GAS_LIMIT }
    ), `Teleporting from A to B, failing at B...`);

    const endpointContract =  privacyNodes.A.getEndpointV1();
    const endpointAddr = privacyNodes.A.endpointAddress.toLowerCase();
    const endpointInterface = endpointContract.interface;
    const messageIdHex = await getMessageId(receipt, endpointAddr, endpointInterface);
    const messageId = messageIdHex.replace(/^0x/, '');

    const transactionData = await GovController.waitForTransactionStatus(messageId, TransactionStatus.REVERTED, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_TX);

    const tokenAfterRevert = await GovController.waitForCirculatingSupply(
      ERC20.resourceId,
      [{ participantId: String(privacyNodes.B.chainId), balance: '0' }],
      GOV_POLL_INTERVAL_MS,
      GOV_POLL_ATTEMPTS_TX,
    );
    expect(tokenAfterRevert.frozenChainIds).to.not.include(String(privacyNodes.B.chainId));

    await assertTransactionResponse(transactionData, ERC20, {
      sourceChainId: privacyNodes.A.chainId,
      destinationChainId: privacyNodes.B.chainId,
      messageType: MessageType.ERC20,
      status: TransactionStatus.REVERTED,
      sourceAddress: ERC20.userWallet.address,
      destinationAddress: addressToFailA,
      amount: Number(AMOUNT),
      protocol: Protocol.ATOMIC,

    });

    // Validate revert data if populated (arrives via AtomicMessageAdditionalDataBatch event)
    const refreshedTx = await GovController.getTransactionByMessageId(messageId);
    if (refreshedTx.revertDataTransaction) {
      assertRevertDataTransaction(refreshedTx.revertDataTransaction);
    }
  }).timeout(DEFAULT_TIMEOUT);
});
