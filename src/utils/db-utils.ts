import { query, queryOne } from './pg-client';
import { CLEAN_ENYGMA_DB_BEFORE_TESTS, DB_CONNECTION, LOGGER, RAYLS_NODES, USE_DB_CHECKS } from '../config/env-config';
import { PrivateHub } from '../entities/PrivateHub';
import { PrivacyNode } from '../entities/PrivacyNode';
import { EnygmaWrapper } from '../entities/tokens/EnygmaWrapper';
import { EnygmaV1 } from '../../typechain-types';
import { BaseContract } from 'ethers';
import { expect } from 'chai';
import { eventually } from './common';
import { waitForNumberOfBlocks } from './network-utils';

export async function cleanEnygmaDb() {
  if (!CLEAN_ENYGMA_DB_BEFORE_TESTS) {
    LOGGER.info(`CLEAN_ENYGMA_DB_BEFORE_TESTS not set. Skipping DB cleaning.`);
    return;
  }
  for (const node of RAYLS_NODES) {
    const cs = DB_CONNECTION[node];
    if (!cs) {
      LOGGER.error(`Skipping cleaning for Node ${node} because connection string is missing`);
      continue;
    }
    try {
      const enygmaResult = await query(cs, 'DELETE FROM enygma');
      LOGGER.log(`Cleaned ${enygmaResult.rowCount} rows from enygma table for Node ${node}`);

      const enygmaHistoryResult = await query(cs, 'DELETE FROM enygma_history');
      LOGGER.log(`Cleaned ${enygmaHistoryResult.rowCount} rows from enygma_history table for Node ${node}`);
    } catch (error) {
      LOGGER.error(`Error cleaning DB for Node ${node}: ${error}`);
      throw error;
    }
  }
}

export async function checkDbBalance<T extends BaseContract>(
  expectedBalance: number,
  privateHub: PrivateHub,
  privacyNode: PrivacyNode,
  enygma: EnygmaWrapper<T>
) {
  if (!USE_DB_CHECKS) {
    LOGGER.info(`USE_DB_CHECKS not set. Skipping DB checks.`);
    return;
  }
  await eventually<boolean>({
    check: async () => {
      const enygmaRow = await privacyNode.getEnygmaByResourceId(enygma.resourceId);
      if (!enygmaRow) return false;

      return Number(enygmaRow.finalized_balance) === expectedBalance;
    },
    message: `Checking ${enygma.symbol} R in DB (chain=${privacyNode.chainId})`,
  });

  await eventually<boolean>({
    check: async () => {
      const balanceFromEnygma = await privateHub
        .getPNHContract<EnygmaV1>(enygma.symbol)
        .getBalanceFinalised(BigInt(privacyNode.chainId));

      if (balanceFromEnygma[0] == BigInt(0)) return false;

      const enygmaRow = await privacyNode.getEnygmaByResourceId(enygma.resourceId);

      if (!enygmaRow) return false;

      const r = enygmaRow.finalized_r;

      const pedersenCommitment = await privateHub
        .getPNHContract<EnygmaV1>(enygma.symbol)
        .pedCom(BigInt(expectedBalance), BigInt(r));

      return balanceFromEnygma[0] === pedersenCommitment[0] && balanceFromEnygma[1] === pedersenCommitment[1];
    },
    message: `Checking ${enygma.symbol} Pedersen commitments (chain=${privacyNode.chainId})`,
  });
}

export async function getDvpDepositByNodeConnectionString(node: string, commitmentStr?: string): Promise<any> {
  const cs = DB_CONNECTION[node];

  if (commitmentStr !== undefined) {
    return await queryOne(cs, 'SELECT * FROM dvp_deposits WHERE commitment = $1 LIMIT 1', [commitmentStr]);
  } else {
    const result = await query(cs, 'SELECT * FROM dvp_deposits');
    return result.rows;
  }
}

/** Relayer deposit status enum — mirrors types.DvpDepositStatus in the relayer. */
export const DvpDepositStatus = {
  Pending: 0,
  Unspent: 1,
  Locked: 2,
  Spent: 3,
} as const;

/**
 * Polls the relayer's dvp_deposits table until the deposit
 * for the given NFT reaches status = Unspent (confirmed by relayer).
 * The relayer stores the CC-side token address, not the PL-side address.
 */
export async function waitForDvpDepositConfirmed(
  connectionString: string,
  tokenAddress: string,
  tokenId: string,
): Promise<void> {
  await eventually<boolean>({
    check: async () => {
      const deposit = await queryOne(
        connectionString,
        `SELECT 1 FROM dvp_deposits
         WHERE token_id = $1 AND token_address = $2 AND status = $3
         LIMIT 1`,
        [tokenId, tokenAddress, DvpDepositStatus.Unspent],
      );
      return deposit !== null;
    },
    message: `Waiting for relayer deposit confirmation (token_id=${tokenId}, status=Unspent)`,
  });
}

