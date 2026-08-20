import { ParticipantStorageV1, ParticipantStorageReplicaV1__factory, PNTokenRegistryV1, TokenRegistryV1 } from '../../typechain-types';
import { GAS_LIMIT, LOGGER, ZERO_ADDRESS } from '../../src/config/env-config';
import { eventually, retry, submitTx, waitForReceipt } from '../../src/utils/common';
import { shortHex } from '../../src/utils/formatters';
import { isNonceError } from '../../src/exceptions-and-errors/block-chain-exceptions';
import { PrivacyNode } from '../../src/entities/PrivacyNode';
import { PrivateHub } from '../../src/entities/PrivateHub';

/**
 * Pair of replica and chainId for freeze status synchronization.
 */
export type ReplicaChainPair = { replica: PNTokenRegistryV1; chainId: string };

/**
 * Polls freeze status for a list of chainIds on a replica until all match the expected value.
 *
 * The PN registry's `getFrozenTokenForParticipant` is `restricted`, so `registry` must be an
 * ADMIN-connected handle (`PrivacyNode.getPnTokenRegistry(adminWallet)`).
 */
async function pollAllFrozenOnReplica(
  registry: PNTokenRegistryV1,
  resourceId: string,
  chainIds: string[],
  expected = true,
  interval = 1000,
  maxAttempts = 240
): Promise<boolean> {
  // Identify the replica in the message so parallel polls across multiple replicas
  // (e.g. unfreezeAndSync fans out one poll per replica) are distinguishable in logs.
  const replicaAddress = await registry.getAddress();
  return eventually<boolean>({
    check: async () => {
      const statuses = await Promise.all(
        chainIds.map(chainId => registry.getFrozenTokenForParticipant(resourceId, chainId))
      );
      return statuses.every(status => status === expected);
    },
    interval: interval,
    attempts: maxAttempts,
    message: `Waiting for chains [${chainIds.join(',')}] freeze → ${expected} (replica=${shortHex(replicaAddress)}, rid=${shortHex(resourceId)})`,
  });
}

/**
 * Freezes a token on the hub for the specified chainIds and waits until all replicas confirm the frozen status.
 *
 * @param registry TokenRegistryV1 instance
 * @param resourceId Token resourceId
 * @param chainIds Chains to freeze
 * @param replicasToSync Replica/chainId pairs to polling for sync confirmation
 */
export async function freezeAndSync(
  registry: TokenRegistryV1,
  resourceId: string,
  chainIds: string[],
  replicasToSync: ReplicaChainPair[]
): Promise<void> {
  LOGGER.info(`Freezing token ${resourceId} for chains [${chainIds.join(', ')}]`);
  await retry(
    async () => { const tx = await registry.freezeToken(resourceId, chainIds); await waitForReceipt(tx); },
    { attempts: 5, delayMs: 500,
      retryIf: (err) => isNonceError(err) || err?.message?.includes('Receipt timeout'),
      onRetry: (_err, i) => LOGGER.log(`[NONCE RETRY] freezeToken attempt ${i}/5`) }
  );

  await Promise.all(
    replicasToSync.map(({ replica, chainId }) => pollAllFrozenOnReplica(replica, resourceId, [chainId], true))
  );
}

/**
 * Checks each token/chain combination and unfreezes any that are frozen.
 * Pass all replicas that should confirm the unfreeze sync.
 * Use in afterEach as a uniform cleanup across all freeze test files.
 */
export async function cleanupFrozenTokens(
  registry: TokenRegistryV1,
  replicas: PNTokenRegistryV1[],
  tokens: { resourceId: string; chainIds: string[] }[]
): Promise<void> {
  for (const { resourceId, chainIds } of tokens) {
    for (const chainId of chainIds) {
      try {
        if (await registry.isTokenFrozenForParticipant(resourceId, chainId)) {
          await unfreezeAndSync(registry, resourceId, [chainId], replicas.map(replica => ({ replica, chainId })));
        }
      } catch (err: any) {
        LOGGER.log(`[CLEANUP] Failed to unfreeze ${resourceId} for chain ${chainId}: ${err?.message ?? err}`);
      }
    }
  }
}

/**
 * Unfreezes a token on the hub for the specified chainIds and waits until all replicas confirm the unfrozen status.
 * Use in afterEach to guarantee clean state before the next test.
 *
 * @param registry TokenRegistryV1 instance
 * @param resourceId Token resourceId
 * @param chainIds Chains to unfreeze
 * @param replicasToSync Replica/chainId pairs to polling for sync confirmation
 */
