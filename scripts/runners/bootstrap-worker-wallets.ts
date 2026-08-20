/**
 * Bootstrap per-worker ADMIN wallets across every Privacy Node + the Private Hub.
 *
 * For each parallel worker (0..N-1), derives a deterministic admin wallet from
 * PRIVATE_KEY_SYSTEM and grants it the ADMIN role (roleId=0) on each chain's
 * RaylsAccessManager. Idempotent — skips chains where the wallet already holds ADMIN.
 *
 * Invoked by the base parallel runner via:
 *   PARALLEL_WORKERS=N npx hardhat run scripts/runners/bootstrap-worker-wallets.ts --network hardhat
 *
 * (--network hardhat is a no-op since we use our own JsonRpcProviders from env-config.)
 */

import { ethers } from 'ethers';
import {
  PRIVATE_KEY_SYSTEM,
  PROVIDER,
  DEPLOYMENT_PROXY_REGISTRY_ADDRESS,
  LOGGER,
} from '../../src/config/env-config';
import { PrivacyNodeManager } from '../../src/entities/PrivacyNodeManager';
import { workerAdminWallet } from '../../src/utils/wallet-factory';
import {
  DeploymentProxyRegistryV1__factory,
  RaylsAccessManagerV1__factory,
} from '../../typechain-types';

const ADMIN_ROLE_ID = 0n;

function parseWorkerCount(): number {
  const raw = process.env.PARALLEL_WORKERS;
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`PARALLEL_WORKERS must be a positive integer, got: ${raw ?? '<unset>'}`);
  }
  return n;
}

async function resolveAccessManagerAddress(
  provider: ethers.JsonRpcProvider,
  proxyRegistryAddress: string,
  signer: ethers.Wallet,
): Promise<string> {
  const registry = DeploymentProxyRegistryV1__factory.connect(proxyRegistryAddress, signer.connect(provider));
  return registry.getContract('RaylsAccessManager');
}

async function bootstrapNode(
  label: string,
  provider: ethers.JsonRpcProvider,
  proxyRegistryAddress: string,
  seedWallet: ethers.Wallet,
  workerAddresses: string[],
): Promise<{ granted: number; skipped: number }> {
  if (!proxyRegistryAddress) {
    LOGGER.log(`[bootstrap][${label}] skip — no DEPLOYMENT_PROXY_REGISTRY_ADDRESS`);
    return { granted: 0, skipped: workerAddresses.length };
  }

  const seedOnProvider = seedWallet.connect(provider);
  const managerAddress = await resolveAccessManagerAddress(provider, proxyRegistryAddress, seedWallet);
  const manager = RaylsAccessManagerV1__factory.connect(managerAddress, seedOnProvider);

  let granted = 0;
  let skipped = 0;

  // Sequential on a given chain — we're signing with the single seed wallet so
  // nonces must be consumed in order.
  for (const workerAddress of workerAddresses) {
    const [hasRole] = await manager.hasRole(ADMIN_ROLE_ID, workerAddress);
    if (hasRole) {
      LOGGER.log(`[bootstrap][${label}] ADMIN already granted to ${workerAddress}`);
      skipped += 1;
      continue;
    }
    const tx = await manager.grantRole(ADMIN_ROLE_ID, workerAddress, 0);
    await tx.wait();
    LOGGER.success(`[bootstrap][${label}] Granted ADMIN to ${workerAddress}`);
    granted += 1;
  }

  return { granted, skipped };
}

const FUND_TARGET_WEI = ethers.parseEther('5');
const FUND_MIN_WEI = ethers.parseEther('1');

async function fundNode(
  label: string,
  provider: ethers.JsonRpcProvider,
  seedWallet: ethers.Wallet,
  workerAddresses: string[],
): Promise<{ funded: number; skipped: number }> {
  const seedOnProvider = seedWallet.connect(provider);
  let funded = 0;
  let skipped = 0;

  for (const workerAddress of workerAddresses) {
    const balance = await provider.getBalance(workerAddress);
    if (balance >= FUND_MIN_WEI) {
      LOGGER.log(`[bootstrap][${label}] ${workerAddress} already funded (${ethers.formatEther(balance)} ETH)`);
      skipped += 1;
      continue;
    }
    const topUp = FUND_TARGET_WEI - balance;
    const tx = await seedOnProvider.sendTransaction({ to: workerAddress, value: topUp });
    await tx.wait();
    LOGGER.success(`[bootstrap][${label}] Funded ${workerAddress} with ${ethers.formatEther(topUp)} ETH`);
    funded += 1;
  }

  return { funded, skipped };
}

async function main() {
  const workerCount = parseWorkerCount();
  LOGGER.log(`Bootstrapping ADMIN for ${workerCount} workers`);

  const seedWallet = new ethers.Wallet(PRIVATE_KEY_SYSTEM);
  const activeNodes = PrivacyNodeManager.getActiveNodes();

  // Derive worker admin addresses once — they are chain-independent (same key -> same address).
  const workerAddresses = Array.from({ length: workerCount }, (_, workerId) =>
    workerAdminWallet(PROVIDER[activeNodes[0]], workerId).address,
  );
  LOGGER.log(`Worker admin addresses: ${workerAddresses.join(', ')}`);

  const targets = [...activeNodes, 'PNH'].map((label) => ({
    label,
    provider: PROVIDER[label],
    proxy: DEPLOYMENT_PROXY_REGISTRY_ADDRESS[label],
  }));

  const sumBy = <T,>(rs: T[], k: keyof T) => rs.reduce((a, r) => a + (r[k] as unknown as number), 0);

  // Parallel across chains (independent nonce lanes), sequential within each chain.
  const results = await Promise.all(
    targets.map((t) => bootstrapNode(t.label, t.provider, t.proxy, seedWallet, workerAddresses)),
  );
  LOGGER.success(
    `Bootstrap complete — ${sumBy(results, 'granted')} grants issued, ${sumBy(results, 'skipped')} already in place, across ${targets.length} chains × ${workerCount} workers`,
  );

  // Fund per-worker admin wallets with ETH. Tests like F12 use sendTransaction({value: ...})
  // which requires the signing wallet to have a balance. Idempotent via balance-threshold check.
  LOGGER.log(`Funding ${workerCount} worker admin wallets across ${targets.length} chains...`);
  const fundResults = await Promise.all(
    targets.map((t) => fundNode(t.label, t.provider, seedWallet, workerAddresses)),
  );
  LOGGER.success(
    `Funding complete — ${sumBy(fundResults, 'funded')} transfers issued, ${sumBy(fundResults, 'skipped')} already funded`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Bootstrap failed:', err);
    process.exit(1);
  });
