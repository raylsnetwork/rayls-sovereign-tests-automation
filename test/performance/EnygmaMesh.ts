import { ProductionEnygmaToken, ProductionEnygmaToken__factory } from '../../typechain-types';
import { EnygmaWrapper } from '../../src/entities/tokens/EnygmaWrapper';
import { LOGGER } from '../../src/config/env-config';
import { PrivateHub } from '../../src/entities/PrivateHub';
import { PrivacyNode } from '../../src/entities/PrivacyNode';
import { initializePrivacyNodesAndPnh } from '../setup';
import { delay, eventually } from '../../src/utils/common';
import { TransactionBuilder } from '../test-utils/transaction-builder';
import { TransactionSender } from '../test-utils/transaction-sender';
import {
  TPSInput,
  everyoneToAllParticipants,
  trackTime,
  waitForBalance,
  reportTPS,
} from '../test-utils/mesh-helpers';

const NORMAL_TEST_TIMEOUT = 20 * 60 * 1000;
const STABILITY_TEST_TIMEOUT = 120 * 60 * 1000;
const POLLING_BALANCE_TIMEOUT: [number, number] = [3000, 3600];

const MINT_AMOUNT = BigInt(10_000_000);
const WARMUP_AMOUNT = 1n;
const MESH_METHODOLOGY = 'Each node transfers to all others via Enygma crossTransfer in a full mesh. TPS calculated per direction (totalTx/elapsedSeconds), averaged across all directions.';

type Direction = { source: PrivacyNode; destination: PrivacyNode };

