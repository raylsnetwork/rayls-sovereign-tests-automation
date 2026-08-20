/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
import { Interface } from 'ethers';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { ERC721Wrapper } from '../../../src/entities/tokens/ERC721Wrapper';
import GovernanceController from '../../../src/api/GovernanceController';
import { DEFAULT_TIMEOUT, GAS_LIMIT, GOVERNANCE_API_URL } from '../../../src/config/env-config';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { MessageType, Protocol, TransactionStatus } from '../../../src/types';
import { getMessageId, eventually, submitTx } from '../../../src/utils/common';
import { ProductionErc721Token, ProductionErc721Token__factory } from '../../../typechain-types';
import { assertTransactionResponse, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_TX } from './governance-assertions';

describe('E2E Tests: Deploy ERC721 -> Make transaction using the token -> Assert the response body @decommissioned', function () {
  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let ERC721: ERC721Wrapper<ProductionErc721Token>;
  let ERC721OnB: ProductionErc721Token;
  let tokenId: bigint;
  const GovController = new GovernanceController(GOVERNANCE_API_URL);
  before(async function () {
    this.timeout(DEFAULT_TIMEOUT*2);
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    ERC721 = new ERC721Wrapper<ProductionErc721Token>(privacyNodes.A, ProductionErc721Token__factory);
    await ERC721.deploy();
    await ERC721.activateOnPn();
    await ERC721.activateOnHub(privateHub);
    tokenId = await ERC721.mintAndAwait(privateHub, {
      toAddress: ERC721.userWallet.address,
    })
  });

  it('Should teleport Atomic from A to B and assert the transaction endpoint response body @smoke', async function () {
    const receipt = await submitTx(() => ERC721.contract.teleportAtomic(
      ERC721.userWallet.address,
      tokenId,
      privacyNodes.B.chainId,
      { gasLimit: GAS_LIMIT }
    ), `Teleporting NFT from A to B...`);

    const endpointContract = privacyNodes.A.getEndpointV1();
    const endpointAddr = privacyNodes.A.endpointAddress.toLowerCase();
    const endpointInterface: Interface = endpointContract.interface;
    const messageIdHex = await getMessageId(receipt, endpointAddr, endpointInterface);
    const messageId = messageIdHex.replace(/^0x/, '');

    ERC721OnB = await privacyNodes.B.setContractByResourceId(
      ProductionErc721Token__factory.name,
      ERC721.resourceId,
      ERC721.symbol,
      ERC721.userWallet.connect(privacyNodes.B.provider)
    );

    const transactionData = await GovController.waitForTransactionStatus(messageId, TransactionStatus.EXECUTED, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_TX);

    await eventually<boolean>({
      check: async () => {
        const ownerOnB = await ERC721OnB.ownerOf(tokenId);
        return ownerOnB.toLowerCase() === ERC721.userWallet.address.toLowerCase();
      },
      message: `Checking NFT owner on B`,
    });

    await assertTransactionResponse(transactionData, ERC721, {
      sourceChainId: privacyNodes.A.chainId,
      destinationChainId: privacyNodes.B.chainId,
      messageType: MessageType.ERC721,
      status: TransactionStatus.EXECUTED,
      sourceAddress: ERC721.userWallet.address,
      destinationAddress: ERC721.userWallet.address,
      protocol: Protocol.ATOMIC,
      ercId: tokenId.toString(),
    });
  }).timeout(DEFAULT_TIMEOUT);

  it('Should teleport atomic from B to A and assert the transaction enpoint response body', async function () {
    const receipt = await submitTx(() => ERC721OnB.teleportAtomic(
      ERC721.userWallet.address,
      tokenId,
      privacyNodes.A.chainId,
      { gasLimit: GAS_LIMIT }
    ), `Teleporting NFT from B to A...`);

    const endpointContract = privacyNodes.B.getEndpointV1();
    const endpointAddr = privacyNodes.B.endpointAddress.toLowerCase();
    const endpointInterface = endpointContract.interface;
    const messageIdHex = await getMessageId(receipt, endpointAddr, endpointInterface);
    const messageId = messageIdHex.replace(/^0x/, '');

    const transactionData = await GovController.waitForTransactionStatus(messageId, TransactionStatus.EXECUTED, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_TX);

    await eventually<boolean>({
      check: async () => {
        const currentOwnerA = await ERC721.contract.ownerOf(tokenId);
        return currentOwnerA.toLowerCase() === ERC721.userWallet.address.toLowerCase();
      },
      message: `Checking owner on A`,
    });

    await assertTransactionResponse(transactionData, ERC721, {
      sourceChainId: privacyNodes.B.chainId,
      destinationChainId: privacyNodes.A.chainId,
      messageType: MessageType.ERC721,
      status: TransactionStatus.EXECUTED,
      sourceAddress: ERC721.userWallet.address,
      destinationAddress: ERC721.userWallet.address,
      protocol: Protocol.ATOMIC,
      ercId: tokenId.toString(),
    });
  }).timeout(DEFAULT_TIMEOUT);
});
