/**
 * Shared DVP proof / Merkle-tree helpers for the #303 CoinVault custody-bypass exploit tests
 * (`Erc721CoinVaultFullTheft.ts`, `Erc1155CoinVaultFullDrain.ts`). Extracted so the depth-8 tree
 * reconstruction and the fixed proving-system constants live in one place (and so future vault
 * exploit tests can reuse them).
 */
import { ethers } from 'ethers';
import { retry, eventually } from '../../../src/utils/common';
import { isTransientRpcError } from '../../../src/exceptions-and-errors/block-chain-exceptions';
import { DvpTeleport } from '../../../typechain-types';

// Fixed proving-system constants — identical in every deployment and every start_dev.sh relaunch
// (NOT deployment artifacts): they are curve/circuit parameters, not addresses.
export const P_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;  // BN254 scalar field (Merkle.sol:15 SNARK_SCALAR_FIELD; gnark GroupMath.go:38)
export const SUBGROUP = 2736030358979909402780800718157159386076813972158567259200215660948447373041n; // BabyJubjub prime subgroup: publicKey = Poseidon(sk,sk) mod SUBGROUP (gnark GroupMath.go:39)
export const TREE_DEPTH = 8; // depth the DVP circuits are compiled for (gnark circuit.go merkleTreeDepth; env DVP_MERKLE_TREE_DEPTH=8)
export const PROOFS_API = process.env.PROOFS_API_URL ?? 'http://127.0.0.1:3003'; // dev-local default; set PROOFS_API_URL for other envs

export const randField = (): bigint => ethers.toBigInt(ethers.randomBytes(31)) % P_FIELD;

// Retry only transient RPC errors on the busy shared PNH; a real revert is not transient and propagates.
export const rpcFlaky = (e: any): boolean =>
  isTransientRpcError(e) ||
  /coalesce|timeout|SERVER_ERROR|ECONNRESET|socket|network|ETIMEDOUT|503|429|failed to detect/i.test(e?.shortMessage ?? e?.message ?? String(e));
export const withRetry = <T>(fn: () => Promise<T>): Promise<T> => retry(fn, { attempts: 6, delayMs: 500, retryIf: rpcFlaky });

/**
 * Rebuild the depth-8 sparse DVP tree from `Commitments` events (ZERO = keccak256("Dvp") % p,
 * internal nodes = Poseidon) and return the Merkle path + root + treeNumber for `targetLeaf`.
 *
 * The `Commitments` event is emitted inside the vault `deposit` tx, so after a mined deposit it is
 * on-chain — but a shared PNH read replica can briefly lag. Rather than query once and risk a
 * spurious "target leaf not found", `eventually` polls (tolerating transient RPC errors) until the
 * target leaf actually appears; replica lag becomes a bounded wait, not a false failure. This is
 * only reached on the vulnerable path (a gated deposit reverts before we get here), so it never
 * hangs in the FIXED case.
 */
export async function reconstructPath(
  dvpTeleport: DvpTeleport, assetAddr: string, targetLeaf: bigint,
  H: (a: bigint, b: bigint) => Promise<bigint>, fromBlock: number,
): Promise<{ indices: number; elements: bigint[]; root: bigint; treeNumber: bigint }> {
  const logs = await eventually({
    message: 'reconstructPath: target commitment present in DvpTeleport.Commitments',
    tolerateErrors: true,
    interval: 2000,
    attempts: 30,
    check: async () => {
      const ls = (await dvpTeleport.queryFilter(dvpTeleport.filters.Commitments(assetAddr), fromBlock, 'latest'))
        .sort((a, b) => (a.blockNumber - b.blockNumber) || (a.index - b.index));
      const present = ls.some((l) => (l.args.commitments as bigint[]).some((c) => ethers.toBigInt(c) === targetLeaf));
      return present ? ls : undefined;
    },
  });

  let treeNumber = 0n;
  for (const l of logs) for (const c of l.args.commitments as bigint[]) if (ethers.toBigInt(c) === targetLeaf) treeNumber = ethers.toBigInt(l.args.treeNumber);
  const leaves: bigint[] = [];
  for (const l of logs) if (ethers.toBigInt(l.args.treeNumber) === treeNumber) for (const c of l.args.commitments as bigint[]) leaves.push(ethers.toBigInt(c));

  const leafIndex = leaves.findIndex((x) => x === targetLeaf);
  if (leafIndex < 0) throw new Error('target leaf not found in on-chain Commitments');

  const zeros: bigint[] = [ethers.toBigInt(ethers.keccak256(ethers.toUtf8Bytes('Dvp'))) % P_FIELD];
  for (let i = 1; i <= TREE_DEPTH; i++) zeros.push(await H(zeros[i - 1], zeros[i - 1]));
  const elements: bigint[] = [];
  let level = leaves.slice(); let idx = leafIndex;
  for (let lvl = 0; lvl < TREE_DEPTH; lvl++) {
    if (level.length % 2 === 1) level.push(zeros[lvl]);
    elements.push(level[idx ^ 1]);
    const next: bigint[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(await H(level[i], level[i + 1]));
    level = next; idx >>= 1;
  }
  return { indices: leafIndex, elements, root: level[0], treeNumber };
}
