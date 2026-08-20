import { PrivacyNodeManager } from '../../../../src/entities/PrivacyNodeManager';
import { ProductionEnygmaToken, ProductionEnygmaToken__factory } from '../../../../typechain-types';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { DEFAULT_TIMEOUT, LOGGER } from '../../../../src/config/env-config';
import { PrivacyNode } from '../../../../src/entities/PrivacyNode';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { shouldCrossTransferEnygma } from '../../../../src/flows/tokens/token-flows';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';

describe('EnygmaWrapper Transfer Scenarios @smoke @enygma', function () {
  const activeNodes = PrivacyNodeManager.getActiveNodes();
  const validScenarios = PrivacyNodeManager.getValidTransferScenarios(activeNodes);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let enygmaToken: EnygmaWrapper<ProductionEnygmaToken>;
  const MINT_AMOUNT = BigInt(1000);
  const nodeBalances: { [chainId: string]: bigint } = {};

  before(async function(){
    this.timeout(DEFAULT_TIMEOUT);
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(activeNodes.length);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    enygmaToken = new EnygmaWrapper(privacyNodes[activeNodes[0]], ProductionEnygmaToken__factory);
    // New token-registry flow: node-factory deploy as user (seeded codehash clears the
    // programmability gate), then PN-authorize + hub-activate.
    await enygmaToken.deployViaFactory();
    await enygmaToken.activateOnPn();
    await enygmaToken.activateOnHub(privateHub);
    await enygmaToken.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: enygmaToken.userWallet.address });
  })

  // Generate tests dynamically
  // Detect participants tests
  validScenarios.forEach(scenario => {
        const { from, to, tag, participants: scenarioParticipants } = scenario;

        it(`Should transfer from ${from} to ${to} participants ${tag}`, async function () {
          this.timeout(DEFAULT_TIMEOUT);

          const sourceParticipant = scenarioParticipants[0];
          const destinationParticipants = scenarioParticipants.slice(1, to + 1);

          LOGGER.log(
            `Executing ${from}->${to} transfer: ${sourceParticipant} -> [${destinationParticipants.join(', ')}]`
          );

          await executeTransferScenario(sourceParticipant, destinationParticipants);

          LOGGER.log(`${from}->${to} transfer completed successfully`);
        });
      });

  // Helper function to execute transfer scenarios
  async function executeTransferScenario(sourceKey: string, destinationKeys: string[]) {
    const sourceNode = privacyNodes[sourceKey];
    const destinationNodes = destinationKeys.map(key => privacyNodes[key]);

    // Build standardized transfer payload using existing helpers
    const destinationAddresses = destinationNodes.map(() => enygmaToken.userWallet.address);
    const destinationChainIds = destinationNodes.map(node => node.chainId);
    const amounts = destinationNodes.map((_, index) => BigInt(index + 1)); // [1n, 2n, 3n, ...]
    // Per-recipient programmability steps; `[]` per recipient = a plain transfer.
    const programData: any[] = new Array(destinationNodes.length).fill([]);

    const transfer = {
      destinationAddresses,
      amounts,
      destinationChainIds,
      programData,
    };

    // Expected balances on each destination PN (checked by shouldTransferEnygma)
    const expectedBalances = calculateExpectedBalances(destinationNodes);

    // Use the consolidated flow which handles deployment, waits and verifications
    await shouldCrossTransferEnygma(transfer, 1, expectedBalances, privateHub, sourceNode, destinationNodes, enygmaToken);
  }

  function calculateExpectedBalances(destinationNodes: PrivacyNode[]): { [chainId: string]: bigint } {
    const expectedBalances: { [chainId: string]: bigint } = {};
    destinationNodes.forEach((node, index) => {
      const amount = BigInt(index + 1);
      const currentBalance = nodeBalances[node.chainId] || BigInt(0);
      const newBalance = currentBalance + amount;
      nodeBalances[node.chainId] = newBalance;
      expectedBalances[node.chainId] = newBalance;
    });
    return expectedBalances;
  }
});
