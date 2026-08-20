/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
import hre from 'hardhat';
import { ethers } from 'ethers';
import { expect } from 'chai';
import { LOGGER } from '../../src/config/env-config';
import {
  EndpointV1,
  Erc20BatchTeleport,
  Erc20BatchTeleport__factory,
  ProductionErc20Token,
  ProductionErc20Token__factory,
} from '../../typechain-types';
import { delay, eventually } from '../../src/utils/common';
import { shortHex } from '../../src/utils/formatters';
import { ERC20Wrapper } from '../../src/entities/tokens/ERC20Wrapper';
import { initializePrivacyNodesAndPnh } from '../setup';
import { PrivacyNode } from '../../src/entities/PrivacyNode';
import { PrivateHub } from '../../src/entities/PrivateHub';
import { TransactionSender } from '../test-utils/transaction-sender';
import { TransactionBuilder } from '../test-utils/transaction-builder';
import { TPSInput, everyoneToAllParticipants, trackTime, reportTPS } from '../test-utils/mesh-helpers';

const POLLING_TOKEN_SETUP_TIMEOUT: [number, number] = [1000, 300];
const POLLING_BALANCES_TIMEOUT: [number, number] = [1000, 3600];

const NORMAL_TEST_TIMEOUT = 20 * 60 * 1000;
const STABILITY_TEST_TIMEOUT = 120 * 60 * 1000;

const MAX_NUMBER_OF_ERC20_TRANSFERS_IN_BATCH = 300;

type TokenSendTx = {
  source: PrivacyNode;
  destination: PrivacyNode;
  to: string;
  value: number;
  resourceId: string;
  resourceType: 'Erc20BatchTeleport' | 'ProductionErc20Token';
};