describe('Enygma Mesh tests', function () {
  const txCount = parseInt(process.env['ENYGMA_MESH_TX_COUNT'] || '10');
  const stabilityDurationMin = parseFloat(process.env['ENYGMA_MESH_STABILITY_DURATION_MIN'] || '2');
  const txDelayMs = parseFloat(process.env['ENYGMA_MESH_DELAY_SEC'] || '1') * 1000;
  const stabilityTxDelayMs = parseFloat(process.env['ENYGMA_MESH_STABILITY_DELAY_SEC'] || '2') * 1000;

  let participants: PrivacyNode[];
  let privacyNodes: { [node: string]: PrivacyNode };
  let privateHub: PrivateHub;
  // One EnygmaWrapper per source node (token lives on that source node)
  let tokenWrappers: Record<string, EnygmaWrapper<ProductionEnygmaToken>>;
  // destContracts[srcNode][destNode] = ProductionEnygmaToken contract on destNode for that token
  let destContracts: Record<string, Record<string, ProductionEnygmaToken>>;

  function getWrapper(pl: PrivacyNode) {
    return tokenWrappers[pl.node];
  }

  function getDestContract(source: PrivacyNode, dest: PrivacyNode): ProductionEnygmaToken {
    return destContracts[source.node][dest.node];
  }

  // Sends a warm-up crossTransfer from source to dest and waits for token deployment on dest
  async function warmUpDirection(source: PrivacyNode, dest: PrivacyNode): Promise<void> {
    const wrapper = getWrapper(source);
    const direction = `${source.node} -> ${dest.node}`;

    LOGGER.info(`${direction} Warm-up: sending initial crossTransfer to deploy token on dest`);

    const destWrapper = getWrapper(dest);
    const tx = await wrapper.contract.crossTransfer(
      [destWrapper.userWallet.address],
      [WARMUP_AMOUNT],
      [dest.chainId],
      [[]],
      { gasLimit: 5_000_000 }
    );
    await tx.wait();

    await eventually<boolean>({
      check: async () => {
        const endpointDest = dest.getContract<any>('EndpointV1');
        const addr = await endpointDest.getAddressByResourceId(wrapper.resourceId);
        if (addr === '0x0000000000000000000000000000000000000000') return false;

        wrapper.address[dest.chainId] = addr;
        await dest.getContractAt(ProductionEnygmaToken__factory.name, addr, wrapper.symbol);
        return true;
      },
      message: `${direction} Waiting for token deployed on ${dest.node}`,
    });

    destContracts[source.node][dest.node] = dest.getContract<ProductionEnygmaToken>(wrapper.symbol);

    // Wait for the warm-up balance to settle before returning, so the performance
    // test reads an accurate balanceBefore and the expected final balance is correct.
    await waitForBalance(
      () => destContracts[source.node][dest.node].balanceOf(destWrapper.userWallet.address),
      WARMUP_AMOUNT,
      `${direction} warm-up`,
      POLLING_BALANCE_TIMEOUT
    );

    LOGGER.info(`${direction} Token deployed on ${dest.node} at ${wrapper.address[dest.chainId]}`);
  }

  before(async function () {
    this.timeout(NORMAL_TEST_TIMEOUT);

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(4);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;
    participants = Object.values(privacyNodes);
    tokenWrappers = {};
    destContracts = {};

    for (const pl of participants) {
      const wrapper = new EnygmaWrapper<ProductionEnygmaToken>(pl, ProductionEnygmaToken__factory);
      await wrapper.deployViaFactory();
      await wrapper.activateOnPn();
      await wrapper.activateOnHub(privateHub);
      await wrapper.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: wrapper.userWallet.address });

      tokenWrappers[pl.node] = wrapper;
      destContracts[pl.node] = {};

      LOGGER.info(`PL ${pl.node} token deployed: ${wrapper.symbol}`);
    }
  });

  describe('Warm-up: deploy each token to all other participants', function () {
    it('Send initial crossTransfer from every node to all others', async function () {
      await everyoneToAllParticipants(participants, async (source, destinations) => {
        for (const dest of destinations) {
          await warmUpDirection(source, dest);
        }
      });
    }).timeout(NORMAL_TEST_TIMEOUT);
  });

  describe('Performance: everyone to everyone', function () {
    it(`Each participant sends ${txCount} crossTransfers to every other participant`, async function () {
      // Collect pending settlement promises across all directions so we fire all
      // batches first and wait for settlements in parallel at the end.
      const pendingSettlements: Promise<TPSInput>[] = [];

      await everyoneToAllParticipants(participants, async (source, destinations) => {
        const wrapper = getWrapper(source);
        const builder = new TransactionBuilder(
          ProductionEnygmaToken__factory.abi,
          wrapper.address[source.chainId],
          wrapper.userWallet.privateKey,
          Number(source.chainId)
        );

        let nonce = await source.provider.getTransactionCount(wrapper.userWallet.address);

        for (const dest of destinations) {
          await delay(txDelayMs);

          const direction = `${source.node} -> ${dest.node}`;
          const destContract = getDestContract(source, dest);
          const destWrapper = getWrapper(dest);
          const balanceBefore = await destContract.balanceOf(destWrapper.userWallet.address);
          const expectedBalance = balanceBefore + BigInt(txCount);

          LOGGER.info(`${direction} Signing ${txCount} crossTransfer txs`);
          const signed = await builder.signBatch(
            txCount,
            'crossTransfer',
            [[destWrapper.userWallet.address], [1], [dest.chainId], [[]]],
            nonce
          );
          nonce += txCount;

          const executionStartTime = Date.now();
          await TransactionSender.sendBatchRawTransactions(signed, source.rpcUrl, `EnygmaMesh.${direction}`);
          LOGGER.info(`${direction} Batch sent`);

          // Defer settlement wait — runs in parallel with other directions
          pendingSettlements.push(
            trackTime(async () => {
              await waitForBalance(() => destContract.balanceOf(destWrapper.userWallet.address), expectedBalance, direction, POLLING_BALANCE_TIMEOUT);
              return { totalTxCount: txCount, direction };
            }, executionStartTime)
          );
        }
      });

      LOGGER.info(`All batches submitted, waiting for ${pendingSettlements.length} settlements in parallel...`);
      const tpsInputs = await Promise.all(pendingSettlements);
      reportTPS(tpsInputs, { testType: 'Enygma Mesh Performance Test', rpnCount: 4, methodology: MESH_METHODOLOGY });
    }).timeout(NORMAL_TEST_TIMEOUT);
  });

  describe('Stability: ring transfers for a fixed duration', function () {
    it(`Ring A→B→C→D→A for ${process.env['ENYGMA_MESH_STABILITY_DURATION_MIN'] || '2'} minutes`, async function () {
      const [pnA, pnB, pnC, pnD] = participants;
      const endTime = Date.now() + stabilityDurationMin * 60 * 1000;

      const ring: Direction[] = [
        { source: pnA, destination: pnB },
        { source: pnB, destination: pnC },
        { source: pnC, destination: pnD },
        { source: pnD, destination: pnA },
      ];

      // Pre-fetch initial balances for ring destinations
      const initialBalances: Record<string, bigint> = {};
      for (const { source, destination } of ring) {
        const key = `${source.node}->${destination.node}`;
        initialBalances[key] = await getDestContract(source, destination).balanceOf(getWrapper(destination).userWallet.address);
      }

      const totalSent: Record<string, number> = Object.fromEntries(ring.map(({ source }) => [source.node, 0]));
      let totalIterations = 0;

      const builders = Object.fromEntries(
        ring.map(({ source }) => {
          const wrapper = getWrapper(source);
          return [
            source.node,
            new TransactionBuilder(
              ProductionEnygmaToken__factory.abi,
              wrapper.address[source.chainId],
              wrapper.userWallet.privateKey,
              Number(source.chainId)
            ),
          ];
        })
      );

      const nonces: Record<string, number> = {};
      for (const { source } of ring) {
        nonces[source.node] = await source.provider.getTransactionCount(getWrapper(source).userWallet.address);
      }

      const executionStartTime = Date.now();

      while (Date.now() < endTime) {
        LOGGER.log(`Stability iteration ${totalIterations + 1}`);

        await Promise.all(
          ring.map(async ({ source, destination }) => {
            const direction = `${source.node} -> ${destination.node}`;
            const builder = builders[source.node];
            const nonce = nonces[source.node];

            const signed = await builder.signBatch(
              1,
              'crossTransfer',
              [[getWrapper(destination).userWallet.address], [1], [destination.chainId], [[]]],
              nonce
            );

            try {
              await TransactionSender.sendBatchRawTransactions(signed, source.rpcUrl, `EnygmaMesh.stability.${direction}`);
              totalSent[source.node]++;
              nonces[source.node]++;
            } catch (e) {
              LOGGER.log(`${direction} batch failed: ${e}`);
            }
          })
        );

        await delay(stabilityTxDelayMs);
        totalIterations++;
      }

      LOGGER.info(`Stability phase complete. Waiting for final balances to settle...`);
      ring.forEach(({ source, destination }) => {
        LOGGER.log(`${source.node} -> ${destination.node} total sent: ${totalSent[source.node]} txs`);
      });

      const tpsInputs: TPSInput[] = await Promise.all(
        ring.map(async ({ source, destination }) => {
          const direction = `${source.node} -> ${destination.node}`;
          const key = `${source.node}->${destination.node}`;
          const sentCount = totalSent[source.node];
          const expectedBalance = initialBalances[key] + BigInt(sentCount);
          const destContract = getDestContract(source, destination);

          await waitForBalance(() => destContract.balanceOf(getWrapper(destination).userWallet.address), expectedBalance, direction, POLLING_BALANCE_TIMEOUT);

          return {
            result: { totalTxCount: sentCount, direction },
            elapsedTime: (Date.now() - executionStartTime) / 1000,
          };
        })
      );

      reportTPS(tpsInputs, { testType: 'Enygma Mesh Stability Test', rpnCount: 4, methodology: MESH_METHODOLOGY });
    }).timeout(STABILITY_TEST_TIMEOUT);
  });
});
