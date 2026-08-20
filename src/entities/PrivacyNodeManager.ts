import { CHAIN_ID, LOGGER, PARTICIPANTS, RPC_URL, RAYLS_NODES } from '../config/env-config';

export interface TransferScenario {
  from: number;
  to: number;
  tag: string;
  participants: string[];
}

export class PrivacyNodeManager {
  // Memoized: PARTICIPANTS / CHAIN_ID / RPC_URL are env-driven and immutable per process.
  private static activeNodesCache: string[] | undefined;

  /**
   * Get active participants based on the PARTICIPANTS environment variable
   * Maps chain IDs back to participant letters (A, B, C, D, E, F)
   */
  static getActiveNodes(): string[] {
    if (PrivacyNodeManager.activeNodesCache !== undefined) {
      return PrivacyNodeManager.activeNodesCache;
    }

    const participants = PARTICIPANTS;
    if (!participants) {
      throw new Error('PARTICIPANTS environment variable not set');
    }

    const activeChainIds = participants.split(',').map(id => id.trim());

    // Map chain IDs back to participant letters
    PrivacyNodeManager.activeNodesCache = RAYLS_NODES.filter(node => {
      const chainId = CHAIN_ID[node];
      return (
        activeChainIds.includes(chainId) &&
        RPC_URL[node]
      );
    });
    return PrivacyNodeManager.activeNodesCache;
  }

  /**
   * Generate valid transfer scenarios based on the number of active participants
   * Each scenario includes the source and destination counts, tags, and required participants
   */
  static getValidTransferScenarios(activeNodes: string[]): TransferScenario[] {
    const participantCount = activeNodes.length;
    const scenarios: TransferScenario[] = [];

    // 1->1 transfers (requires 2+ participants)
    if (participantCount >= 2) {
      scenarios.push({
        from: 1,
        to: 1,
        tag: '@1to1 @smoke @enygma',
        participants: activeNodes.slice(0, 2),
      });
    }else {
      throw new Error('At least 2 participants required for transfer tests');
    }

    // 1->2 transfers (requires 3+ participants)
    if (participantCount >= 3) {
      scenarios.push({
        from: 1,
        to: 2,
        tag: '@1to2 @regression @enygma',
        participants: activeNodes.slice(0, 3),
      });
    }

    // 1->3 transfers (requires 4+ participants)
    if (participantCount >= 4) {
      scenarios.push({
        from: 1,
        to: 3,
        tag: '@1to3 @regression @enygma',
        participants: activeNodes.slice(0, 4),
      });
    }

    // 1->4 transfers (requires 5+ participants)
    if (participantCount >= 5) {
      scenarios.push({
        from: 1,
        to: 4,
        tag: '@1to4 @regression @enygma',
        participants: activeNodes.slice(0, 5),
      });
    }

    // 1->5 transfers (requires 6+ participants)
    if (participantCount >= 6) {
      scenarios.push({
        from: 1,
        to: 5,
        tag: '@1to5 @regression @enygma',
        participants: activeNodes.slice(0, 6),
      });
    }

    return scenarios;
  }

  /**
   * Log participant information for debugging
   */
  static logParticipantInfo(): void {
    const activeParticipants = PrivacyNodeManager.getActiveNodes();
    const scenarios = PrivacyNodeManager.getValidTransferScenarios(activeParticipants);

    LOGGER.log('=== Participant Configuration ===');
    LOGGER.log(`PARTICIPANTS environment variable: ${process.env['PARTICIPANTS']}`);
    LOGGER.log(`Active participants: ${activeParticipants.join(', ')} (${activeParticipants.length} total)`);
    LOGGER.log('Available scenarios:');
    scenarios.forEach(scenario => {
      LOGGER.log(`  - ${scenario.from}->${scenario.to}: ${scenario.participants.join(' -> ')} ${scenario.tag}`);
    });
    LOGGER.log('================================');
  }
}
