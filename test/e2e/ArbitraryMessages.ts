import { ArbitraryMessage, ArbitraryMessage__factory, EndpointV1 } from '../../typechain-types';
import { generateRandomHash } from '../test-utils/helpers';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../setup';
import { PrivateHub } from '../../src/entities/PrivateHub';
import { eventually, submitTx } from '../../src/utils/common';
import { DEFAULT_TIMEOUT, GAS_LIMIT } from '../../src/config/env-config';
import { createUserOperator } from '../../src/utils/wallet-factory';

describe('E2E Tests: Arbitrary Messages', function () {
  const AMOUNT_OF_TESTS = 60;

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  const arbitraryMessage: { [NODE: string]: ArbitraryMessage } = {};
  const randomMessages = [...Array(100)].map(() => generateRandomHash());

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const resourceId = generateRandomHash();
    const {initializedNodes, initializedPNH} = await initializePrivacyNodesAndPnh(4);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    for (const pl of Object.keys(privacyNodes)) {
      const deployer = createUserOperator(privacyNodes[pl].provider);
      const factory = await privacyNodes[pl].contractStore.getFactory<ArbitraryMessage__factory>(ArbitraryMessage__factory, deployer);

      // Deploy the contract (no restricted calls in constructor)
      await privacyNodes[pl].contractStore.deploy(
        factory,
        'ArbitraryMessage',
        resourceId,
        privacyNodes[pl].endpointAddress,
        privacyNodes[pl].raylsNodeEndpointAddress
      );

      const contract = privacyNodes[pl].getContract<ArbitraryMessage>('ArbitraryMessage');
      const contractAddress = await contract.getAddress();

      // Post-deployment setup (admin responsibilities):
      // 1. Register resourceId→contract mapping so Endpoint can route messages (RESOURCE_REGISTRAR)
      // 2. Grant ENDPOINT_SENDER so the contract can call endpoint.send()
      const endpoint = privacyNodes[pl].getContract<EndpointV1>('EndpointV1');
      const endpointAsAdmin = endpoint.connect(privacyNodes[pl].adminWallet) as typeof endpoint;
      await (await endpointAsAdmin.registerResourceId(resourceId, contractAddress)).wait();
      await privacyNodes[pl].grantEndpointSender([contractAddress]);

      arbitraryMessage[pl] = contract;
    }
  });

  describe('Feature check', function () {
    it('Should send 1 message', async function () {
      await submitTx(
        () => arbitraryMessage.A.send1Message(
          randomMessages[0],
          privacyNodes.B.chainId,
          { gasLimit: GAS_LIMIT }
        ),
        `Sending 1 message...`
      );

      await eventually<boolean>({
        check: async () => {
          const message = await arbitraryMessage.B.msgA();

          return message === randomMessages[0];
        },
        message: `Checking message`,
      });
    }).timeout(DEFAULT_TIMEOUT);

    it('Should send 3 messages', async function () {
      await submitTx(
        () => arbitraryMessage.A.send3Messages(
          randomMessages[1],
          randomMessages[2],
          randomMessages[3],
          privacyNodes.B.chainId,
          { gasLimit: GAS_LIMIT }
        ),
        `Sending 3 messages...`
      );

      await eventually<boolean>({
        check: async () => {
          const message = await arbitraryMessage.B.msgB();
          return message === randomMessages[1];
        },
        message: `Checking message B`,
      });
      await eventually<boolean>({
        check: async () => {
          const message = await arbitraryMessage.B.msgC();
          return message === randomMessages[2];
        },
        message: `Checking message C`,
      });
      await eventually<boolean>({
        check: async () => {
          const message = await arbitraryMessage.B.msgD();

          return message === randomMessages[3];
        },
        message: `Checking message D`,
      });
    }).timeout(DEFAULT_TIMEOUT);

    it('Should send multiple messages to multiple participants', async function () {
      await submitTx(
        () => arbitraryMessage.A.send3MessagesToDifferentChainIds(
          randomMessages[4],
          randomMessages[5],
          randomMessages[6],
          privacyNodes.B.chainId,
          privacyNodes.C.chainId,
          privacyNodes.D.chainId,
          { gasLimit: GAS_LIMIT }
        ),
        `Sending multiple messages to multiple participants...`
      );

      await eventually<boolean>({
        check: async () => {
          const message = await arbitraryMessage.B.msgB();

          return message === randomMessages[4];
        },
        message: `Checking msgB on PN B`,
      });
      await eventually<boolean>({
        check: async () => {
          const message = await arbitraryMessage.C.msgC();

          return message === randomMessages[5];
        },
        message: `Checking msgC on PN C`,
      });
      await eventually<boolean>({
        check: async () => {
          const message = await arbitraryMessage.D.msgD();

          return message === randomMessages[6];
        },
        message: `Checking msgD on PN D`,
      });
    }).timeout(DEFAULT_TIMEOUT);

    it('Should send same message to multiple participants', async function () {
      const chainIds = [privacyNodes.B.chainId, privacyNodes.C.chainId, privacyNodes.D.chainId];

      await submitTx(
        () => arbitraryMessage.A.sendToMultipleParticipants(
          randomMessages[7],
          chainIds,
          { gasLimit: GAS_LIMIT }
        ),
        `Sending message to multiple participants...`
      );

      await eventually<boolean>({
        check: async () => {
          const message = await arbitraryMessage.B.multiple();

          return message === randomMessages[7];
        },
        message: `Checking PN B`,
      });
      await eventually<boolean>({
        check: async () => {
          const message = await arbitraryMessage.C.multiple();

          return message === randomMessages[7];
        },
        message: `Checking PN C`,
      });
      await eventually<boolean>({
        check: async () => {
          const message = await arbitraryMessage.D.multiple();

          return message === randomMessages[7];
        },
        message: `Checking PN D`,
      });
    }).timeout(DEFAULT_TIMEOUT);

    it('Should send same message to all participants', async function () {
      await submitTx(
        () => arbitraryMessage.A.sendToAllParticipants(
          randomMessages[8],
          { gasLimit: GAS_LIMIT }
        ),
        `Sending message to all participants...`
      );

      await eventually<boolean>({
        check: async () => {
          const message = await arbitraryMessage.B.all();

          return message === randomMessages[8];
        },
        message: `Checking PN B`,
      });
      await eventually<boolean>({
        check: async () => {
          const message = await arbitraryMessage.C.all();

          return message === randomMessages[8];
        },
        message: `Checking PN C`,
      });
      await eventually<boolean>({
        check: async () => {
          const message = await arbitraryMessage.D.all();

          return message === randomMessages[8];
        },
        message: `Checking PN D`,
      });
    }).timeout(DEFAULT_TIMEOUT);

    it('Should send 1 message with metadata', async function () {
      const destinationAddress = await arbitraryMessage.B.getAddress();

      await submitTx(
        () => arbitraryMessage.A.send1MessageWithMetadata(
          randomMessages[9],
          privacyNodes.B.chainId,
          destinationAddress,
          { gasLimit: GAS_LIMIT }
        ),
        `Sending message with metadata...`
      );

      await eventually<boolean>({
        check: async () => {
          const message = await arbitraryMessage.B.msgA();

          return message === randomMessages[9];
        },
        message: `Checking message`,
      });
    }).timeout(DEFAULT_TIMEOUT);
  });

  describe('Performance check', function () {
    it(`Should send ${AMOUNT_OF_TESTS} messages`, async function () {
      for (let test = 1; test <= AMOUNT_OF_TESTS; test++) {
        await submitTx(
          () => arbitraryMessage.A.send1IncreaseCount(
            privacyNodes.B.chainId,
            { gasLimit: GAS_LIMIT }
          ),
          `Sending message ${test}...`
        );
      }

      await eventually<boolean>({
        check: async () => {
          const count = await arbitraryMessage.B.count();

          return count === BigInt(AMOUNT_OF_TESTS);
        },
        message: `Checking count`,
      });
    }).timeout(AMOUNT_OF_TESTS * DEFAULT_TIMEOUT);
  });

});
