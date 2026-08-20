/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
import hre from 'hardhat';
import { expect } from 'chai';
import { PrivateHub } from '../../src/entities/PrivateHub';
import {
  PublicChainERC20,
  PublicChainERC20__factory,
  ProductionErc20Token,
  ProductionErc20Token__factory,
} from '../../typechain-types';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER, PUBLIC_CHAIN_ID, PUBLIC_CHAIN_RPC_URL } from '../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../setup';
import { ERC20Wrapper } from '../../src/entities/tokens/ERC20Wrapper';
import { delay } from '../../src/utils/common';
import { formatUnits, JsonRpcProvider, keccak256, parseUnits, Wallet } from 'ethers';
import { randomBytes } from 'node:crypto';
import { TransactionBuilder } from '../test-utils/transaction-builder';
import { TransactionSender } from '../test-utils/transaction-sender';

// TOTAL_TRANSACTIONS_RAYLS_NODE=10000 BATCH_SIZE_RAYLS_NODE=1000 npx hardhat test hardhat/test/performance/PrivacyNodePrivateToPublicPerformance.ts

function formatTimestamp(date: Date): string {
  return date.toTimeString().substring(0, 8);
}

describe('Performance Tests: Rayls Node Private to Public Chain @decommissioned', function () {
  const TOTAL_TRANSACTIONS = Number(process.env['TOTAL_TRANSACTIONS_RAYLS_NODE'] || '1000');
  const BATCH_SIZE = Number(process.env['BATCH_SIZE_RAYLS_NODE'] || '100');
  const TRANSFER_AMOUNT = 1;
  const INITIAL_MINT_AMOUNT = TOTAL_TRANSACTIONS * TRANSFER_AMOUNT * 2; // Extra for safety

  // Calculate the number of batches needed
  const NUM_BATCHES = Math.ceil(TOTAL_TRANSACTIONS / BATCH_SIZE);

  let privacyNodes: PrivacyNodeMap;
  let privateHub : PrivateHub;

  let user: {
    userId: string;
    publicAddress: string;
    privateAddress: string;
    publicPrivateKey: string;
    privatePrivateKey: string;
  };

  let token: ERC20Wrapper<ProductionErc20Token>;
  let publicTokenAddress: string;

  let TxBuilder: TransactionBuilder;
  let TxSender = TransactionSender;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const {initializedNodes, initializedPNH} = await initializePrivacyNodesAndPnh(1);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    LOGGER.info('🚀 Starting Rayls Node Private to Public Chain Performance Test');
    // Step 1: Create user with auto-generated credentials
    user = await createUser('A');
    // Step 2: Approve user
    const userGov = await privacyNodes.A.getUserGovernance();
    await (await userGov.approveUser(user.userId)).wait();
    // Step 3: Deploy ERC20 token, register + approve on the PN, then activate the public-chain leg
    token = new ERC20Wrapper(privacyNodes.A, ProductionErc20Token__factory);
    await token.deploy();
    await token.activateOnPn();
    publicTokenAddress = await token.activateOnPublicChain();
    await token.mintAndAwait(privateHub, { amount: parseUnits(INITIAL_MINT_AMOUNT.toString(), 18), toAddress: user.privateAddress });

    TxBuilder = new TransactionBuilder(ProductionErc20Token__factory.abi,token.address[privacyNodes.A.chainId],
      user.privatePrivateKey, Number(privacyNodes.A.chainId));
  });

  it(`Should measure performance of ${TOTAL_TRANSACTIONS} transactions in ${NUM_BATCHES} batches of ${BATCH_SIZE}`, async function () {
    this.timeout(DEFAULT_TIMEOUT * 10); // Increase timeout for large test

    LOGGER.info(`🌉 Starting multi-batch performance test:`);
    LOGGER.info(`   • Total Transactions: ${TOTAL_TRANSACTIONS}`);
    LOGGER.info(`   • Batch Size: ${BATCH_SIZE}`);
    LOGGER.info(`   • Number of Batches: ${NUM_BATCHES}`);

    const userSigner = new Wallet(user.privatePrivateKey,privacyNodes.A.provider);
    await token.contract.connect(userSigner);

    // Verify sufficient balance
    const initialPrivateBalance = await token.contract.balanceOf(user.privateAddress);
    const requiredBalance = TOTAL_TRANSACTIONS * TRANSFER_AMOUNT;
    const requiredBalanceWei = parseUnits(requiredBalance.toString(), 18);

    LOGGER.info(`Initial private balance: ${formatUnits(initialPrivateBalance, 18)} tokens, Required: ${requiredBalance} tokens`);
    expect(initialPrivateBalance).to.be.gte(requiredBalanceWei);

    // Get initial public balance for comparison
    const publicProvider = new JsonRpcProvider(PUBLIC_CHAIN_RPC_URL);
    const publicToken: PublicChainERC20 = PublicChainERC20__factory.connect(publicTokenAddress, publicProvider);
    const initialPublicBalance = await publicToken.balanceOf(user.publicAddress);
    const userTokenContract = token.contract.connect(userSigner) as ProductionErc20Token;

    // Send initial transaction to prepare the system
    LOGGER.info('📝 Sending initial transaction to prepare system...');
    const initialTx = await userTokenContract.teleportToPublicChain(
      user.publicAddress,
      parseUnits(TRANSFER_AMOUNT.toString(), 18),
      PUBLIC_CHAIN_ID,
      { gasLimit: GAS_LIMIT }
    );
    await initialTx.wait();
    LOGGER.info('✅ Initial transaction sent');

    // Wait for the initial transaction to be processed
    await delay(5000);

    // Start performance measurement
    const startTime = Date.now();
    LOGGER.info(`📊 Starting performance measurement at ${formatTimestamp(new Date(startTime))}`);

    // Get starting nonce
    let currentNonce = await privacyNodes.A.provider.getTransactionCount(userSigner.address, 'pending');

    // Send all batches
    const batchStartTimes: number[] = [];
    const batchEndTimes: number[] = [];

    for (let batchIndex = 0; batchIndex < NUM_BATCHES; batchIndex++) {
      const remainingTransactions = TOTAL_TRANSACTIONS - (batchIndex * BATCH_SIZE);
      const currentBatchSize = Math.min(BATCH_SIZE, remainingTransactions);

      LOGGER.info(`📤 Sending batch ${batchIndex + 1}/${NUM_BATCHES} with ${currentBatchSize} transactions (nonce: ${currentNonce})...`);

      const batchStart = Date.now();
      batchStartTimes.push(batchStart);

      const txs = await TxBuilder.signBatch(currentBatchSize, "teleportToPublicChain",
        [user.publicAddress, parseUnits(TRANSFER_AMOUNT.toString(), 18), PUBLIC_CHAIN_ID, []],currentNonce);

      await TxSender.sendBatchRawTransactions(txs,privacyNodes.A.rpcUrl)

      const batchEnd = Date.now();
      batchEndTimes.push(batchEnd);

      LOGGER.info(`   ✅ Batch ${batchIndex + 1} sent in ${batchEnd - batchStart}ms`);

      currentNonce += currentBatchSize;

      // Small delay between batches to avoid overwhelming the system
      if (batchIndex < NUM_BATCHES - 1) {
        await delay(100);
      }
    }

    const allBatchesSentTime = Date.now();
    LOGGER.info(`📤 All ${NUM_BATCHES} batches (${TOTAL_TRANSACTIONS} transactions) sent in ${allBatchesSentTime - startTime}ms`);

    // Wait for all transactions to be processed and verify on public chain
    const maxAttempts = Math.max(120, NUM_BATCHES * 10); // Scale with number of batches
    const checkInterval = 5000;
    let finalPublicBalance = initialPublicBalance;
    let measurementEndTime = 0;

    const expectedFinalBalance = initialPublicBalance + parseUnits((TOTAL_TRANSACTIONS * TRANSFER_AMOUNT + TRANSFER_AMOUNT).toString(), 18);

    LOGGER.info(`Waiting for cross-chain confirmation (expecting ${formatUnits(expectedFinalBalance, 18)} tokens total)...`);

    for (let i = 0; i < maxAttempts; i++) {
      try {
        finalPublicBalance = await publicToken.balanceOf(user.publicAddress);
        const currentTransferred = finalPublicBalance - initialPublicBalance;

        LOGGER.info(`Balance check ${i + 1}/${maxAttempts}: ${formatUnits(currentTransferred, 18)}/${formatUnits(expectedFinalBalance - initialPublicBalance, 18)} tokens transferred`);

        if (finalPublicBalance >= expectedFinalBalance) {
          measurementEndTime = Date.now();
          LOGGER.info(`✅ All transactions confirmed on public chain at ${formatTimestamp(new Date(measurementEndTime))}`);
          break;
        }
      } catch (error: any) {
        LOGGER.info(`Balance check ${i + 1} failed: ${error.message}`);
      }

      await delay(checkInterval);
    }

    if (measurementEndTime === 0) {
      measurementEndTime = Date.now();
      LOGGER.info(`⚠️ Test completed but not all transactions confirmed within timeout`);
    }

    // Calculate performance metrics
    const totalExecutionTime = measurementEndTime - startTime;
    const batchSubmissionTime = allBatchesSentTime - startTime;
    const confirmationTime = measurementEndTime - allBatchesSentTime;

    const executionTimeSec = (totalExecutionTime / 1000);
    const batchSubmissionTimeSec = (batchSubmissionTime / 1000);
    const confirmationTimeSec = (confirmationTime / 1000);

    const effectiveTps = (TOTAL_TRANSACTIONS / executionTimeSec);
    const submissionTps = (TOTAL_TRANSACTIONS / batchSubmissionTimeSec);

    // Verify final balances
    const tokensTransferred = finalPublicBalance - initialPublicBalance;
    const expectedTokens = parseUnits((TOTAL_TRANSACTIONS * TRANSFER_AMOUNT + TRANSFER_AMOUNT).toString(), 18);

    // Calculate success rate correctly
    const actualTransactions = Number(tokensTransferred / parseUnits(TRANSFER_AMOUNT.toString(), 18));
    const expectedTransactions = TOTAL_TRANSACTIONS + 1; // +1 for initial transaction
    const successRate = (actualTransactions / expectedTransactions) * 100;

    // Calculate average batch metrics
    const avgBatchSubmissionTime = batchEndTimes.reduce((sum, endTime, i) => sum + (endTime - batchStartTimes[i]), 0) / NUM_BATCHES;
    const minBatchTime = Math.min(...batchEndTimes.map((endTime, i) => endTime - batchStartTimes[i]));
    const maxBatchTime = Math.max(...batchEndTimes.map((endTime, i) => endTime - batchStartTimes[i]));

    LOGGER.info(`📊 Performance Test Results:`);
    LOGGER.info(`   • Total Transactions: ${TOTAL_TRANSACTIONS}`);
    LOGGER.info(`   • Number of Batches: ${NUM_BATCHES}`);
    LOGGER.info(`   • Batch Size: ${BATCH_SIZE} transactions`);
    LOGGER.info(`   • Transfer Amount per TX: ${TRANSFER_AMOUNT} tokens`);
    LOGGER.info(`   • Total Tokens Transferred: ${formatUnits(tokensTransferred, 18)} tokens`);
    LOGGER.info(`   • Successful Transactions: ${actualTransactions}/${expectedTransactions}`);
    LOGGER.info(`   • Batch Submission Time: ${batchSubmissionTimeSec.toFixed(2)}s`);
    LOGGER.info(`   • Cross-chain Confirmation Time: ${confirmationTimeSec.toFixed(2)}s`);
    LOGGER.info(`   • Total Execution Time: ${executionTimeSec.toFixed(2)}s`);
    LOGGER.info(`   • Average Batch Time: ${(avgBatchSubmissionTime / 1000).toFixed(2)}s`);
    LOGGER.info(`   • Min/Max Batch Time: ${(minBatchTime / 1000).toFixed(2)}s / ${(maxBatchTime / 1000).toFixed(2)}s`);
    LOGGER.info(`   • Submission TPS: ${submissionTps.toFixed(2)} tx/s`);
    LOGGER.info(`   • Effective Cross-chain TPS: ${effectiveTps.toFixed(2)} tx/s`);
    LOGGER.info(`   • Success Rate: ${successRate.toFixed(2)}%`);

    // Assertions
    expect(tokensTransferred).to.be.gte(expectedTokens * BigInt(50) / BigInt(100)); // At least 50% success for large batches
    expect(effectiveTps).to.be.gt(0);
    expect(successRate).to.be.gte(50); // At least 50% success rate for large batches

    LOGGER.info('✅ Multi-batch performance test completed successfully!');
  });

  // Helper function to create user
  async function createUser(pl: string) {
    const provider = new hre.ethers.JsonRpcProvider(process.env[`RPC_URL_NODE_${pl}`]);
    const systemWallet = new hre.ethers.Wallet(process.env['PRIVATE_KEY_SYSTEM'] as string);
    const signer = systemWallet.connect(provider);

    const userGovernanceAddress = process.env[`NODE_${pl}_RAYLS_NODE_USER_GOVERNANCE`] as string;
    const userGovernance = await hre.ethers.getContractAt('RNUserGovernanceV1', userGovernanceAddress, signer);

    // Generate credentials
    const userId = keccak256(randomBytes(32));
    const publicWallet = Wallet.createRandom();
    const privateWallet = Wallet.createRandom();

    // Create user
    const createUserTx = await userGovernance.createUser(userId);
    await createUserTx.wait();

    // Add address pair
    const addAddressPairTx = await userGovernance.addAddressPair(
      userId,
      publicWallet.address,
      privateWallet.address
    );
    await addAddressPairTx.wait();

    return {
      userId,
      publicAddress: publicWallet.address,
      privateAddress: privateWallet.address,
      publicPrivateKey: publicWallet.privateKey,
      privatePrivateKey: privateWallet.privateKey
    };
  }
});