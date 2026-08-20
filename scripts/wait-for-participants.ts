/**
 * Script to verify that participants are registered and synchronized
 * before running E2E tests.
 *
 * Checks:
 * 1. Whether participants are registered in ParticipantStorage
 * 2. Whether view keys have been exchanged between chains
 *
 * Usage: npx ts-node scripts/wait-for-participants.ts
 */

import { ethers } from 'ethers';
import { config } from 'dotenv';
import {
  ParticipantStorageV1__factory,
  DeploymentProxyRegistryV1__factory,
} from '../typechain-types';

config();

// Settings
const MAX_ATTEMPTS = 60; // 60 attempts
const POLL_INTERVAL = 5000; // 5 seconds between attempts
const REQUIRED_PARTICIPANTS = process.env.PARTICIPANTS?.split(',').map(id => id.trim()) || [];

// Log colors
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

function log(message: string, color: string = RESET) {
  const timestamp = new Date().toISOString();
  console.log(`${color}[${timestamp}] ${message}${RESET}`);
}

function logInfo(message: string) { log(message, GREEN); }
function logWarn(message: string) { log(message, YELLOW); }
function logError(message: string) { log(message, RED); }

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  logInfo('=== Checking participants and view keys ===');
  logInfo(`Expected participants: ${REQUIRED_PARTICIPANTS.join(', ')}`);

  // Connect to Commit Chain
  const ccRpcUrl = process.env.PNH_RPC_URL;
  const deploymentProxyAddress = process.env.PNH_DEPLOYMENT_PROXY_REGISTRY;

  if (!ccRpcUrl || !deploymentProxyAddress) {
    logError('PNH_RPC_URL or PNH_DEPLOYMENT_PROXY_REGISTRY not configured');
    process.exit(1);
  }

  logInfo(`Connecting to Commit Chain: ${ccRpcUrl}`);
  const provider = new ethers.JsonRpcProvider(ccRpcUrl);

  // Fetch ParticipantStorage address
  const deploymentRegistry = DeploymentProxyRegistryV1__factory.connect(
    deploymentProxyAddress,
    provider
  );

  let participantStorageAddress: string;
  try {
    participantStorageAddress = await deploymentRegistry.getContract('ParticipantStorage');
    logInfo(`ParticipantStorage found: ${participantStorageAddress}`);
  } catch (error) {
    logError(`Error fetching ParticipantStorage: ${error}`);
    process.exit(1);
  }

  const participantStorage = ParticipantStorageV1__factory.connect(
    participantStorageAddress,
    provider
  );

  // Polling to verify participants
  let attempt = 0;
  let allReady = false;

  while (attempt < MAX_ATTEMPTS && !allReady) {
    attempt++;
    logInfo(`Attempt ${attempt}/${MAX_ATTEMPTS}...`);

    try {
      // Check each participant
      const results: { chainId: string; registered: boolean; hasViewKeys: boolean }[] = [];

      for (const chainId of REQUIRED_PARTICIPANTS) {
        const chainIdBigInt = BigInt(chainId);

        // Check if registered
        const isRegistered = await participantStorage.verifyParticipant(chainIdBigInt);

        // Check if view keys are set (via getChainViewData)
        let hasViewKeys = false;
        try {
          const viewData = await participantStorage.getChainViewData(chainIdBigInt);
          // viewData is an array of PrivateLedgerViewData; check if at least one entry has a raylsViewPublicKey
          hasViewKeys = viewData.length > 0 && viewData.some((entry: { raylsViewPublicKey: string }) => entry.raylsViewPublicKey && entry.raylsViewPublicKey !== '');
        } catch {
          hasViewKeys = false;
        }

        results.push({ chainId, registered: isRegistered, hasViewKeys });

        if (isRegistered && hasViewKeys) {
          logInfo(`  ✓ Chain ${chainId}: registered with view keys`);
        } else if (isRegistered) {
          logWarn(`  ⏳ Chain ${chainId}: registered, waiting for view keys`);
        } else {
          logWarn(`  ⏳ Chain ${chainId}: waiting for registration`);
        }
      }

      // Check if all are ready
      allReady = results.every(r => r.registered && r.hasViewKeys);

      if (allReady) {
        logInfo('');
        logInfo('✓ All participants are registered and synchronized!');

        // Show additional info
        const allChainIds = await participantStorage.getAllParticipantsChainIds();
        logInfo(`Total registered participants: ${allChainIds.length}`);
        logInfo(`Chain IDs: ${allChainIds.map(id => id.toString()).join(', ')}`);

        process.exit(0);
      }

    } catch (error) {
      logWarn(`Verification error: ${error}`);
    }

    if (!allReady && attempt < MAX_ATTEMPTS) {
      logInfo(`Waiting ${POLL_INTERVAL / 1000}s before next attempt...`);
      await delay(POLL_INTERVAL);
    }
  }

  // Timeout
  logError('');
  logError('✗ Timeout! Participants did not become ready in time.');
  logError('Check that relayers are running and synchronizing correctly.');
  process.exit(1);
}

main().catch(error => {
  logError(`Fatal error: ${error}`);
  process.exit(1);
});
