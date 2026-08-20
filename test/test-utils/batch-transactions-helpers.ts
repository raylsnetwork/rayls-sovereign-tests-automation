import hre from 'hardhat';
import { ProductionEnygmaToken, ProductionEnygmaToken__factory } from '../../typechain-types';
import { PrivacyNode } from '../../src/entities/PrivacyNode';
import { PrivacyNodeMap } from '../setup';
import { EnygmaWrapper } from '../../src/entities/tokens/EnygmaWrapper';
import { eventually, retry } from '../../src/utils/common';
import { shortHex } from '../../src/utils/formatters';
import { DEFAULT_TIMEOUT, LOGGER, SECOND } from '../../src/config/env-config';
import { TransactionBuilder } from './transaction-builder';
import { TransactionSender } from './transaction-sender';

// Configuration Constants
const BATCH_CONFIG = {
  GAS_PRICE: 0,
  GAS_LIMIT: 5000000,
  JSON_RPC_BATCH_SIZE: 100,
  HTTP_TIMEOUT: 30000,
  POLL_INTERVAL: 1000,
  POLL_TIMEOUT: Math.floor(DEFAULT_TIMEOUT / SECOND),
  EXTENDED_POLL_TIMEOUT: Math.floor((DEFAULT_TIMEOUT * 2) / SECOND),
  LOG_EVERY_N_ATTEMPTS: 10, // Only log balance checks every N attempts to reduce noise
} as const;

const TEST_CONFIG = {
  REPEATED_BATCH_COUNT: 2,
  ACCUMULATION_BATCH_COUNT: 3,
  VARIABLE_BATCH_COUNT: 1,
} as const;

/**
 * Generates and sends multiple batch transactions via JSON-RPC.
 * Retries the full sign+send cycle on nonce errors (parallel worker contention).
 */
export async function sendBatchTransactions(
  count: number,
  destinationAddresses: string[],
  amounts: number[],
  destinationChainIds: string[],
  payloads: any[],
  sourceNode: PrivacyNode,
  sourceToken: EnygmaWrapper<ProductionEnygmaToken>,
) {
  const maxAttempts = 5;
  const signer = sourceToken.userWallet;
  const TxBuilder = new TransactionBuilder(ProductionEnygmaToken__factory.abi,
    sourceToken.address[sourceNode.chainId],
    signer.privateKey, Number(sourceNode.chainId));
  const NONCE_CONFLICT = 'Batch nonce conflict — will re-sign and retry';

  await retry(
    async () => {
      // Each retry re-fetches the pending nonce — required when parallel workers race on the same signer.
      const currentNonce = await sourceNode.provider.getTransactionCount(signer, 'pending');
      LOGGER.log(`Signing ${count} transactions with nonce ${currentNonce}...`);

      const transactions = await TxBuilder.signBatch(count, 'crossTransfer',
        [destinationAddresses, amounts, destinationChainIds, payloads], currentNonce);

      const batchSize = BATCH_CONFIG.JSON_RPC_BATCH_SIZE;
      for (let i = 0; i < transactions.length; i += batchSize) {
        const batch = transactions.slice(i, i + batchSize);
        const results = await TransactionSender.sendBatchRawTransactions(batch, sourceNode.rpcUrl);
        if (TransactionSender.hasNonceError(results)) throw new Error(NONCE_CONFLICT);
      }
      LOGGER.log('Batch transactions sent successfully');
    },
    {
      attempts: maxAttempts,
      delayMs: 500,
      retryIf: (err) => err?.message === NONCE_CONFLICT,
      onRetry: (_err, i) => LOGGER.log(`[NONCE RETRY] batch attempt ${i}/${maxAttempts}, re-signing`),
    },
  );
}

/**
 * Common setup for batch test execution
 */
interface BatchTestSetup {
  sourceNode: PrivacyNode;
  destinationNodes: PrivacyNode[];
  sourceToken: EnygmaWrapper<ProductionEnygmaToken>;
  initialSourceBalance: bigint;
  receiverAddresses: string[];
  destinationChainIds: string[];
  programData: any[];
}

async function setupBatchTest(
  sourceKey: string,
  destinationKeys: string[],
  privacyNodes: PrivacyNodeMap,
  token: EnygmaWrapper<ProductionEnygmaToken>
): Promise<BatchTestSetup> {
  const sourceNode = privacyNodes[sourceKey];
  const signerAddress = await token.userWallet.getAddress()
  const destinationNodes = destinationKeys.map(key => privacyNodes[key]);
  const initialSourceBalance = await token.contract.balanceOf(signerAddress);
  
  const receiverAddresses = destinationNodes.map(() => hre.ethers.Wallet.createRandom().address);
  const destinationChainIds = destinationNodes.map(node => node.chainId);
  const programData = new Array(destinationNodes.length).fill([]);

  return {
    sourceNode,
    destinationNodes,
    sourceToken:token,
    initialSourceBalance,
    receiverAddresses,
    destinationChainIds,
    programData
  };
}

/**
 * Common verification for batch test results
 */
