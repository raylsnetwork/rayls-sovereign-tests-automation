import { expect } from 'chai';
import { LOGGER } from '../../src/config/env-config';
import { EnygmaTokenExample } from '../../typechain-types';
import { generateRandomHash } from '../../src/utils/generators';
import { BigNumberish } from 'ethers';
import { RevertDataTransaction } from '../../src/types';
import { PrivateHub } from '../../src/entities/PrivateHub';
import { eventually } from '../../src/utils/common';
import { shortHex } from '../../src/utils/formatters';
import { waitForNumberOfBlocks } from '../../src/utils/network-utils';
import { getDvpDepositByNodeConnectionString } from '../../src/utils/db-utils';

export enum SwapOrder {
  enygma_nft = 0,
  nft_enygma = 1,
}

export type FunctionCall = {
  signature: string;
  argumentTypes: string[];
  arguments: any[];
};

export { generateRandomHash };
export * from '../e2e/governance-api/governance-assertions';

export async function sendMultipleTransfers(
  totalTxs: number,
  tokenContract: EnygmaTokenExample,
  receiverAddress: string,
  destinationChainId: string,
  amount: BigNumberish
) {
  for (let i = 0; i < totalTxs; i++) {
    LOGGER.log(`Cross transfer ${i}`);
    const tx = await tokenContract.crossTransfer([receiverAddress], [amount], [destinationChainId], [[]], { gasLimit: 5000000 });
    const receipt = await tx.wait();
    expect(receipt?.status).to.be.equal(1);
  }
}


/**
 * DEPRECATED: This helper is no longer used after the E2E refactor.
 *
 * Why it's not used anymore:
 * - The EnygmaWrapper wrapper now performs deposit verification itself inside EnygmaWrapper.depositEnygmaToDvp,
 *   including Merkle/Commitments event checks and optional MongoDB balance verification when
 *   USE_MONGO_DB_CHECKS is enabled.
 * - Tests that previously called this function now rely on the standardized flow, where
 *   depositEnygmaToDvp awaits all required confirmations and invariants before proceeding.
 *
 * Recommended replacement:
 * - Call enygma.depositEnygmaToDvp(...) from the EnygmaWrapper entity. It encapsulates both the on-chain
 *   and optional off-chain (Mongo) validations and waits for them appropriately.
 *
 * Keeping this function for backward compatibility with older tests; avoid using it in new code.
 * @deprecated Use EnygmaWrapper.depositEnygmaToDvp instead.
 */
