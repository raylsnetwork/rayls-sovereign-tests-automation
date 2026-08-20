import { PrivacyNodeManager } from '../../../../src/entities/PrivacyNodeManager';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
} from '../../../../typechain-types';
import {
  executeRepeatedBatchTransactions,
  executeVariableAmountBatchTransaction,
  executeAccumulatedBatchTransactions
} from '../../../test-utils/batch-transactions-helpers';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { DEFAULT_TIMEOUT, LOGGER } from '../../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';

describe('EnygmaWrapper Batch Transaction Scenarios @smoke @enygma @batch', function () {
  const activeParticipants = PrivacyNodeManager.getActiveNodes();
  const earlyValidScenarios = PrivacyNodeManager.getValidTransferScenarios(activeParticipants);
  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let enygmaToken: EnygmaWrapper<ProductionEnygmaToken>;

  const MINT_AMOUNT = BigInt(5000); //Enough to allow sequential test execution

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT*2);
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(activeParticipants.length);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    // Setup token
    enygmaToken = new EnygmaWrapper(privacyNodes[activeParticipants[0]],ProductionEnygmaToken__factory);
    const signerAddress = enygmaToken.userWallet.address;
    // New token-registry flow: node-factory deploy as user (seeded codehash clears the
    // programmability gate), then PN-authorize + hub-activate.
    await enygmaToken.deployViaFactory();
    await enygmaToken.activateOnPn();
    await enygmaToken.activateOnHub(privateHub);
    await enygmaToken.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: signerAddress });
    });


  earlyValidScenarios.forEach(scenario => {
          const { from, to, tag, participants: scenarioParticipants } = scenario;

          it(`Should send 2 batch transactions of ${from}->${to} with same amounts ${tag}`, async function () {
            this.timeout(DEFAULT_TIMEOUT);
            const sourceParticipant = scenarioParticipants[0];
            const destinationParticipants = scenarioParticipants.slice(1, to + 1);

            LOGGER.log(`Executing 2 batch ${from}->${to} transfer: ${sourceParticipant} -> [${destinationParticipants.join(', ')}]`);

            await executeRepeatedBatchTransactions(sourceParticipant, destinationParticipants, privacyNodes, enygmaToken);

            LOGGER.log(`2 batch ${from}->${to} transfer completed successfully`);
          });

          it(`Should send 1 batch transaction of ${from}->${to} with different amounts ${tag}`, async function () {
            this.timeout(DEFAULT_TIMEOUT);
            const sourceParticipant = scenarioParticipants[0];
            const destinationParticipants = scenarioParticipants.slice(1, to + 1);

            LOGGER.log(`Executing variable amounts batch ${from}->${to} transfer: ${sourceParticipant} -> [${destinationParticipants.join(', ')}]`);

            await executeVariableAmountBatchTransaction(sourceParticipant, destinationParticipants, privacyNodes, enygmaToken);

            LOGGER.log(`Variable amounts batch ${from}->${to} transfer completed successfully`);
          });

          it(`Should send 3 batch transactions of ${from}->${to} with accumulation ${tag}`, async function () {
            this.timeout(DEFAULT_TIMEOUT);
            const sourceParticipant = scenarioParticipants[0];
            const destinationParticipants = scenarioParticipants.slice(1, to + 1);

            LOGGER.log(`Executing 3 accumulated batch ${from}->${to} transfers: ${sourceParticipant} -> [${destinationParticipants.join(', ')}]`);

            await executeAccumulatedBatchTransactions(sourceParticipant, destinationParticipants, privacyNodes, enygmaToken);

            LOGGER.log(`3 accumulated batch ${from}->${to} transfers completed successfully`);
          });
        });
});
