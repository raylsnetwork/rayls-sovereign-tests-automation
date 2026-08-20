import { ethers } from 'ethers';
import { expect } from 'chai';
import {
  TemplateRegistryV1,
  TemplateRegistryV1__factory,
  TemplateRegistryReplicaV1,
  TemplateRegistryReplicaV1__factory,
} from '../../typechain-types';
import { PrivateHub } from '../../src/entities/PrivateHub';
import { BEFORE_HOOK_TIMEOUT, DEFAULT_TIMEOUT, GAS_LIMIT } from '../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../setup';
import { eventually, submitTx } from '../../src/utils/common';

describe('E2E Tests: Template Registry Broadcast (PNH -> all PN replicas)', function () {
  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let registry: TemplateRegistryV1;
  let replicaOnA: TemplateRegistryReplicaV1;
  let replicaOnB: TemplateRegistryReplicaV1;

  before(async function () {
    this.timeout(BEFORE_HOOK_TIMEOUT(1));

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    const registryAddress = privateHub.deployNamesAndAddresses['TemplateRegistry'];
    if (!registryAddress) {
      throw new Error("DeploymentProxyRegistry missing 'TemplateRegistry' on PNH");
    }
    registry = TemplateRegistryV1__factory.connect(registryAddress, privateHub.operatorWallet);

    const replicaAddrA = await privacyNodes.A.resolveFromRegistry('TemplateRegistryReplica');
    const replicaAddrB = await privacyNodes.B.resolveFromRegistry('TemplateRegistryReplica');
    replicaOnA = TemplateRegistryReplicaV1__factory.connect(replicaAddrA, privacyNodes.A.userWallet);
    replicaOnB = TemplateRegistryReplicaV1__factory.connect(replicaAddrB, privacyNodes.B.userWallet);
  });

  it('approves a custom template on PNH and replicas mirror on both PNs', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    // Synthetic 32-byte hash — NOT a real extcodehash of deployed bytecode. This suite exercises
    // the registry's propose → approve → broadcast-to-replicas path, which treats the hash as an
    // opaque key and does not verify that code exists at it. (If TemplateRegistry ever adds an
    // on-propose existence check, this must switch to a real deployed contract's codehash.) The
    // timestamp only keeps the key unique across runs.
    const bytecodeHash = ethers.keccak256(
      ethers.toUtf8Bytes(`integration-test-template-${Date.now()}`)
    );
    const signature = 'sampleSelector(uint256)';

    await submitTx(
      () => registry.propose(bytecodeHash, signature, { gasLimit: GAS_LIMIT }),
      'Proposing custom template on PNH'
    );

    const key = await registry.getKey(
      bytecodeHash,
      ethers.dataSlice(ethers.id(signature), 0, 4)
    );

    await submitTx(
      () => registry.approve(key, { gasLimit: GAS_LIMIT }),
      'Approving template on PNH'
    );

    const pnhTemplate = await registry.getTemplate(key);
    const approvedAt = pnhTemplate.approvedAtBlock;
    expect(pnhTemplate.approved).to.equal(true);

    await eventually({
      check: async () => {
        const [a, b] = await Promise.all([replicaOnA.getTemplate(key), replicaOnB.getTemplate(key)]);
        return a.approved && b.approved && a.approvedAtBlock === approvedAt && b.approvedAtBlock === approvedAt;
      },
      message: 'Waiting for template approval → PN A + PN B replicas mirror',
      tolerateErrors: true,
    });

    const [lastA, lastB] = await Promise.all([
      replicaOnA.getLastUpdatedAt(key),
      replicaOnB.getLastUpdatedAt(key),
    ]);
    expect(lastA).to.equal(approvedAt);
    expect(lastB).to.equal(approvedAt);
  });

  it('seeds a standard template on PNH and replicas mirror on both PNs', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const bytecodeHash = ethers.keccak256(
      ethers.toUtf8Bytes(`integration-seed-template-${Date.now()}`)
    );
    const signature = 'seedSampleSelector(address,uint256)';

    await submitTx(
      () => registry.seedStandardTemplate(bytecodeHash, signature, { gasLimit: GAS_LIMIT }),
      'Seeding standard template on PNH'
    );

    const key = await registry.getKey(
      bytecodeHash,
      ethers.dataSlice(ethers.id(signature), 0, 4)
    );
    const pnhTemplate = await registry.getTemplate(key);
    const approvedAt = pnhTemplate.approvedAtBlock;

    await eventually({
      check: async () => {
        const [a, b] = await Promise.all([replicaOnA.getTemplate(key), replicaOnB.getTemplate(key)]);
        return a.approved && b.approved && a.approvedAtBlock === approvedAt && b.approvedAtBlock === approvedAt;
      },
      message: 'Waiting for seeded standard template → PN A + PN B replicas mirror',
      tolerateErrors: true,
    });
  });

  it('revokes a template on PNH and replicas mirror revocation on both PNs', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const bytecodeHash = ethers.keccak256(
      ethers.toUtf8Bytes(`integration-revoke-template-${Date.now()}`)
    );
    const signature = 'revokeSampleSelector()';

    await submitTx(
      () => registry.seedStandardTemplate(bytecodeHash, signature, { gasLimit: GAS_LIMIT }),
      'Seeding template to be revoked'
    );

    const key = await registry.getKey(
      bytecodeHash,
      ethers.dataSlice(ethers.id(signature), 0, 4)
    );

    const seededAt = (await registry.getTemplate(key)).approvedAtBlock;
    await eventually({
      check: async () => {
        const [a, b] = await Promise.all([replicaOnA.getTemplate(key), replicaOnB.getTemplate(key)]);
        return a.approved && b.approved && a.approvedAtBlock === seededAt && b.approvedAtBlock === seededAt;
      },
      message: 'Waiting for seed precondition → PN A + PN B replicas mirror',
      tolerateErrors: true,
    });

    await submitTx(
      () => registry.revoke(key, { gasLimit: GAS_LIMIT }),
      'Revoking template on PNH'
    );

    const revokedAt = (await registry.getTemplate(key)).approvedAtBlock;
    expect(revokedAt > seededAt, 'revoke block must be after seed block').to.equal(true);

    await eventually({
      check: async () => {
        const [a, b] = await Promise.all([replicaOnA.getTemplate(key), replicaOnB.getTemplate(key)]);
        return !a.approved && !b.approved && a.approvedAtBlock === revokedAt && b.approvedAtBlock === revokedAt;
      },
      message: 'Waiting for template revocation → PN A + PN B replicas mirror',
      tolerateErrors: true,
    });

    const [lastA, lastB] = await Promise.all([
      replicaOnA.getLastUpdatedAt(key),
      replicaOnB.getLastUpdatedAt(key),
    ]);
    expect(lastA).to.equal(revokedAt);
    expect(lastB).to.equal(revokedAt);
  });

  // Same-key staleness drop is exercised exhaustively by the Phase 1 unit tests on
  // TemplateRegistryReplicaV1.t.sol (`approvedAt <= _lastUpdatedAt[key]` guard).
  // Reproducing it end-to-end requires injecting an out-of-order Endpoint message,
  // which the production relayer does not expose a hook for — deferred to a
  // follow-up if production logs ever show same-key reorders.
});