describe('Atomic Mesh tests @decommissioned', function () {
  const performanceTxCount = parseInt(process.env['MESH_PERF_TX_COUNT'] || '100');
  const stabilityTxCount = parseInt(process.env['MESH_STABILITY_TX_COUNT'] || '50');
  const stabilityDurationMin = parseFloat(process.env['MESH_STABILITY_DURATION_MIN'] || '2');
  const stabiltyTxDelayMs = parseFloat(process.env['MESH_STABILITY_DELAY_SEC'] || '2') * 1000;
  const performanceTxDelayMs = parseFloat(process.env['MESH_PERF_DELAY_SEC'] || '1') * 1000;
  const stabilityTxCountPerBatch = Math.min(stabilityTxCount, MAX_NUMBER_OF_ERC20_TRANSFERS_IN_BATCH);
  const performanceTxCountPerBatch = Math.min(performanceTxCount, MAX_NUMBER_OF_ERC20_TRANSFERS_IN_BATCH);

  let accounts: string[] = [];
  let participants: PrivacyNode[] = [];
  let privacyNodes: { [NODE: string]: PrivacyNode } = {};
  let privateHub: PrivateHub;
  let singleTokenWrappers: Record<string, ERC20Wrapper<ProductionErc20Token>> = {};
  let batchTokenWrappers: Record<string, ERC20Wrapper<Erc20BatchTeleport>> = {};

  function getBatchTokenFor(pl: PrivacyNode): Erc20BatchTeleport {
    return batchTokenWrappers[pl.chainId].contract;
  }

  function getSingleTokenResourceId(pl: PrivacyNode): string {
    return singleTokenWrappers[pl.chainId].resourceId;
  }

  function getBatchTokenResourceId(pl: PrivacyNode): string {
    return batchTokenWrappers[pl.chainId].resourceId;
  }

  before(async function () {
    this.timeout(NORMAL_TEST_TIMEOUT);

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(4);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;
    participants = Object.values(privacyNodes);

    accounts = [
      await ethers.Wallet.createRandom().getAddress(),
      await ethers.Wallet.createRandom().getAddress(),
      await ethers.Wallet.createRandom().getAddress(),
    ];

    for (const pl of participants) {
      const singleToken = new ERC20Wrapper<ProductionErc20Token>(pl, ProductionErc20Token__factory);
      const batchToken = new ERC20Wrapper<Erc20BatchTeleport>(pl, Erc20BatchTeleport__factory);

      // singleToken (ProductionErc20Token): constructor-deploy + PN register + hub activation
      // (activateOnHub's relayer callback grants ENDPOINT_SENDER). No constructor premint → mint 2M.
      await singleToken.deploy();
      await singleToken.activateOnPn();
      await singleToken.activateOnHub(privateHub);
      await singleToken.mintAndAwait(privateHub, {
        toAddress: singleToken.userWallet.address,
        amount: ethers.parseEther('2000000'),
      });

      // batchToken (Erc20BatchTeleport) is the un-seeded holdout → legacy deploy + grant + register.
      await batchToken.deploy();
      await pl.grantEndpointSender([batchToken.address[pl.chainId]]);
      await batchToken.activateOnPn();
      await batchToken.activateOnHub(privateHub);

      await batchToken.mintAndAwait(privateHub, {
        toAddress: batchToken.userWallet.address,
        amount: ethers.parseEther('1000000'),
      });

      singleTokenWrappers[pl.chainId] = singleToken;
      batchTokenWrappers[pl.chainId] = batchToken;
    }
  });

  describe('Batch Transfer - send tokens between participants', function () {

    function combineBatchTxWithSameDest(batch: TokenSendTx[]) {
      return batch.reduce((acc, tx) => {
        const existing = acc.find((x: any) => x.source.node === tx.source.node && x.destination.node === tx.destination.node && x.to === tx.to);
        if (!existing) {
          acc.push({ ...tx });
        } else {
          existing.value += tx.value;
        }
        return acc;
      }, [] as TokenSendTx[]);
    }

    async function fetchDestBalancesOfBatch(batch: TokenSendTx[]) {
      return Promise.all(
        batch.map(async (tx) => {
          const receiverBalanceBefore = await getDestinationTokenBalance(tx.destination, tx.resourceId, tx.resourceType, tx.to);
          return { tx, receiverBalanceBefore };
        })
      );
    }

    function prepareBatchTokenSendTx(source: PrivacyNode, destination: PrivacyNode, value: number, to: string): TokenSendTx {
      return {
        source,
        destination,
        to,
        value,
        resourceId: getBatchTokenResourceId(source),
        resourceType: 'Erc20BatchTeleport',
      };
    }

    function createBatchWithSameDest(source: PrivacyNode, destination: PrivacyNode, count: number, amount: number, to: string): TokenSendTx[] {
      return Array.from({ length: count }, () => prepareBatchTokenSendTx(source, destination, amount, to));
    }

    async function executeBatchTeleports(batch: TokenSendTx[], token: Erc20BatchTeleport, isAtomic: boolean) {
      const payload = batch.map(tx => ({
        to: tx.to,
        value: BigInt(tx.value),
        chainId: tx.destination.chainId,
      }));

      const txResponse = isAtomic
        ? await token.batchTeleportAtomic(payload)
        : await token.batchTeleport(payload);

      return await txResponse.wait();
    }

    it('Deploy external tokens to all participants', async function () {
      // Token deployment for all participants happens in before() hook
      await everyoneToAllParticipants(participants, async (_source, _destinations) => {});
    }).timeout(NORMAL_TEST_TIMEOUT);

    it('Vanila Teleport - PN A sends batch of tokens to PNs: B,C,D', async function () {
      const [accX, accY, accZ] = accounts;
      const [pnA, pnB, pnC, pnD] = participants;

      const batch: TokenSendTx[] = [
        prepareBatchTokenSendTx(pnA, pnB, 100, accX),
        prepareBatchTokenSendTx(pnA, pnB, 100, accX),
        prepareBatchTokenSendTx(pnA, pnC, 50, accY),
        prepareBatchTokenSendTx(pnA, pnC, 30, accZ),
        prepareBatchTokenSendTx(pnA, pnD, 50, accY),
        prepareBatchTokenSendTx(pnA, pnD, 30, accZ),
      ];

      const batchWithUniqueDest = combineBatchTxWithSameDest(batch);
      const batchWithBalances = await fetchDestBalancesOfBatch(batchWithUniqueDest);

      LOGGER.info(`Sending batch teleport`);
      await executeBatchTeleports(batch, getBatchTokenFor(pnA), false);

      await Promise.all(batchWithBalances.map(({ tx, receiverBalanceBefore }) => waitUntilTokensAreTransferred(tx, receiverBalanceBefore)));
    }).timeout(NORMAL_TEST_TIMEOUT);

    async function runBatchTeleportMesh(isAtomic: boolean): Promise<void> {
      const teleportTokens: Promise<TPSInput>[] = [];

      if (performanceTxCountPerBatch < performanceTxCount) {
        LOGGER.info(`Reducing the number of txs per batch to ${performanceTxCountPerBatch} to avoid exceeding the block gas limit`);
      }

      await everyoneToAllParticipants(participants, async (source, destinations) => {
        const token = getBatchTokenFor(source);
        const tokenAmount = 1;

        LOGGER.info(`PL ${source.node} Sending batch tokens to ${destinations.map(x => x.node).join(', ')}`);

        for (const destination of destinations) {
          await delay(performanceTxDelayMs);

          const direction = `${source.node} -> ${destination.node}`;
          const batch = createBatchWithSameDest(source, destination, performanceTxCountPerBatch, tokenAmount, batchTokenWrappers[destination.chainId].userWallet.address);
          const batchWithUniqueDest = combineBatchTxWithSameDest(batch);
          const batchWithBalances = await fetchDestBalancesOfBatch(batchWithUniqueDest);
          const executionStartTime = Date.now();

          LOGGER.info(`${direction} Sending batch teleport with ${performanceTxCountPerBatch}txs`);
          const receipt = await executeBatchTeleports(batch, token, isAtomic);

          if (receipt?.status !== 1) {
            LOGGER.info(`${direction} Batch teleport failed. Skipping..`);
            continue;
          }

          teleportTokens.push(
            ...batchWithBalances.map(async ({ tx, receiverBalanceBefore }) =>
              waitUntilTokensAreTransferred(tx, receiverBalanceBefore).then(() => createTPSInput(tx, performanceTxCountPerBatch, executionStartTime))
            )
          );
        }
      });

      reportTPS(await Promise.all(teleportTokens), { testType: 'Atomic Mesh Performance Test', methodology: 'Calculate TPS per direction (totalTx/elapsedSeconds) and report the average across directions for the mesh scenario.' });
    }

    it(`Vanila Teleport - Each partcipant transfer batch of ${performanceTxCountPerBatch}txs to other participants`, async function () {
      await runBatchTeleportMesh(false);
    }).timeout(NORMAL_TEST_TIMEOUT);

    it('Atomic Teleport - Each partcipant transfer batch of tokens to other participants', async function () {
      await runBatchTeleportMesh(true);
    }).timeout(NORMAL_TEST_TIMEOUT);

    it(`Stability Test - Sending ${stabilityTxCountPerBatch} transactions back and forth between participants for ${stabilityDurationMin} min straight`, async function () {
      LOGGER.info(`Starting stability test`);

      const tokenAmountPerTx = 1;
      const endTime = stabilityDurationMin * 60 * 1000 + Date.now();

      if (stabilityTxCountPerBatch < stabilityTxCount) {
        LOGGER.info(`Reducing the number of txs per batch to ${stabilityTxCountPerBatch} to avoid exceeding the block gas limit`);
      }

      const [pnA, pnB, pnC, pnD] = participants;

      const batchAtoB = createBatchWithSameDest(pnA, pnB, stabilityTxCountPerBatch, tokenAmountPerTx, batchTokenWrappers[pnB.chainId].userWallet.address);
      const batchBtoC = createBatchWithSameDest(pnB, pnC, stabilityTxCountPerBatch, tokenAmountPerTx, batchTokenWrappers[pnC.chainId].userWallet.address);
      const batchCtoD = createBatchWithSameDest(pnC, pnD, stabilityTxCountPerBatch, tokenAmountPerTx, batchTokenWrappers[pnD.chainId].userWallet.address);
      const batchDtoA = createBatchWithSameDest(pnD, pnA, stabilityTxCountPerBatch, tokenAmountPerTx, batchTokenWrappers[pnA.chainId].userWallet.address);

      const tokenOnPNA = getBatchTokenFor(pnA);
      const tokenOnPNB = getBatchTokenFor(pnB);
      const tokenOnPNC = getBatchTokenFor(pnC);
      const tokenOnPND = getBatchTokenFor(pnD);

      const batchWithReceiverBalanceAtoB = await fetchDestBalancesOfBatch(combineBatchTxWithSameDest(batchAtoB));
      const batchWithReceiverBalanceBtoC = await fetchDestBalancesOfBatch(combineBatchTxWithSameDest(batchBtoC));
      const batchWithReceiverBalanceCtoD = await fetchDestBalancesOfBatch(combineBatchTxWithSameDest(batchCtoD));
      const batchWithReceiverBalanceDtoA = await fetchDestBalancesOfBatch(combineBatchTxWithSameDest(batchDtoA));

      const receiverBalanceOnPNA = batchWithReceiverBalanceDtoA[0].receiverBalanceBefore;
      const receiverBalanceOnPNB = batchWithReceiverBalanceAtoB[0].receiverBalanceBefore;
      const receiverBalanceOnPNC = batchWithReceiverBalanceBtoC[0].receiverBalanceBefore;
      const receiverBalanceOnPND = batchWithReceiverBalanceCtoD[0].receiverBalanceBefore;

      const iterations = {
        [pnA.node]: 0,
        [pnB.node]: 0,
        [pnC.node]: 0,
        [pnD.node]: 0,
      };

      const executionStartTime = Date.now();
      let now = Date.now();
      let totalIterations = 0;

      while (now < endTime) {
        LOGGER.log(`Executing batch teleports with ${stabilityTxCountPerBatch}txs`);

        const rA = await executeBatchTeleports(batchAtoB, tokenOnPNA, true);
        const rB = await executeBatchTeleports(batchBtoC, tokenOnPNB, true);
        const rC = await executeBatchTeleports(batchCtoD, tokenOnPNC, true);
        const rD = await executeBatchTeleports(batchDtoA, tokenOnPND, true);

        await delay(stabiltyTxDelayMs);

        now = Date.now();
        totalIterations++;

        if (rA?.status === 1) iterations[pnA.node]++;
        if (rB?.status === 1) iterations[pnB.node]++;
        if (rC?.status === 1) iterations[pnC.node]++;
        if (rD?.status === 1) iterations[pnD.node]++;
      }

      const totalTxSentPerPNA = stabilityTxCountPerBatch * iterations[pnA.node];
      const totalTxSentPerPNB = stabilityTxCountPerBatch * iterations[pnB.node];
      const totalTxSentPerPNC = stabilityTxCountPerBatch * iterations[pnC.node];
      const totalTxSentPerPND = stabilityTxCountPerBatch * iterations[pnD.node];

      LOGGER.info(`Stability test completed. Waiting for balances to be updated`);
      LOGGER.log(`Sent total of ${totalTxSentPerPNA}txs on PN ${pnA.node} in ${iterations[pnA.node]}/${totalIterations} cycles`);
      LOGGER.log(`Sent total of ${totalTxSentPerPNB}txs on PN ${pnB.node} in ${iterations[pnB.node]}/${totalIterations} cycles`);
      LOGGER.log(`Sent total of ${totalTxSentPerPNC}txs on PN ${pnC.node} in ${iterations[pnC.node]}/${totalIterations} cycles`);
      LOGGER.log(`Sent total of ${totalTxSentPerPND}txs on PN ${pnD.node} in ${iterations[pnD.node]}/${totalIterations} cycles`);

      const txFinalAtoB = { ...batchWithReceiverBalanceAtoB[0].tx, value: tokenAmountPerTx * totalTxSentPerPNA };
      const txFinalBtoC = { ...batchWithReceiverBalanceBtoC[0].tx, value: tokenAmountPerTx * totalTxSentPerPNB };
      const txFinalCtoD = { ...batchWithReceiverBalanceCtoD[0].tx, value: tokenAmountPerTx * totalTxSentPerPNC };
      const txFinalDtoA = { ...batchWithReceiverBalanceDtoA[0].tx, value: tokenAmountPerTx * totalTxSentPerPND };

      const tpsInputs = await Promise.all([
        waitUntilTokensAreTransferred(txFinalAtoB, receiverBalanceOnPNB).then(() => createTPSInput(txFinalAtoB, totalTxSentPerPNA, executionStartTime)),
        waitUntilTokensAreTransferred(txFinalBtoC, receiverBalanceOnPNC).then(() => createTPSInput(txFinalBtoC, totalTxSentPerPNB, executionStartTime)),
        waitUntilTokensAreTransferred(txFinalCtoD, receiverBalanceOnPND).then(() => createTPSInput(txFinalCtoD, totalTxSentPerPNC, executionStartTime)),
        waitUntilTokensAreTransferred(txFinalDtoA, receiverBalanceOnPNA).then(() => createTPSInput(txFinalDtoA, totalTxSentPerPND, executionStartTime)),
      ]);

      reportTPS(tpsInputs, { testType: 'Atomic Mesh Performance Test', methodology: 'Calculate TPS per direction (totalTx/elapsedSeconds) and report the average across directions for the mesh scenario.' });
    }).timeout(STABILITY_TEST_TIMEOUT);
  });

  describe('Bulk Transfer - send tokens between participants', function () {

    function prepareSingleTokenSendTx(source: PrivacyNode, destination: PrivacyNode, value: number, to: string): TokenSendTx {
      return {
        source,
        destination,
        to,
        value,
        resourceId: getSingleTokenResourceId(source),
        resourceType: 'ProductionErc20Token',
      };
    }

    const deployExternalTokenTask = async (source: PrivacyNode, destination: PrivacyNode, nonce: number) => {
      const tx = prepareSingleTokenSendTx(source, destination, 1, singleTokenWrappers[destination.chainId].userWallet.address);
      const direction = `${tx.source.node} -> ${tx.destination.node}`;
      const token = singleTokenWrappers[source.chainId].contract;
      const receiverBalanceBefore = await getDestinationTokenBalance(tx.destination, tx.resourceId, tx.resourceType, tx.to);

      LOGGER.info(`${direction} Deploying token`);
      LOGGER.log(`${direction} Nonce=${nonce}`);

      await token.teleport(tx.to, tx.value, tx.destination.chainId, { nonce });
      await waitUntilTokensAreTransferred(tx, receiverBalanceBefore, true);
    };

    it('Deploy external tokens to all participants', async function () {
      const deployments: Promise<any>[] = [];

      await everyoneToAllParticipants(participants, async (source, destinations) => {
        let nonce = await singleTokenWrappers[source.chainId].userWallet.getNonce();

        for (const destination of destinations) {
          await delay(1000);
          deployments.push(deployExternalTokenTask(source, destination, nonce));
          nonce++;
        }
      });

      await Promise.all(deployments);
    }).timeout(NORMAL_TEST_TIMEOUT);

    it(`Many to One - 3 PNs sends ${performanceTxCount} atomic transactions each to PN A`, async function () {
      const teleports: Promise<any>[] = [];
      const [pnA] = participants;

      const send = async (source: PrivacyNode, destination: PrivacyNode, nonce: number) => {
        await delay(performanceTxDelayMs);
        teleports.push(trackTime(async () => executeBulkTeleports(source, destination, 1, singleTokenWrappers[destination.chainId].userWallet.address, nonce, performanceTxCount, true)));
      };

      const nonceB = await singleTokenWrappers[privacyNodes.B.chainId].userWallet.getNonce();
      const nonceC = await singleTokenWrappers[privacyNodes.C.chainId].userWallet.getNonce();
      const nonceD = await singleTokenWrappers[privacyNodes.D.chainId].userWallet.getNonce();

      await send(privacyNodes.B, pnA, nonceB);
      await send(privacyNodes.C, pnA, nonceC);
      await send(privacyNodes.D, pnA, nonceD);

      reportTPS(await Promise.all(teleports), { testType: 'Atomic Mesh Performance Test', methodology: 'Calculate TPS per direction (totalTx/elapsedSeconds) and report the average across directions for the mesh scenario.' });
    }).timeout(NORMAL_TEST_TIMEOUT);

    it(`One to Many - PN A sends ${performanceTxCount} atomic transactions to the others`, async function () {
      const teleportTokens: Promise<any>[] = [];
      const [pnA, pnB, pnC, pnD] = participants;

      const send = async (source: PrivacyNode, destination: PrivacyNode, nonce: number, txCount: number) => {
        await delay(1000);
        teleportTokens.push(trackTime(async () => executeBulkTeleports(source, destination, 1, singleTokenWrappers[destination.chainId].userWallet.address, nonce, txCount, true)));
      };

      const nonceAtoB = await singleTokenWrappers[pnA.chainId].userWallet.getNonce();
      const nonceAtoC = nonceAtoB + performanceTxCount;
      const nonceAtoD = nonceAtoC + performanceTxCount;

      await send(pnA, pnB, nonceAtoB, performanceTxCount);
      await send(pnA, pnC, nonceAtoC, performanceTxCount);
      await send(pnA, pnD, nonceAtoD, performanceTxCount);

      reportTPS(await Promise.all(teleportTokens), { testType: 'Atomic Mesh Performance Test', methodology: 'Calculate TPS per direction (totalTx/elapsedSeconds) and report the average across directions for the mesh scenario.' });
    }).timeout(NORMAL_TEST_TIMEOUT);

    it(`Everyone to Everyone - Every participant sends ${performanceTxCount} vanila transactions to every other participant`, async function () {
      const teleportTokens: Promise<any>[] = [];

      await everyoneToAllParticipants(participants, async (source, destinations) => {
        let nonce = await singleTokenWrappers[source.chainId].userWallet.getNonce();

        for (const destination of destinations) {
          await delay(performanceTxDelayMs);
          teleportTokens.push(trackTime(() => executeBulkTeleports(source, destination, 1, singleTokenWrappers[destination.chainId].userWallet.address, nonce, performanceTxCount, false)));
          nonce += performanceTxCount;
        }
      });

      reportTPS(await Promise.all(teleportTokens), { testType: 'Atomic Mesh Performance Test', methodology: 'Calculate TPS per direction (totalTx/elapsedSeconds) and report the average across directions for the mesh scenario.' });
    }).timeout(NORMAL_TEST_TIMEOUT);

    it(`Everyone to Everyone - Every participant sends ${performanceTxCount} atomic transactions to every other participant`, async function () {
      const teleportTokens: Promise<any>[] = [];

      await everyoneToAllParticipants(participants, async (source, destinations) => {
        let nonce = await singleTokenWrappers[source.chainId].userWallet.getNonce();

        for (const destination of destinations) {
          await delay(performanceTxDelayMs);
          teleportTokens.push(trackTime(async () => executeBulkTeleports(source, destination, 1, singleTokenWrappers[destination.chainId].userWallet.address, nonce, performanceTxCount, true)));
          nonce += performanceTxCount;
        }
      });

      reportTPS(await Promise.all(teleportTokens), { testType: 'Atomic Mesh Performance Test', methodology: 'Calculate TPS per direction (totalTx/elapsedSeconds) and report the average across directions for the mesh scenario.' });
    }).timeout(NORMAL_TEST_TIMEOUT);

    it(`Stability Test - Sending ${stabilityTxCount} transactions back and forth between participants for ${stabilityDurationMin} min straight`, async function () {
      LOGGER.info(`Starting stability test`);

      const tokenAmountPerTx = 1;
      const endTime = stabilityDurationMin * 60 * 1000 + Date.now();
      const [pnA, pnB, pnC, pnD] = participants;

      let noncePNA = await singleTokenWrappers[pnA.chainId].userWallet.getNonce();
      let noncePNB = await singleTokenWrappers[pnB.chainId].userWallet.getNonce();
      let noncePNC = await singleTokenWrappers[pnC.chainId].userWallet.getNonce();
      let noncePND = await singleTokenWrappers[pnD.chainId].userWallet.getNonce();

      const txAtoB = prepareSingleTokenSendTx(pnA, pnB, tokenAmountPerTx, singleTokenWrappers[pnB.chainId].userWallet.address);
      const txBtoC = prepareSingleTokenSendTx(pnB, pnC, tokenAmountPerTx, singleTokenWrappers[pnC.chainId].userWallet.address);
      const txCtoD = prepareSingleTokenSendTx(pnC, pnD, tokenAmountPerTx, singleTokenWrappers[pnD.chainId].userWallet.address);
      const txDtoA = prepareSingleTokenSendTx(pnD, pnA, tokenAmountPerTx, singleTokenWrappers[pnA.chainId].userWallet.address);

      const receiverBalanceOnPNB = await getDestinationTokenBalance(txAtoB.destination, txAtoB.resourceId, txAtoB.resourceType, txAtoB.to);
      const receiverBalanceOnPNC = await getDestinationTokenBalance(txBtoC.destination, txBtoC.resourceId, txBtoC.resourceType, txBtoC.to);
      const receiverBalanceOnPND = await getDestinationTokenBalance(txCtoD.destination, txCtoD.resourceId, txCtoD.resourceType, txCtoD.to);
      const receiverBalanceOnPNA = await getDestinationTokenBalance(txDtoA.destination, txDtoA.resourceId, txDtoA.resourceType, txDtoA.to);

      const executionStartTime = Date.now();
      let now = Date.now();
      let totalIterations = 0;

      while (now < endTime) {
        await transferTokensInBulk(txAtoB, stabilityTxCount, noncePNA, true);
        await transferTokensInBulk(txBtoC, stabilityTxCount, noncePNB, true);
        await transferTokensInBulk(txCtoD, stabilityTxCount, noncePNC, true);
        await transferTokensInBulk(txDtoA, stabilityTxCount, noncePND, true);

        await delay(stabiltyTxDelayMs);

        noncePNA += stabilityTxCount;
        noncePNB += stabilityTxCount;
        noncePNC += stabilityTxCount;
        noncePND += stabilityTxCount;

        now = Date.now();
        totalIterations++;
      }

      const totalTxSentPerPN = stabilityTxCount * totalIterations;
      LOGGER.info(`Stability test completed. Sent total of ${totalTxSentPerPN * 4}txs between ${4} PNs in ${totalIterations} cycles. Waiting for balances to be updated`);

      const txFinalAtoB = { ...txAtoB, value: txAtoB.value * totalTxSentPerPN };
      const txFinalBtoC = { ...txBtoC, value: txBtoC.value * totalTxSentPerPN };
      const txFinalCtoD = { ...txCtoD, value: txCtoD.value * totalTxSentPerPN };
      const txFinalDtoA = { ...txDtoA, value: txDtoA.value * totalTxSentPerPN };

      const tpsInputs = await Promise.all([
        waitUntilTokensAreTransferred(txFinalAtoB, receiverBalanceOnPNB).then(() => createTPSInput(txFinalAtoB, totalTxSentPerPN, executionStartTime)),
        waitUntilTokensAreTransferred(txFinalBtoC, receiverBalanceOnPNC).then(() => createTPSInput(txFinalBtoC, totalTxSentPerPN, executionStartTime)),
        waitUntilTokensAreTransferred(txFinalCtoD, receiverBalanceOnPND).then(() => createTPSInput(txFinalCtoD, totalTxSentPerPN, executionStartTime)),
        waitUntilTokensAreTransferred(txFinalDtoA, receiverBalanceOnPNA).then(() => createTPSInput(txFinalDtoA, totalTxSentPerPN, executionStartTime)),
      ]);

      reportTPS(tpsInputs, { testType: 'Atomic Mesh Performance Test', methodology: 'Calculate TPS per direction (totalTx/elapsedSeconds) and report the average across directions for the mesh scenario.' });
    }).timeout(STABILITY_TEST_TIMEOUT);

    async function executeBulkTeleports(source: PrivacyNode, destination: PrivacyNode, amount: number, to: string, nonce: number, txCount: number, isAtomic: boolean) {
      const tx = { source, destination, to, value: amount, resourceId: getSingleTokenResourceId(source), resourceType: 'ProductionErc20Token' as const };
      const direction = `${source.node} -> ${destination.node}`;
      const receiverBalanceBefore = await getDestinationTokenBalance(destination, tx.resourceId, tx.resourceType, to);

      LOGGER.info(`${direction} Sending ${txCount} transactions to ${to}`);
      await transferTokensInBulk(tx, txCount, nonce, isAtomic);
      LOGGER.info(`${direction} Sent ${txCount} transactions to ${to}`);

      const finalTx = { ...tx, value: txCount * amount };
      await waitUntilTokensAreTransferred(finalTx, receiverBalanceBefore);

      return { totalTxCount: txCount, direction };
    }

    async function transferTokensInBulk(tx: TokenSendTx, txCount: number, nonce: number, isAtomic: boolean) {
      const direction = `${tx.source.node} -> ${tx.destination.node}`;
      LOGGER.log(`${direction} Nonce: ${nonce}`);

      const tokenAddress = singleTokenWrappers[tx.source.chainId].address[tx.source.chainId];
      const builder = new TransactionBuilder(
        ProductionErc20Token__factory.abi,
        tokenAddress,
        singleTokenWrappers[tx.source.chainId].userWallet.privateKey,
        Number(tx.source.chainId)
      );

      const signed: string[] = [];
      for (let i = 0; i < txCount; i++) {
        const raw = await builder.sign(
          isAtomic ? 'teleportAtomic' : 'teleport',
          [tx.to, BigInt(tx.value), tx.destination.chainId],
          nonce + i
        );
        signed.push(raw);
      }

      await TransactionSender.sendBatchRawTransactions(signed, tx.source.rpcUrl, 'AtomicMesh.bulk');
    }
  });

  async function waitUntilTokensAreTransferred(tx: TokenSendTx, receiverBalanceBefore: bigint, waitForDeployment = false) {
    const { source, destination, to, value, resourceType, resourceId } = tx;
    const direction = `${source.node} -> ${destination.node}`;
    const receiverBalanceAfter = receiverBalanceBefore + BigInt(value);
    const destEndpoint = destination.getContract<EndpointV1>('EndpointV1');

    if (waitForDeployment) {
      LOGGER.log(`${direction} Polling until token is deployed`);

      const deployed = await eventually<boolean>({
        check: async (): Promise<boolean> => {
          const tokenAddress = await destEndpoint.getAddressByResourceId(resourceId);
          return tokenAddress !== ethers.ZeroAddress;
        },
        interval: POLLING_TOKEN_SETUP_TIMEOUT[0],
        attempts: POLLING_TOKEN_SETUP_TIMEOUT[1],
        message: `Waiting for ${direction} ${resourceType} deployed (rid=${shortHex(resourceId)})`,
      });

      expect(deployed, `${direction} ${resourceType} token deployment failed in the specified timeout`).to.be.true;
    }

    const tokenOnDestPLAddress = await destEndpoint.getAddressByResourceId(resourceId);
    const tokenOnDestPL = await hre.ethers.getContractAt(resourceType, tokenOnDestPLAddress, singleTokenWrappers[destination.chainId].userWallet.connect(destination.provider));

    LOGGER.log(`${direction} Token vault: ${tokenOnDestPLAddress}`);
    LOGGER.log(`${direction} Polling until receiver balance is updated, initial=${receiverBalanceBefore} expected=${receiverBalanceAfter} token=${await tokenOnDestPL.getAddress()}`);

    const receiverBalanceMatchExpectedAmount = await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const balance = await (tokenOnDestPL as any).balanceOf(to);
        return balance === receiverBalanceAfter;
      },
      interval: POLLING_BALANCES_TIMEOUT[0],
      attempts: POLLING_BALANCES_TIMEOUT[1],
      message: `Waiting for ${direction} ${resourceType} balance → ${receiverBalanceAfter} for ${shortHex(to)}`,
    });

    expect(receiverBalanceMatchExpectedAmount, `${direction} Receiver balance were not updated in the specified timeout`).to.be.true;
    LOGGER.info(`${direction} Tokens were transferred successfully`);

    return tx;
  }
});

async function getDestinationTokenBalance(pl: PrivacyNode, resourceId: string, resourceType: string, account: string) {
  const endpoint = pl.getContract<EndpointV1>('EndpointV1');
  const tokenAddress = await endpoint.getAddressByResourceId(resourceId);

  if (tokenAddress !== ethers.ZeroAddress) {
    const token = await hre.ethers.getContractAt(resourceType, tokenAddress, pl.adminWallet);
    return await (token as any).balanceOf(account);
  }

  return BigInt(0);
}

function createTPSInput(txFinal: TokenSendTx, totalTxCount: number, executionStartTime: number): TPSInput {
  return {
    result: { totalTxCount, direction: `${txFinal.source.node} -> ${txFinal.destination.node}` },
    elapsedTime: (Date.now() - executionStartTime) / 1000,
  };
}
