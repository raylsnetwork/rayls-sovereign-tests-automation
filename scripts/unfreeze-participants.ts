/**
 * Diagnose and fix frozen participants on PN replicas by triggering a sync from PNH.
 * Usage: npx hardhat run scripts/unfreeze-participants.ts
 */
import { PrivateHub } from '../src/entities/PrivateHub';
import { PrivacyNodeManager } from '../src/entities/PrivacyNodeManager';
import { PrivacyNode } from '../src/entities/PrivacyNode';
import { ParticipantStorageV1, ParticipantStorageReplicaV1__factory } from '../typechain-types';
import { GAS_LIMIT, ZERO_ADDRESS } from '../src/config/env-config';

const STATUS_ACTIVE = 1n;

async function main() {
  const privateHub = await PrivateHub.getInstance();
  const ps = privateHub.getContract<ParticipantStorageV1>('ParticipantStorageV1');
  const psResourceId = await ps.resourceId();

  const nodeIds = PrivacyNodeManager.getActiveNodes();
  const nodes: { id: string; node: PrivacyNode }[] = [];
  for (const id of nodeIds) {
    nodes.push({ id, node: await PrivacyNode.getInstance(id) });
  }

  // Check and fix each PL's replica
  for (const { id, node } of nodes) {
    const replicaAddr = await node.getEndpointV1().getAddressByResourceId(psResourceId);
    if (replicaAddr === ZERO_ADDRESS) {
      console.log(`${id}: replica not deployed, skipping`);
      continue;
    }

    const replica = ParticipantStorageReplicaV1__factory.connect(replicaAddr, node.adminWallet);
    const participants = await replica.getAllParticipants();
    const stale = participants.filter(p => p.status !== STATUS_ACTIVE);

    if (stale.length === 0) {
      console.log(`${id}: all participants active ✓`);
      continue;
    }

    for (const p of stale) {
      const label = nodes.find(n => BigInt(n.node.chainId) === p.chainId)?.id || String(p.chainId);
      console.log(`${id}: ${label} status=${p.status} → requesting sync from PNH...`);
    }

    const tx = await replica.requestAllParticipantsDataFromPrivateHub({ gasLimit: GAS_LIMIT });
    await tx.wait();
    console.log(`${id}: sync requested ✓`);
  }

  console.log('\nSync requests sent. Wait ~30s for relayer to process, then re-run this script to verify.');
}

main().catch(console.error);
