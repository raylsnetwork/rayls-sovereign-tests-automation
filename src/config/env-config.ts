import dotenv from 'dotenv';
import {ethers} from "ethers";
import { Logger } from '../entities/Logger';
dotenv.config();

export const PARTICIPANTS = process.env.PARTICIPANTS
export const OPS_SERVICE_URL: { [NODE: string]: string } = {};
export const OPS_SERVICE_USER_AUTH_KEY: { [NODE: string]: string } = {};
export const OPS_SERVICE_OPERATOR_AUTH_KEY: { [NODE: string]: string } = {};
export const RAYLS_NODES = ['A', 'B', 'C', 'D', 'E', 'F'];
export const RPC_URL: { [NODE: string]: string } = {};
export const PROVIDER: { [NODE: string]: ethers.JsonRpcProvider } = {};
export const ENDPOINT_ADDRESS: { [NODE: string]: string } = {};
export const RAYLS_NODE_ENDPOINT_ADDRESS: { [NODE: string]: string } = {};
export const RAYLS_NODE_USER_GOVERNANCE: { [NODE: string]: string } = {};
export const RAYLS_NODE_TOKEN_GOVERNANCE: { [NODE: string]: string } = {};
export const CHAIN_ID: { [NODE: string]: string } = {};
export const DB_CONNECTION: { [NODE: string]: string } = {};
export const DEPLOYMENT_PROXY_REGISTRY_ADDRESS: { [NODE: string]: string } = {};

export const GOVERNANCE_API_URL = process.env.GOVERNANCE_API!;
export const PUBLIC_CHAIN_RPC_URL = process.env.PUBLIC_CHAIN_RPC_URL!;
export const PRIVATE_KEY_SYSTEM = process.env.PRIVATE_KEY_SYSTEM!;
export const PUBLIC_CHAIN_ID = process.env.PUBLIC_CHAIN_ID!;

export const USE_DB_CHECKS = process.env.USE_DB_CHECKS! === "true";
export const CLEAN_ENYGMA_DB_BEFORE_TESTS = process.env.CLEAN_ENYGMA_DB_BEFORE_TESTS! === "true";

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

export const ZERO_ADDRESS = ethers.ZeroAddress;
export const ZERO_HASH = ethers.ZeroHash;

export const NUMBER_OF_BLOCKS_TO_WAIT = 4;

/** Scale timeouts when running parallel workers to account for CC contention */
const PARALLEL_WORKERS = parseInt(process.env.PARALLEL_WORKERS || '1', 10);
export const TIMEOUT_MULTIPLIER = PARALLEL_WORKERS >= 5 ? 4 : PARALLEL_WORKERS > 1 ? 2 : 1;
export const DEFAULT_TIMEOUT = 4 * MINUTE * TIMEOUT_MULTIPLIER;

/**
 * Worker id for the current Hardhat process when spawned by the parallel runner.
 * - `null` means "non-parallel run" (sequential, smoke, serial phase) → use raw seed wallet.
 * - `>= 0` means "parallel worker N" → use deterministic per-worker wallets.
 * Bootstrap process uses MOCHA_WORKER_ID='bootstrap' and is treated as null here (seed).
 */