export async function unfreezeAndSync(
  registry: TokenRegistryV1,
  resourceId: string,
  chainIds: string[],
  replicasToSync: ReplicaChainPair[]
): Promise<void> {
  LOGGER.info(`Unfreezing token ${resourceId} for chains [${chainIds.join(', ')}]`);
  await retry(
    async () => { const tx = await registry.unfreezeToken(resourceId, chainIds); await waitForReceipt(tx); },
    { attempts: 5, delayMs: 1000,
      retryIf: (err) => isNonceError(err) || err?.message?.includes('Receipt timeout') || err?.code === 'CALL_EXCEPTION',
      onRetry: (_err, i) => LOGGER.log(`[RETRY] unfreezeToken attempt ${i}/5`) }
  );

  await Promise.all(
    replicasToSync.map(({ replica, chainId }) => pollAllFrozenOnReplica(replica, resourceId, [chainId], false))
  );
}

// ---------------------------------------------------------------------------
// PN-layer freeze (freezeOnPrivacyNode) — a LOCAL write on a single node's registry, distinct from the
// hub compliance freeze above. It flips the token's `privacyNodeStatus` to FROZEN with no hub broadcast /
// relayer sync, so the submitTx receipt is the confirmation (no replica polling). A teleport from a
// PN-frozen source reverts `RaylsApp__PrivacyNodeFrozen` on the token contract (whenHubActive modifier).
// Freeze is NOT idempotent — re-freezing corrupts the saved before-status — so freeze once and guard
// cleanup on the current status.
// ---------------------------------------------------------------------------

const PN_STATUS_FROZEN = 4; // TokenStructs.PrivacyNodeStatus.FROZEN

/**
 * PN-layer freeze: freezes a token on the given node's registry and confirms `privacyNodeStatus == FROZEN`.
 * `registry` must be admin-connected (`getPnTokenRegistry(adminWallet)`) — `freezeOnPrivacyNode` is restricted.
 */
export async function freezeOnPn(registry: PNTokenRegistryV1, tokenAddress: string): Promise<void> {
  await submitTx(
    () => registry.freezeOnPrivacyNode(tokenAddress, { gasLimit: GAS_LIMIT }),
    `PN-freezing ${shortHex(tokenAddress)}`,
  );
  await eventually<boolean>({
    check: async () => Number(await registry.getPrivacyNodeStatus(tokenAddress)) === PN_STATUS_FROZEN,
    message: `Waiting for ${shortHex(tokenAddress)} privacyNodeStatus → FROZEN`,
    tolerateErrors: true,
  });
}

/** PN-layer unfreeze: restores the token's pre-freeze status and confirms it is no longer FROZEN. */
export async function unfreezeOnPn(registry: PNTokenRegistryV1, tokenAddress: string): Promise<void> {
  await submitTx(
    () => registry.unfreezeOnPrivacyNode(tokenAddress, { gasLimit: GAS_LIMIT }),
    `PN-unfreezing ${shortHex(tokenAddress)}`,
  );
  await eventually<boolean>({
    check: async () => Number(await registry.getPrivacyNodeStatus(tokenAddress)) !== PN_STATUS_FROZEN,
    message: `Waiting for ${shortHex(tokenAddress)} privacyNodeStatus → not FROZEN`,
    tolerateErrors: true,
  });
}

/**
 * afterEach cleanup for PN-layer freeze: unfreezes only the tokens currently PN-frozen (freeze is not
 * idempotent, so unfreezing an already-active token would revert).
 */
