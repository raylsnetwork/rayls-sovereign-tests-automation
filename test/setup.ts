// Global setup for tests - configures Chai to handle BigInt comparisons
import { use } from 'chai';

function bigIntPlugin(chai: any) {
  const Assertion = chai.Assertion;

  Assertion.overwriteMethod('equal', function (_super: any) {
    return function (this: any, expected: any) {
      const actual = this._obj;

      if (typeof actual === 'bigint' || typeof expected === 'bigint') {
        try {
          const actualBigInt = BigInt(actual);
          const expectedBigInt = BigInt(expected);
          this.assert(
            actualBigInt === expectedBigInt,
            'expected #{act} to equal #{exp}',
            'expected #{act} to not equal #{exp}',
            String(expected), // Show original values in error message
            String(actual),
            true
          );
        } catch (error) {
          // If conversion to BigInt fails, fallback to original 'equal'
          _super.apply(this, arguments);
        }
      } else {
        _super.apply(this, arguments);
      }
    };
  });
}

use(bigIntPlugin);


// ==========================================================
// Standardized PN/PNH setup helpers for E2E tests
// ==========================================================
import { PrivateHub } from '../src/entities/PrivateHub';
import { PrivacyNode } from '../src/entities/PrivacyNode';
import { PrivacyNodeManager } from '../src/entities/PrivacyNodeManager';
import { ParticipantStorageReplicaV1__factory } from '../typechain-types';
import { eventually } from '../src/utils/common';
import { ZERO_ADDRESS } from '../src/config/env-config';

export type PrivacyNodeMap = { [key: string]: PrivacyNode };

export type StandardSetup = {
  initializedNodes: PrivacyNodeMap;
  initializedPNH: PrivateHub;
};

// ParticipantStorage's resourceId is fixed (Constants.RESOURCE_ID_PARTICIPANT_STORAGE = 0x..01).
const PARTICIPANT_STORAGE_RESOURCE_ID =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const PARTICIPANT_PROPAGATION_POLL_INTERVAL_MS = 2_000;
const PARTICIPANT_PROPAGATION_MAX_ATTEMPTS = 60; // 2 minutes total

/**
 * Wait until each PN's `ParticipantStorageReplicaV1` has all expected chainIds in
 * ACTIVE status. The PNH-side `AddParticipant*` admin tx returns immediately, but
 * propagation to PN replicas is async (PNH → relayer → NATS → relayer → PN). E2E
 * tests that cross-chain send/teleport revert with
 * `ParticipantStorageReplicaV1__ParticipantNotRegistered(<chainId>)` if they fire
 * before propagation finishes — a timing race against startup, not a contract bug.
 *
 * This helper resolves the race: polling every replica until every expected chainId
 * is present and ACTIVE. Cheap when already propagated (one read per node).
 */
export async function waitForParticipantsOnReplicas(privacyNodes: PrivacyNodeMap): Promise<void> {
  const expectedChainIds = Object.values(privacyNodes).map(n => BigInt(n.chainId));
  const ACTIVE_STATUS = 1n; // ParticipantStructs.Status.ACTIVE

  await eventually<boolean>({
    check: async () => {
      for (const node of Object.values(privacyNodes)) {
        const replicaAddr = await node
          .getEndpointV1()
          .getAddressByResourceId(PARTICIPANT_STORAGE_RESOURCE_ID);
        if (replicaAddr === ZERO_ADDRESS) return false;

        const replica = ParticipantStorageReplicaV1__factory.connect(replicaAddr, node.provider);
        const participants = await replica.getAllParticipants();

        for (const expected of expectedChainIds) {
          const p = participants.find(pp => pp.chainId === expected);
          if (!p || p.status !== ACTIVE_STATUS) return false;
        }
      }
      return true;
    },
    interval: PARTICIPANT_PROPAGATION_POLL_INTERVAL_MS,
    attempts: PARTICIPANT_PROPAGATION_MAX_ATTEMPTS,
    message: `Waiting for participants [${expectedChainIds.join(',')}] → ACTIVE on all PN replicas`,
  });
}

// Build and initialize PrivacyNode instances.
// All workers see all nodes — parallelism is achieved by splitting test files.
// PN nonce contention is handled by sendTx() retry; PNH contention by submitTx() retry.
export async function initializePrivacyNodes(nodeCount: number): Promise<PrivacyNodeMap> {
  const activeParticipants = PrivacyNodeManager.getActiveNodes();
  if (activeParticipants.length < nodeCount) {
    throw new Error(`Not enough active nodes => current ${activeParticipants.length} / required ${nodeCount}`);
  }

  const privacyNodes: PrivacyNodeMap = {} as any;

  for (const pid of activeParticipants.slice(0, nodeCount)) {
    privacyNodes[pid] = await PrivacyNode.getInstance(pid);
  }

  // Grant PRIVACY_NODE_OPERATOR first (admin-of BANK_EMPLOYEE), then BANK_EMPLOYEE (granted by PRIVACY_NODE_OPERATOR)
  await Promise.all(
    Object.values(privacyNodes).map(async node => {
      await node.grantOperatorRole();      // requires ADMIN
      await node.grantBankEmployeeRole();  // requires PRIVACY_NODE_OPERATOR (granted above)
    })
  );

  return privacyNodes;
}

// Uses singleton pattern — subsequent calls return cached instance
export async function initializePrivateHub(): Promise<PrivateHub> {
  return await PrivateHub.getInstance();
}

// Convenience one-call setup for tests
export async function initializePrivacyNodesAndPnh(nodesCount : number): Promise<StandardSetup> {
  const privacyNodes : PrivacyNodeMap = await initializePrivacyNodes(nodesCount);

  // Block until participant data has propagated from PNH to every PN replica.
  // Hub-oriented suites need this readiness gate; PN-local suites that call
  // initializePrivacyNodes directly (e.g. public-chain teleport) don't touch the
  // private-mesh participant registry, so the wait lives here in the PNH bootstrap.
  // Cheap when already propagated (one read per node on a warm env).
  await waitForParticipantsOnReplicas(privacyNodes);

  const privateHub = await initializePrivateHub();

  // PNH: PRIVATE_NETWORK_OPERATOR first (admin-of COMPLIANCE_OFFICER), then COMPLIANCE_OFFICER
  await privateHub.grantNetworkOperatorRole();  // requires ADMIN
  await privateHub.grantComplianceRole();       // requires PRIVATE_NETWORK_OPERATOR (just granted above)

  return { initializedNodes: privacyNodes, initializedPNH : privateHub };
}