function parseWorkerId(): number | null {
  const raw = process.env.MOCHA_WORKER_ID;
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
export const WORKER_ID: number | null = parseWorkerId();

/**
 * Timeout for `before` hooks that run multiple sequential CC operations.
 * Multiply DEFAULT_TIMEOUT by the expected number of "cycles" (deploy+register+transfer).
 * Usage: `this.timeout(BEFORE_HOOK_TIMEOUT(3))` for a hook that sets up 3 tokens.
 */
export function BEFORE_HOOK_TIMEOUT(cycles: number = 1): number {
  return DEFAULT_TIMEOUT * Math.max(cycles, 1);
}

export const GAS_LIMIT = 10000000;
export const LOGGER = new Logger();

// PNH-specific
DEPLOYMENT_PROXY_REGISTRY_ADDRESS['PNH'] = process.env.PNH_DEPLOYMENT_PROXY_REGISTRY!;
RPC_URL['PNH'] = process.env.PNH_RPC_URL!;
PROVIDER['PNH'] = new ethers.JsonRpcProvider(RPC_URL['PNH']);
ENDPOINT_ADDRESS['PNH'] = process.env.PNH_ENDPOINT_ADDRESS || ZERO_ADDRESS;
RAYLS_NODE_ENDPOINT_ADDRESS['PNH'] = process.env.PNH_RAYLS_NODE_ENDPOINT_ADDRESS || ZERO_ADDRESS;
RAYLS_NODE_USER_GOVERNANCE['PNH'] = process.env.PNH_RAYLS_NODE_USER_GOVERNANCE || ZERO_ADDRESS;
RAYLS_NODE_TOKEN_GOVERNANCE['PNH'] = process.env.PNH_RAYLS_NODE_TOKEN_GOVERNANCE_ADDRESS || ZERO_ADDRESS;
CHAIN_ID['PNH'] = process.env.PNH_CHAIN_ID!;
DB_CONNECTION['PNH'] = process.env.PNH_DB_CS!;
PROVIDER['PNH'].pollingInterval = 200;

// Per-node (A-F)
RAYLS_NODES.forEach((NODE) => {
  DEPLOYMENT_PROXY_REGISTRY_ADDRESS[NODE] = process.env[`PRIVACY_NODE_${NODE}_DEPLOYMENT_PROXY_REGISTRY`]!;
  RPC_URL[NODE] = process.env[`PRIVACY_NODE_${NODE}_RPC_URL`]!;
  PROVIDER[NODE] = new ethers.JsonRpcProvider(RPC_URL[NODE]);
  ENDPOINT_ADDRESS[NODE] = process.env[`PRIVACY_NODE_${NODE}_ENDPOINT_ADDRESS`]!;
  RAYLS_NODE_ENDPOINT_ADDRESS[NODE] = process.env[`PRIVACY_NODE_${NODE}_RAYLS_NODE_ENDPOINT_ADDRESS`] || ZERO_ADDRESS;
  RAYLS_NODE_USER_GOVERNANCE[NODE] = process.env[`PRIVACY_NODE_${NODE}_RAYLS_NODE_USER_GOVERNANCE`] || ZERO_ADDRESS;
  RAYLS_NODE_TOKEN_GOVERNANCE[NODE] = process.env[`PRIVACY_NODE_${NODE}_RAYLS_NODE_TOKEN_GOVERNANCE_ADDRESS`] || ZERO_ADDRESS;
  CHAIN_ID[NODE] = process.env[`PRIVACY_NODE_${NODE}_CHAIN_ID`]!;
  DB_CONNECTION[NODE] = process.env[`PRIVACY_NODE_${NODE}_DB_CS`]!;
  OPS_SERVICE_URL[NODE] = process.env[`OPS_SERVICE_${NODE}_URL`]!;
  OPS_SERVICE_USER_AUTH_KEY[NODE] = process.env[`OPS_SERVICE_${NODE}_USER_AUTH_KEY`]!;
  OPS_SERVICE_OPERATOR_AUTH_KEY[NODE] = process.env[`OPS_SERVICE_${NODE}_OPERATOR_AUTH_KEY`]!;
  PROVIDER[NODE].pollingInterval = 200;
});

// Freeze config dictionaries to prevent accidental mutation in parallel tests
Object.freeze(RPC_URL);
Object.freeze(PROVIDER);
Object.freeze(ENDPOINT_ADDRESS);
Object.freeze(RAYLS_NODE_ENDPOINT_ADDRESS);
Object.freeze(RAYLS_NODE_USER_GOVERNANCE);
Object.freeze(RAYLS_NODE_TOKEN_GOVERNANCE);
Object.freeze(CHAIN_ID);
Object.freeze(DEPLOYMENT_PROXY_REGISTRY_ADDRESS);
Object.freeze(OPS_SERVICE_URL);
Object.freeze(OPS_SERVICE_USER_AUTH_KEY);
Object.freeze(OPS_SERVICE_OPERATOR_AUTH_KEY);

// ─────────────────────────────────────────────────────────────────────────────
// Backend test target selection
// ─────────────────────────────────────────────────────────────────────────────
// Single-node backend tests pin to ONE ops-service per process. The target is
// picked deterministically as `WORKER_ID % availableBackends.length` so parallel
// runs spread load across all configured backends. Single-worker / non-parallel
// runs use the first available backend.
//
// Cross-node backend tests (e.g. Token_Lock_CrossNode_Negative) explicitly name
// nodes ('A' and 'B') as part of a two-node scenario — they look up
// `OPS_SERVICE_URL['A'|'B']` directly and add an inline prerequisite check at
// the top of the describe block (see Token_Lock_CrossNode*.ts).
const _availableBackends = RAYLS_NODES.filter((n) => !!OPS_SERVICE_URL[n]);
const _parallelWorkers = parseInt(process.env.PARALLEL_WORKERS ?? '1', 10);

export const BACKEND_TARGET_NODE: string = (() => {
  if (_availableBackends.length === 0) return 'A';
  return WORKER_ID !== null
    ? _availableBackends[WORKER_ID % _availableBackends.length]
    : _availableBackends[0];
})();

/** Ops-service URL for the configured backend target (see BACKEND_TARGET_NODE). */
export const BACKEND_OPS_URL: string = OPS_SERVICE_URL[BACKEND_TARGET_NODE];

/** Ops-service auth keys for the configured backend target (see BACKEND_TARGET_NODE). */
export const BACKEND_USER_AUTH_KEY: string = OPS_SERVICE_USER_AUTH_KEY[BACKEND_TARGET_NODE];
export const BACKEND_OPERATOR_AUTH_KEY: string = OPS_SERVICE_OPERATOR_AUTH_KEY[BACKEND_TARGET_NODE];

// Fire-once warning when worker count exceeds configured backends — modulo wrap
// means some backends carry ceil(W/B) workers' worth of load.
if (WORKER_ID === 0 && _parallelWorkers > _availableBackends.length && _availableBackends.length > 0) {
  LOGGER.error(
    `[BACKEND] ${_parallelWorkers} workers vs ${_availableBackends.length} configured backends — ` +
    `load uneven; up to ${Math.ceil(_parallelWorkers / _availableBackends.length)} workers per backend.`
  );
}