export async function assertEnygmaDeposit(
  commitChain: PrivateHub,
  useMongoDbChecks: boolean,
  depositAmount: number,
  depositorAddress: string,
  chainKey: string,
  dvpAddress: string
) {
  LOGGER.optionalLog(`🛠️ Checking if the deposit was inserted into onchain Merkle tree`);

  //const providerCC = signerCC.provider as Provider;
  await waitForNumberOfBlocks(3, commitChain.provider);

  try {
    // Get the Dvp contract instance
    const dvp = await commitChain.getContractAt('Dvp', dvpAddress, 'Dvp');

    // Variable to store commitment value from the event
    let commitmentFromEvent: string | undefined = undefined;

    // Verify the commitment was added to the Merkle tree
    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        // Check for Commitments events
        const TREE_ID_ENYGMA = 3; // From Dvp contract
        const commitmentsFilter = dvp.filters.Commitments(TREE_ID_ENYGMA);

        const blockNumber = await commitChain.provider.getBlockNumber();
        if (!blockNumber) {
          LOGGER.optionalLog(`Failed to get block number`);
          return false;
        }

        const logs = await dvp.queryFilter(commitmentsFilter, Math.max(0, blockNumber - 1000), blockNumber);

        if (logs.length === 0) {
          LOGGER.optionalLog(`No Commitments events found`);
          return false;
        }

        /*
            // The last event should contain our commitment
            const lastEvent = logs[logs.length - 1];
            lastEvent.
            LogForTest(`Found Commitments event: Tree ID: ${lastEvent.args[0]}, Tree Number: ${lastEvent.args[1]}`);

            // Make sure args[2] exists and has at least one element
            if (lastEvent.args[2] && lastEvent.args[2].length > 0) {
                commitmentFromEvent = lastEvent.args[2][0].toString();
                LogForTest(`HashCommitment registered: ${commitmentFromEvent}`);
            } else {
                LogForTest(`Event doesn't contain commitment data`);
                return false;
            }
            */
        return true;
      },
      interval: 5000,
      attempts: 60,
      message: `Waiting for DVP deposit in Merkle tree (Commitments tree=3, dvp=${shortHex(dvpAddress)})`,
      tolerateErrors: true,
    });

    LOGGER.optionalLog(`✅ Checking if the deposit was inserted into onchain Merkle tree`);

    // Now check the database for the deposit in a dvp_deposits collection and compare the commitment
    if (useMongoDbChecks && commitmentFromEvent) {
      LOGGER.optionalLog(`🛠️ Comparing onchain commitment with database dvp_deposits entry for the same deposit`);

      await eventually<boolean>({
        check: async (): Promise<boolean> => {
          // Get deposit from dvp_deposits collection
          const dvpDeposit = await getDvpDepositByNodeConnectionString(chainKey, commitmentFromEvent);

          if (!dvpDeposit) {
            LOGGER.optionalLog(`No matching deposit found in dvp_deposits collection yet`);
            return false;
          }

          // Make sure the commitment property exists in the document
          if (!dvpDeposit.commitment) {
            LOGGER.optionalLog(`Deposit document found but it doesn't have a commitment property`);
            return false;
          }

          // Compare commitment values - using snake_case field names
          if (dvpDeposit.commitment === commitmentFromEvent) {
            LOGGER.optionalLog(`Commitment values EXACT MATCH for first deposit`);

            // Verify expected deposit details if properties exist
            if (dvpDeposit.user_address) {
              expect(dvpDeposit.user_address).to.equal(depositorAddress);
            }

            if (dvpDeposit.token_amount) {
              expect(dvpDeposit.token_amount).to.equal(depositAmount.toString());
            }

            if (dvpDeposit.token_type) {
              expect(dvpDeposit.token_type).to.equal(1);
            }

            if (dvpDeposit.status) {
              expect(dvpDeposit.status).to.equal(1);
            }

            return true;
          } else {
            LOGGER.optionalLog(`❌ Commitment values DO NOT MATCH for the deposit`);
            LOGGER.optionalLog(`Database commitment: ${dvpDeposit.commitment}`);
            LOGGER.optionalLog(`Onchain commitment: ${commitmentFromEvent}`);
            return false;
          }
        },
        interval: 5000,
        attempts: 60,
        message: `Waiting for DVP deposit in dvp_deposits (commitment=${shortHex(commitmentFromEvent)}, chain=${chainKey})`,
        tolerateErrors: true,
      });

      LOGGER.optionalLog(`✅ DVP deposit successfully verified in database`);
    }

    return commitmentFromEvent;
  } catch (error) {
    LOGGER.optionalLog(`Merkle verification ERROR for the deposit: ${error}`);
    throw error;
  }
}

export const assertRevertDataTransaction = (
  revertData: RevertDataTransaction | undefined,
) => {
  expect(revertData, 'Expected revertDataTransaction to be present on reverted transaction').to.not.be.undefined;
  expect(revertData!.txHashDestinationRevert).to.be.a('string').that.is.not.empty;
  expect(revertData!.txHashDestinationRevert).to.match(/^0x[a-fA-F0-9]{64}$/);
  expect(revertData!.txHashSourceRevert).to.be.a('string').that.is.not.empty;
  expect(revertData!.txHashSourceRevert).to.match(/^0x[a-fA-F0-9]{64}$/);
};