export async function cleanupPnFrozenTokens(registry: PNTokenRegistryV1, tokenAddresses: string[]): Promise<void> {
  for (const addr of tokenAddresses) {
    try {
      if (Number(await registry.getPrivacyNodeStatus(addr)) === PN_STATUS_FROZEN)
        await unfreezeOnPn(registry, addr);
    } catch (err: any) {
      LOGGER.log(`[CLEANUP] Failed to PN-unfreeze ${shortHex(addr)}: ${err?.message ?? err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// PublicChain-layer freeze (freezeOnPublicChain) — a LOCAL write on a single node's registry, distinct
// from both the hub compliance freeze and the PN-layer freeze above. It flips the token's
// `publicChainStatus` to FROZEN (stashing the prior status, restored on unfreeze) with no hub broadcast /
// relayer sync, so the submitTx receipt is the confirmation. Only a token already DEPLOYED on the public
// chain can be frozen. A `teleportToPublicChain` from a public-frozen token reverts
// `RaylsApp__PublicChainNotActive` on the token contract (whenPublicChainActive modifier: it requires
// publicChainStatus == DEPLOYED). Freeze is NOT idempotent — double-freeze / unfreeze-when-not-frozen
// revert `TokenCoreV1__StatusAlreadySet` — so freeze once and guard cleanup on the current status.
// ---------------------------------------------------------------------------

const PUBLIC_CHAIN_STATUS_FROZEN = 3; // TokenStructs.PublicChainStatus.FROZEN

/**
 * PublicChain-layer freeze: freezes a token on the given node's registry and confirms
 * `publicChainStatus == FROZEN`. `registry` must be admin-connected (`getPnTokenRegistry(adminWallet)`) —
 * `freezeOnPublicChain` is restricted.
 */
export async function freezeOnPublicChain(registry: PNTokenRegistryV1, tokenAddress: string): Promise<void> {
  await submitTx(
    () => registry.freezeOnPublicChain(tokenAddress, { gasLimit: GAS_LIMIT }),
    `Public-freezing ${shortHex(tokenAddress)}`,
  );
  await eventually<boolean>({
    check: async () => Number(await registry.getPublicChainStatus(tokenAddress)) === PUBLIC_CHAIN_STATUS_FROZEN,
    message: `Waiting for ${shortHex(tokenAddress)} publicChainStatus → FROZEN`,
    tolerateErrors: true,
  });
}

/** PublicChain-layer unfreeze: restores the token's pre-freeze status and confirms it is no longer FROZEN. */
export async function unfreezeOnPublicChain(registry: PNTokenRegistryV1, tokenAddress: string): Promise<void> {
  await submitTx(
    () => registry.unfreezeOnPublicChain(tokenAddress, { gasLimit: GAS_LIMIT }),
    `Public-unfreezing ${shortHex(tokenAddress)}`,
  );
  await eventually<boolean>({
    check: async () => Number(await registry.getPublicChainStatus(tokenAddress)) !== PUBLIC_CHAIN_STATUS_FROZEN,
    message: `Waiting for ${shortHex(tokenAddress)} publicChainStatus → not FROZEN`,
    tolerateErrors: true,
  });
}

/**
 * afterEach cleanup for PublicChain-layer freeze: unfreezes only the tokens currently public-frozen (freeze
 * is not idempotent, so unfreezing an already-active token would revert).
 */
export async function cleanupPublicFrozenTokens(registry: PNTokenRegistryV1, tokenAddresses: string[]): Promise<void> {
  for (const addr of tokenAddresses) {
    try {
      if (Number(await registry.getPublicChainStatus(addr)) === PUBLIC_CHAIN_STATUS_FROZEN)
        await unfreezeOnPublicChain(registry, addr);
    } catch (err: any) {
      LOGGER.log(`[CLEANUP] Failed to public-unfreeze ${shortHex(addr)}: ${err?.message ?? err}`);
    }
  }
}

/**
 * Triggers a ParticipantStorageReplica sync on each PL by calling
 * requestAllParticipantsDataFromPrivateHub, then polls until a specific
 * participant shows the expected status on all replicas.
 */
export async function syncParticipantStatusOnReplicas(
  privateHub: PrivateHub,
  nodes: PrivacyNode[],
  chainId: string,
  expectedStatus: bigint,
  maxAttempts = 30,
  interval = 2000,
): Promise<void> {
  const psResourceId = await privateHub.getContract<ParticipantStorageV1>('ParticipantStorageV1').resourceId();

  for (const node of nodes) {
    const replicaAddr = await node.getEndpointV1().getAddressByResourceId(psResourceId);
    if (replicaAddr === ZERO_ADDRESS) continue;
    const replica = ParticipantStorageReplicaV1__factory.connect(replicaAddr, node.adminWallet);
    await replica.requestAllParticipantsDataFromPrivateHub({ gasLimit: GAS_LIMIT });
  }

  await eventually<boolean>({
    check: async () => {
      for (const node of nodes) {
        const replicaAddr = await node.getEndpointV1().getAddressByResourceId(psResourceId);
        if (replicaAddr === ZERO_ADDRESS) continue;
        const replica = ParticipantStorageReplicaV1__factory.connect(replicaAddr, node.adminWallet);
        const participants = await replica.getAllParticipants();
        const p = participants.find(pp => pp.chainId === BigInt(chainId));
        if (!p || p.status !== expectedStatus) return false;
      }
      return true;
    },
    interval: interval,
    attempts: maxAttempts,
    message: `Waiting for chain ${chainId} status → ${expectedStatus} on all replicas`,
  });
}