export async function shouldChangeDBAndSystemWillRecover<T extends BaseContract>(
  enygma: EnygmaWrapper<T>,
  destination: PrivacyNode,
  privateHub: PrivateHub
) {
  await waitForNumberOfBlocks(10, privateHub.provider);

  const cs = destination.db.connection;
  const resourceId = enygma.resourceId.replace(/^0x/, '');

  // This tests the resync mechanism in the receiver assuming a current state (event_type, blockNumber, balance_change, r_factor) of the type:
  // (0, N, 0, 0) //creation
  // (3, N, 0, r1) //finalization tx of creation
  // (3, N', 10, r2) //real tx of 10 with N' > N
  // (3, N'', 0, r3) // finalization tx of previous tx with N'' > N' > N

  // Get the earliest history entry with event_type 0
  const earliestHistory = await queryOne(
    cs,
    `SELECT * FROM enygma_history
     WHERE resource_id = $1 AND event_type = 0
     ORDER BY block_number_private_hub ASC
     LIMIT 1`,
    [resourceId]
  );

  if (!earliestHistory || !earliestHistory.block_number_private_hub) {
    throw new Error('No history found with event_type 0 or block_number_private_hub is missing');
  }

  const revertToBlock = earliestHistory.block_number_private_hub;
  LOGGER.log('Reverting to block:', revertToBlock);

  // Get the entry with the same block_number_private_hub but event_type 3
  // This is the finalization tx of the creation event.
  const nextHistory = await queryOne(
    cs,
    `SELECT * FROM enygma_history
     WHERE resource_id = $1 AND block_number_private_hub = $2 AND event_type = 3
     LIMIT 1`,
    [resourceId, revertToBlock]
  );

  if (!nextHistory) {
    throw new Error('No history entry found with event_type 3 at block ' + revertToBlock);
  }

  // Extract the balance_change and r_factor from the event_type 3 entry
  // This will give us the state for the creation blockNumber
  const revertBalance = nextHistory.balance_change;
  const revertRFactor = nextHistory.r_factor;

  LOGGER.log(
    `Using event_type 3 entry - block: ${nextHistory.block_number_private_hub}, ` +
    `balance: ${revertBalance}, r_factor: ${revertRFactor.substring(0, 20)}...`
  );

  // Update Enygma to the revert state using values from the event_type 3 entry
  const updateEnygmaResult = await query(
    cs,
    `UPDATE enygma
     SET finalized_r = $1, finalized_balance = $2, finalized_block_number = $3
     WHERE resource_id = $4`,
    [revertRFactor, revertBalance, revertToBlock, resourceId]
  );
  LOGGER.log(`Reverted enygma to block ${revertToBlock} state -> ${updateEnygmaResult.rowCount}`);

  // Delete history AFTER the revert block
  const deleteHistorys = await query(
    cs,
    `DELETE FROM enygma_history
     WHERE resource_id = $1 AND block_number_private_hub > $2`,
    [resourceId, revertToBlock]
  );
  LOGGER.log(`Deleted history after block ${revertToBlock} -> ${deleteHistorys.rowCount}`);

  // Set checkpoints AFTER the revert block to status 0 (unprocessed)
  const checkPointsUpdates = await query(
    cs,
    `UPDATE enygma_checkpoints
     SET status = 0
     WHERE resource_id = $1 AND finalized_block_number > $2`,
    [resourceId, revertToBlock]
  );
  LOGGER.log(`Set checkpoints after block ${revertToBlock} to status 0 -> ${checkPointsUpdates.rowCount}`);

  // Wait for resync
  await waitForNumberOfBlocks(20, privateHub.provider);

  // Verify the system has resynced properly
  const lastFinalizedCheckpoint = await queryOne(
    cs,
    `SELECT * FROM enygma_checkpoints
     WHERE resource_id = $1 AND status = 1
     ORDER BY updated_at DESC
     LIMIT 1`,
    [resourceId]
  );

  const totalHistoryResult = await queryOne<{ count: string }>(
    cs,
    `SELECT COUNT(*) as count FROM enygma_history WHERE resource_id = $1`,
    [resourceId]
  );
  const totalHistoryCount = parseInt(totalHistoryResult?.count ?? '0', 10);

  // Check that we have history entries after the revert block (showing resync worked)
  const historyAfterRevertResult = await queryOne<{ count: string }>(
    cs,
    `SELECT COUNT(*) as count FROM enygma_history
     WHERE resource_id = $1 AND block_number_private_hub > $2`,
    [resourceId, revertToBlock]
  );
  const historyAfterRevert = parseInt(historyAfterRevertResult?.count ?? '0', 10);

  expect(totalHistoryCount > 0, 'EnygmaHistory is not resynced').to.be.true;
  expect(lastFinalizedCheckpoint != null, 'No checkpoint with status 1').to.be.true;
  expect(historyAfterRevert > 0, 'No history recreated after revert block').to.be.true;
}