import { ethers } from 'ethers';
import { PRIVATE_KEY_SYSTEM, WORKER_ID } from '../config/env-config';

const DERIVATION_BASE = "m/44'/60'/0'/0";

const masterNode = ethers.HDNodeWallet.fromSeed(
  ethers.getBytes(ethers.keccak256(PRIVATE_KEY_SYSTEM))
);

function randomChildIndex(): number {
  return Math.floor(Math.random() * 2_147_483_647);
}

export function createUserOperator(provider: ethers.JsonRpcProvider): ethers.HDNodeWallet {
  const index = randomChildIndex();
  return masterNode.derivePath(`${DERIVATION_BASE}/${index}`).connect(provider);
}

// ── Per-worker deterministic wallets ─────────────────────────
// Worker IDs live in a dedicated slot range so they never collide with random
// child indices used by createUserOperator (which tops out at 2^31-1).
const WORKER_SLOT_BASE = 1_000_000_000;

const ROLE_SLOT = {
  admin: 0,
  operator: 1,
  bankEmployee: 2,
  user: 3,
  compliance: 4,
} as const;

type RoleKey = keyof typeof ROLE_SLOT;

function deriveWorkerWallet(roleKey: RoleKey, workerId: number, provider: ethers.JsonRpcProvider): ethers.HDNodeWallet {
  const workerSlot = WORKER_SLOT_BASE + workerId;
  const roleSlot = ROLE_SLOT[roleKey];
  return masterNode.derivePath(`${DERIVATION_BASE}/${workerSlot}/${roleSlot}`).connect(provider);
}

/**
 * Bootstrap-only: derive a per-worker admin wallet by explicit workerId.
 * Used by `bootstrap-worker-wallets.ts` to pre-grant ADMIN to every worker's wallet
 * across every chain before the parallel phase starts.
 */
export function workerAdminWallet(provider: ethers.JsonRpcProvider, workerId: number): ethers.HDNodeWallet {
  return deriveWorkerWallet('admin', workerId, provider);
}

// ── Mode-aware role wallets ──────────────────────────────────
// Each helper returns the right wallet for the current process:
//  - WORKER_ID === null → seed-scoped (raw system key for admin, random HD for the rest)
//  - WORKER_ID >= 0     → deterministic per-worker wallet for that role
// This keeps PrivacyNode/PrivateHub constructors free of branching.

export function adminWallet(provider: ethers.JsonRpcProvider): ethers.HDNodeWallet | ethers.Wallet {
  return WORKER_ID === null
    ? new ethers.Wallet(PRIVATE_KEY_SYSTEM).connect(provider)
    : deriveWorkerWallet('admin', WORKER_ID, provider);
}

export function userWallet(provider: ethers.JsonRpcProvider): ethers.HDNodeWallet {
  return WORKER_ID === null
    ? createUserOperator(provider)
    : deriveWorkerWallet('user', WORKER_ID, provider);
}

export function operatorWallet(provider: ethers.JsonRpcProvider): ethers.HDNodeWallet {
  return WORKER_ID === null
    ? createUserOperator(provider)
    : deriveWorkerWallet('operator', WORKER_ID, provider);
}

export function bankEmployeeWallet(provider: ethers.JsonRpcProvider): ethers.HDNodeWallet {
  return WORKER_ID === null
    ? createUserOperator(provider)
    : deriveWorkerWallet('bankEmployee', WORKER_ID, provider);
}

export function complianceWallet(provider: ethers.JsonRpcProvider): ethers.HDNodeWallet {
  return WORKER_ID === null
    ? createUserOperator(provider)
    : deriveWorkerWallet('compliance', WORKER_ID, provider);
}
