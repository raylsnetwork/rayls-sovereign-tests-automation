import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
} from '../../../../typechain-types';
import { DEFAULT_TIMEOUT, LOGGER } from '../../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { cleanEnygmaDb, shouldChangeDBAndSystemWillRecover } from '../../../../src/utils/db-utils';
import { EnygmaCrossTransfer } from '../../../../src/types';
import { shouldCrossTransferEnygma } from '../../../../src/flows/tokens/token-flows';

describe('E2E Tests: EnygmaWrapper 1->1', function () {
  const MINT_AMOUNT = 1000n;
  const TRANSFER_AMOUNT = 10n;
  let privacyNodes: PrivacyNodeMap;
  let privateHub : PrivateHub;

  let enygmaToken: EnygmaWrapper<ProductionEnygmaToken>;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;
    await cleanEnygmaDb();

    enygmaToken = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
    // New token-registry flow: node-factory deploy as user (seeded codehash clears the
    // programmability gate), then PN-authorize + hub-activate.
    await enygmaToken.deployViaFactory();
    await enygmaToken.activateOnPn();
    await enygmaToken.activateOnHub(privateHub);
    await enygmaToken.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: enygmaToken.userWallet.address });

    LOGGER.log(`Token authorized successfully for endpoint access`);
  });

    it(
      `Should send ${TRANSFER_AMOUNT} tokens to destinations (Transfer #${1})`, async () => {
        const transfer: EnygmaCrossTransfer = {
          destinationAddresses: [enygmaToken.userWallet.address],
          amounts: [TRANSFER_AMOUNT],
          destinationChainIds: [privacyNodes.B.chainId],
          programData: [[]]
        };

        const expectedBalances = {
          [privacyNodes.B.chainId]: TRANSFER_AMOUNT
        };

        const destinations = [privacyNodes.B];

        await shouldCrossTransferEnygma(
        transfer,
        1,
        expectedBalances,
        privateHub,
        privacyNodes.A,
        destinations,
        enygmaToken
      )
    }
    ).timeout(DEFAULT_TIMEOUT);

  //After this, the state IN THE RECEIVER (event_type, blockNubmer, balance_change, r_factor) is of the type:
      // (0, N, 0, 0) //creation
      // (3, N, 0, r1) //finalization tx of creation
      // (3, N', 10, r2) //real tx of 10 with N' > N
      // (3, N'', 0, r3) // finalization tx of previous tx with N'' > N' > N

    it(
    'Should change db and system will recover', async () => {
      await shouldChangeDBAndSystemWillRecover(enygmaToken, privacyNodes.B, privateHub);
    }
  ).timeout(DEFAULT_TIMEOUT);

    it(
      `Should send ${TRANSFER_AMOUNT} tokens to destinations (Transfer #${2})`, async () => {

    const transfer: EnygmaCrossTransfer = {
      destinationAddresses: [enygmaToken.userWallet.address],
      amounts: [TRANSFER_AMOUNT],
      destinationChainIds: [privacyNodes.A.chainId],
      programData: [[]]
    };

    const expectedBalances = {
      [privacyNodes.A.chainId]: MINT_AMOUNT
    };

    const destinations = [privacyNodes.A];

        await shouldCrossTransferEnygma(
        transfer,
        1,
        expectedBalances,
        privateHub,
        privacyNodes.B,
        destinations,
        enygmaToken
      )
      }
    ).timeout(DEFAULT_TIMEOUT);
});
