import { ethers } from 'ethers';
import { PrivateHub } from '../../src/entities/PrivateHub';
import { eventually, submitTx } from '../../src/utils/common';
import { generateRandomHash } from '../test-utils/helpers';
import { BatchTransfer, BatchTransfer__factory, EndpointV1 } from '../../typechain-types';
import { DEFAULT_TIMEOUT, GAS_LIMIT, RAYLS_NODES } from '../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../setup';
import { encodeFunctionCall } from '../../src/utils/network-utils';
import { createUserOperator } from '../../src/utils/wallet-factory';

describe('E2E Tests: Batch Transfers', function () {
  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  const batchTransfer: { [NODE: string]: BatchTransfer } = {};
  const randomMessages = [...Array(100)].map(() => generateRandomHash());
  const resourceId = generateRandomHash();

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const {initializedNodes, initializedPNH} = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    for (const pl of RAYLS_NODES.filter(pl => pl == 'A' || pl == 'B')) {
      const deployer = createUserOperator(privacyNodes[pl].provider);
      const factory = await privacyNodes[pl].contractStore.getFactory<BatchTransfer__factory>(BatchTransfer__factory, deployer);

      // Deploy the contract (no restricted calls in constructor)
      await privacyNodes[pl].contractStore.deploy(
        factory,
        'BatchTransfer',
        resourceId,
        privacyNodes[pl].endpointAddress,
        privacyNodes[pl].raylsNodeEndpointAddress
      );

      const contract = privacyNodes[pl].getContract<BatchTransfer>('BatchTransfer');
      const contractAddress = await contract.getAddress();

      // Post-deployment setup (admin responsibilities):
      // 1. Register resourceId→contract mapping so Endpoint can route messages (RESOURCE_REGISTRAR)
      // 2. Grant ENDPOINT_SENDER so the contract can call endpoint.send()
      const endpoint = privacyNodes[pl].getContract<EndpointV1>('EndpointV1');
      const endpointAsAdmin = endpoint.connect(privacyNodes[pl].adminWallet) as typeof endpoint;
      await (await endpointAsAdmin.registerResourceId(resourceId, contractAddress)).wait();
      await privacyNodes[pl].grantEndpointSender([contractAddress]);

      batchTransfer[pl] = contract;
    }
  });

  describe('Arbitrary Messages', function () {
    it('Two Messages V1', async function () {
      await submitTx(
        () => batchTransfer.A.send2MessagesV1(
          randomMessages[0],
          randomMessages[1],
          privacyNodes.B.chainId,
          resourceId,
          { gasLimit: GAS_LIMIT }
        ),
        `Sending messages V1...`
      );

      await eventually<boolean>({
        check: async () => {
          const messageA = await batchTransfer.B.messageA();
          const messageB = await batchTransfer.B.messageB();

          return messageA === randomMessages[0] && messageB === randomMessages[1];
        },
        message: `Checking messages`,
      });
    }).timeout(DEFAULT_TIMEOUT);

    it('Two Messages V2', async function () {
      await submitTx(
        () => batchTransfer.A.send2MessagesV2(randomMessages[2], randomMessages[3], [
          {
            _dstChainId: privacyNodes.B.chainId,
            _resourceId: resourceId,
            _payload: ethers.id('')
          },
          {
            _dstChainId: privacyNodes.B.chainId,
            _resourceId: resourceId,
            _payload: ethers.id('')
          }
        ]),
        `Sending messages V2...`
      );


      await eventually<boolean>({
        check: async () => {
          const messageA = await batchTransfer.B.messageA();
          const messageB = await batchTransfer.B.messageB();

          return messageA == randomMessages[2] && messageB == randomMessages[3];
        },
        message: `Checking messages`,
      });
    }).timeout(DEFAULT_TIMEOUT);

    it('Two Messages V3', async function () {
      await submitTx(
        () => batchTransfer.A.send2MessagesV3(randomMessages[4], randomMessages[5], [
          {
            _dstChainId: privacyNodes.B.chainId,
            _resourceId: resourceId,
            _payload: ethers.id('')
          },
          {
            _dstChainId: privacyNodes.B.chainId,
            _resourceId: resourceId,
            _payload: ethers.id('')
          }
        ]),
        `Sending messages V3...`
      );

      await eventually<boolean>({
        check: async () => {
          const messageA = await batchTransfer.B.messageA();
          const messageB = await batchTransfer.B.messageB();
          return messageA === randomMessages[4] && messageB === randomMessages[5];
        },
        message: `Checking messages`,
      })
    }).timeout(DEFAULT_TIMEOUT);

    it('Two Messages V4', async function () {
      const hardhatPayloadA = encodeFunctionCall({
        signature: 'receiveMessageA(string)',
        argumentTypes: ['string'],
        arguments: [randomMessages[6]]
      });

      const hardhatPayloadB = encodeFunctionCall({
        signature: 'receiveMessageB(string)',
        argumentTypes: ['string'],
        arguments: [randomMessages[7]]
      });

      await submitTx(
        () => batchTransfer.A.send2MessagesV4([
          {
            _dstChainId: privacyNodes.B.chainId,
            _resourceId: resourceId,
            _payload: hardhatPayloadA
          },
          {
            _dstChainId: privacyNodes.B.chainId,
            _resourceId: resourceId,
            _payload: hardhatPayloadB
          }
        ]),
        `Sending messages V4...`
      );

      await eventually<boolean>({
        check: async () => {
          const messageA = await batchTransfer.B.messageA();
          const messageB = await batchTransfer.B.messageB();
          return messageA === randomMessages[6] && messageB === randomMessages[7];
        },
        message: `Checking messages`,
      });
    }).timeout(DEFAULT_TIMEOUT);

    it('Two Messages V5', async function () {
      const hardhatPayloadA = encodeFunctionCall({
        signature: 'receiveMessageA(string)',
        argumentTypes: ['string'],
        arguments: [randomMessages[8]]
      });
      const hardhatPayloadB = encodeFunctionCall({
        signature: 'receiveMessageB(string)',
        argumentTypes: ['string'],
        arguments: [randomMessages[9]]
      });

      await submitTx(
        () => batchTransfer.A.send2MessagesV5([
          {
            _dstChainId: privacyNodes.B.chainId,
            _resourceId: resourceId,
            _payload: hardhatPayloadA
          },
          {
            _dstChainId: privacyNodes.B.chainId,
            _resourceId: resourceId,
            _payload: hardhatPayloadB
          }
        ]),
        `Sending messages V5...`
      );

      await eventually<boolean>({
        check: async () => {
          const messageA = await batchTransfer.B.messageA();
          const messageB = await batchTransfer.B.messageB();
          return messageA === randomMessages[8] && messageB === randomMessages[9];
        },
        message: `Checking messages`,
      });
    }).timeout(DEFAULT_TIMEOUT);

    it('Many Messages', async function () {
      const messages = randomMessages.slice(10, 60);

      const payloads = messages.map((message) => encodeFunctionCall({
        signature: 'receiveMessage(string)',
        argumentTypes: ['string'],
        arguments: [message]
      }));

      await submitTx(
        () => batchTransfer.A.sendManyMessages(
          payloads.map((payload) => ({
            _dstChainId: privacyNodes.B.chainId,
            _resourceId: resourceId,
            _payload: payload
          }))
        ),
        `Sending many messages...`
      );

      await eventually<boolean>({
        check: async () => {
          const messagesReceived = await batchTransfer.B.getMessages();
          return JSON.stringify([...messages].sort()) === JSON.stringify([...messagesReceived].sort());
        },
        message: `Checking messages`,
      });
    }).timeout(50 * DEFAULT_TIMEOUT);
  });
});