async function verifyBatchTestResults(
  setup: BatchTestSetup,
  destinationKeys: string[],
  receiverAddresses: string[],
  expectedAmounts: bigint[],
  totalAmount: number,
  token: EnygmaWrapper<ProductionEnygmaToken>,
  testType: string
): Promise<void> {
  // Verify source balance
  const expectedSourceBalance = setup.initialSourceBalance - BigInt(totalAmount);
  const signerAddress = await token.userWallet.getAddress()
  await eventually<boolean>({
    check: async (): Promise<boolean> => {
      const currentBalance = await setup.sourceToken.contract.balanceOf(signerAddress);
      return currentBalance === expectedSourceBalance;
    },
    interval: BATCH_CONFIG.POLL_INTERVAL,
    attempts: BATCH_CONFIG.POLL_TIMEOUT,
    message: `Waiting for source balance → ${expectedSourceBalance} for ${shortHex(signerAddress)} (batch=${totalAmount})`,
  });

  LOGGER.log(`Source balance verified: ${expectedSourceBalance}`);

  // Verify destination balances
  await verifyDestinationBalances(
    setup.destinationNodes,
    destinationKeys,
    receiverAddresses,
    expectedAmounts,
    token,
    testType
  );
}

/**
 * Waits for token deployment on a node and returns the token address
 */
export async function waitForTokenDeployment(
  node: PrivacyNode, 
  nodeKey: string,
  token: EnygmaWrapper<ProductionEnygmaToken>
): Promise<string> {
  let tokenAddress = token.address[node.chainId];
  if (!tokenAddress) {
    LOGGER.log(`Waiting for token deployment on ${nodeKey}`);
    const endpoint = node.getEndpointV1();

    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const address = await endpoint.getAddressByResourceId(token.resourceId);
        if (address === '0x0000000000000000000000000000000000000000') return false;
        token.address[node.chainId] = address;
        tokenAddress = address;
        return true;
      },
      interval: BATCH_CONFIG.POLL_INTERVAL,
      attempts: BATCH_CONFIG.EXTENDED_POLL_TIMEOUT,
      message: `Waiting for token ${token.symbol} deployed on ${nodeKey} (chain=${node.chainId}, rid=${shortHex(token.resourceId)})`,
    });

    LOGGER.log(`Token deployed on ${nodeKey}: ${tokenAddress}`);
  }
  return tokenAddress!;
}

/**
 * Verifies expected token balances on multiple destination nodes
 */
export async function verifyDestinationBalances(
  destinationNodes: PrivacyNode[],
  destinationKeys: string[],
  receiverAddresses: string[],
  expectedAmounts: bigint[],
  token: EnygmaWrapper<ProductionEnygmaToken>,
  testType: string
): Promise<void> {
  const verificationPromises = destinationNodes.map(async (node, index) => {
    const destinationKey = destinationKeys[index];
    const receiverAddress = receiverAddresses[index];
    const expectedAmount = expectedAmounts[index];

    try {
      LOGGER.log(`Starting ${destinationKey} verification: expecting ${expectedAmount} tokens at ${receiverAddress.slice(0, 10)}...`);
      
      const tokenAddress = await waitForTokenDeployment(node, destinationKey, token);
      const destToken = await node.getContractAt<ProductionEnygmaToken>(
        ProductionEnygmaToken__factory.name,
        tokenAddress,
        token.symbol
      );

      LOGGER.log(`${destinationKey} token deployed at ${tokenAddress}, checking balance...`);

      let lastBalance: bigint | null = null;
      let attemptCount = 0;
      const logEveryN = BATCH_CONFIG.LOG_EVERY_N_ATTEMPTS;
      
      await eventually<boolean>({
        check: async (): Promise<boolean> => {
          try {
            attemptCount++;
            const balance = await destToken.balanceOf(receiverAddress);

            // Only log when balance changes or every Nth attempt
            const shouldLog = lastBalance !== balance || attemptCount % logEveryN === 0;

            if (shouldLog) {
              if (lastBalance !== balance && lastBalance !== null) {
                LOGGER.log(`${destinationKey} balance changed: ${lastBalance} -> ${balance} (expected: ${expectedAmount})`);
              } else if (attemptCount % logEveryN === 0) {
                LOGGER.log(`${destinationKey} checking... balance: ${balance}, expected: ${expectedAmount} (attempt ${attemptCount})`);
              } else {
                LOGGER.log(`${destinationKey} balance: ${balance} (expected: ${expectedAmount})`);
              }
              lastBalance = balance;
            }

            return balance === expectedAmount;
          } catch (error) {
            if (attemptCount === 1 || attemptCount % logEveryN === 0) {
              LOGGER.log(`${destinationKey} balance check error (attempt ${attemptCount}): ${error}`);
            }
            return false;
          }
        },
        interval: BATCH_CONFIG.POLL_INTERVAL,
        attempts: BATCH_CONFIG.EXTENDED_POLL_TIMEOUT,
        message: `Waiting for ${destinationKey} balance → ${expectedAmount} for ${shortHex(receiverAddress)} (${testType})`,
      });

      LOGGER.log(`${destinationKey} ${testType} verified: ${expectedAmount} tokens received (after ${attemptCount} attempts)`);
      return true;
    } catch (error) {
      LOGGER.log(`${destinationKey} verification error: ${error}`);
      throw error;
    }
  });

  // Wait for all verifications with individual error handling
  const results = await Promise.allSettled(verificationPromises);
  
  // Check if any verification failed
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length > 0) {
    LOGGER.log(`Verification failures: ${failures.map((f, i) => `${destinationKeys[i]}: ${f.reason}`).join(', ')}`);
    throw new Error(`${failures.length} destination(s) failed verification`);
  }
}

/**
 * Sends multiple batch transactions to same fresh addresses (accumulation test)
 */
export async function executeRepeatedBatchTransactions(
  sourceKey: string,
  destinationKeys: string[],
  privacyNodes: PrivacyNodeMap,
  token: EnygmaWrapper<ProductionEnygmaToken>
): Promise<void> {
  const setup = await setupBatchTest(sourceKey, destinationKeys, privacyNodes, token);
  
  const amounts = new Array(destinationKeys.length).fill(1); // Same amount (1) to each destination
  const batchCount = TEST_CONFIG.REPEATED_BATCH_COUNT;

  LOGGER.log(`Repeated batches: ${batchCount} batches x ${amounts.join(', ')} tokens to same fresh receivers on ${destinationKeys.join(', ')}`);
  LOGGER.log(`Fresh receivers: ${setup.receiverAddresses.map((addr, i) => `${destinationKeys[i]}:${addr.slice(0, 8)}...`).join(', ')}`);

  const totalAmountPerBatch = amounts.reduce((sum, amount) => sum + amount, 0);
  const totalAmount = totalAmountPerBatch * batchCount;
  
  await sendBatchTransactions(batchCount, setup.receiverAddresses, amounts, setup.destinationChainIds, setup.programData, setup.sourceNode, setup.sourceToken);

  const expectedAmounts = amounts.map(amount => BigInt(amount * batchCount));
  await verifyBatchTestResults(setup, destinationKeys, setup.receiverAddresses, expectedAmounts, totalAmount, token, 'repeated batches');
}

/**
 * Sends single batch with different amounts to different fresh addresses
 */
export async function executeVariableAmountBatchTransaction(
  sourceKey: string,
  destinationKeys: string[],
  privacyNodes: PrivacyNodeMap,
  token: EnygmaWrapper<ProductionEnygmaToken>
): Promise<void> {
  const setup = await setupBatchTest(sourceKey, destinationKeys, privacyNodes, token);
  
  const amounts = destinationKeys.map((_, index) => index + 1); // [1, 2, 3, ...]
  const batchCount = TEST_CONFIG.VARIABLE_BATCH_COUNT;

  LOGGER.log(`Multiple destinations batch: ${amounts.join(', ')} tokens to fresh addresses on ${destinationKeys.join(', ')}`);
  LOGGER.log(`Fresh receivers: ${setup.receiverAddresses.map((addr, i) => `${destinationKeys[i]}:${addr.slice(0, 8)}...`).join(', ')}`);

  const totalAmount = amounts.reduce((sum, amount) => sum + amount, 0);
  await sendBatchTransactions(batchCount, setup.receiverAddresses, amounts, setup.destinationChainIds, setup.programData, setup.sourceNode, setup.sourceToken);

  const expectedAmounts = amounts.map(amount => BigInt(amount));
  await verifyBatchTestResults(setup, destinationKeys, setup.receiverAddresses, expectedAmounts, totalAmount, token, 'multiple destinations');
}

/**
 * Sends multiple batches to same fresh addresses (enhanced accumulation test)
 */
export async function executeAccumulatedBatchTransactions(
  sourceKey: string,
  destinationKeys: string[],
  privacyNodes: PrivacyNodeMap,
  token: EnygmaWrapper<ProductionEnygmaToken>
): Promise<void> {
  const setup = await setupBatchTest(sourceKey, destinationKeys, privacyNodes, token);
  
  const amounts = destinationKeys.map(() => 1); // Same amount per destination per batch
  const batchCount = TEST_CONFIG.ACCUMULATION_BATCH_COUNT;

  LOGGER.log(`Multiple batches: ${batchCount} batches x ${amounts.join(', ')} tokens to same fresh addresses on ${destinationKeys.join(', ')}`);
  LOGGER.log(`Fresh receivers: ${setup.receiverAddresses.map((addr, i) => `${destinationKeys[i]}:${addr.slice(0, 8)}...`).join(', ')}`);

  const totalAmountPerBatch = amounts.reduce((sum, amount) => sum + amount, 0);
  const totalAmount = totalAmountPerBatch * batchCount;

  await sendBatchTransactions(batchCount, setup.receiverAddresses, amounts, setup.destinationChainIds, setup.programData, setup.sourceNode, setup.sourceToken);

  const expectedAmounts = amounts.map(amount => BigInt(amount * batchCount));
  await verifyBatchTestResults(setup, destinationKeys, setup.receiverAddresses, expectedAmounts, totalAmount, token, 'multiple batches');
}
