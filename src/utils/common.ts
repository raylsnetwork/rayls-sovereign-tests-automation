// Simple sleep helper
import { ContractTransactionReceipt, ContractTransactionResponse, ethers, Interface, JsonRpcProvider, TransactionReceipt } from 'ethers';
import { DEFAULT_TIMEOUT, LOGGER, SECOND } from '../config/env-config';
import { ReceiptTimeoutError, isNonceError, isTransientRpcError } from '../exceptions-and-errors/block-chain-exceptions';
import { expect } from 'chai';

export function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
/**
 * Generic retry helper with fixed delay between attempts.
 *
 * @param fn Async function to execute
 * @param opts Optional settings: attempts, delayMs, onRetry callback
 */
export async function retry<T>(
  fn: () => Promise<T>,
  opts?: {
    attempts?: number;
    delayMs?: number;
    onRetry?: (err: any, attempt: number) => void;
    retryIf?: (err: any) => boolean;
  }
) {
  const attempts = opts?.attempts ?? 3;
  const delayMs = opts?.delayMs ?? 3000;
  let lastErr: any;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (opts?.retryIf && !opts.retryIf(err)) throw err;
      if (i >= attempts) break;
      opts?.onRetry?.(err, i);
      await delay(delayMs);
    }
  }
  throw lastErr;
}

export const RECEIPT_TIMEOUT_MS = 15_000;

/**
 * Races response.wait() against a timeout. Throws 'Receipt timeout' if the
 * receipt isn't delivered within `timeoutMs` — signals a displaced tx.
 */
export async function waitForReceipt(
  response: { wait: () => Promise<any>; hash: string },
  timeoutMs: number = RECEIPT_TIMEOUT_MS
) {
  const receipt = await Promise.race([
    response.wait(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new ReceiptTimeoutError(response.hash, timeoutMs)), timeoutMs)
    ),
  ]);
  return receipt;
}

/**
 * Execute a transaction with nonce-retry.
 * Accepts a factory so each retry gets a fresh nonce from the provider.
 */
export async function sendTx(
  txFactory: () => Promise<ethers.ContractTransactionResponse>,
  context?: string,
) {
  return await retry(
    async () => {
      const response = await txFactory();
      return await waitForReceipt(response);
    },
    {
      attempts: 5,
      delayMs: 500,
      retryIf: (err) => isNonceError(err) || isTransientRpcError(err),
      onRetry: (err, i) => LOGGER.log(
        `[TX RETRY] ${isNonceError(err) ? 'nonce' : 'transient'} sendTx attempt ${i}/5${context ? ` (${context})` : ''}`
      ),
    }
  );
}

export function createRandomWallet(provider : JsonRpcProvider) {
    return ethers.Wallet.createRandom(provider);
}

export interface PollOptions<T> {
  /** Polled each attempt; the first truthy value ends the poll and is returned. */
  check: () => Promise<T | undefined | null | false>;
  /** Delay between attempts in ms. Default: `SECOND`. */
  interval?: number;
  /** Max attempts before giving up. Default: `DEFAULT_TIMEOUT / SECOND`. */
  attempts?: number;
  /**
   * When `true`, errors thrown by `check` are treated as "not yet ready" — polling
   * continues without surfacing the error. Useful for eventual-consistency probes
   * where transient throws (contract not yet deployed, RPC briefly unavailable,
   * indexer lag) mean "not ready" rather than a real failure. The last error is
   * included in the exhaustion diagnostic. Default `false`: throws propagate.
   */
  tolerateErrors?: boolean;
}

// Private polling primitive — pure synchronization loop with no side effects.
// Returns the first truthy result, or `undefined` on exhaustion. Not exported:
// callers should reach for `eventually` (positive wait) or `never` (temporal
// invariant) instead. If a future raw use case appears, promote to exported.
async function poll<T>(opts: PollOptions<T>): Promise<T | undefined> {
  const interval = opts.interval ?? SECOND;
  const attempts = opts.attempts ?? DEFAULT_TIMEOUT / SECOND;
  for (let i = 1; i <= attempts; i++) {
    try {
      const result = await opts.check();
      if (result) return result;
    } catch (err) {
      if (!opts.tolerateErrors) throw err;
      // else: treat as "not ready yet" — continue polling
    }
    if (i < attempts) await delay(interval);
  }
  return undefined;
}

/**
 * Eventual wait — polls `check` until it returns truthy, resolves with that value.
 * Drives a `LOGGER.load`/`loadSuccess`/`loadError` lifecycle labelled by `message`.
 * On exhaustion throws an Error including the message, attempt budget, interval,
 * and the last observed (falsy) value — invaluable for flaky-test triage.
 *
 * Use when "wait until X becomes true / appears / reaches expected state."
 */
export async function eventually<T>(opts: PollOptions<T> & { message: string }): Promise<T> {
  const loadId = LOGGER.load(opts.message);
  let lastValue: unknown;
  let lastError: unknown;
  const result = await poll({
    ...opts,
    check: async () => {
      try {
        const v = await opts.check();
        if (!v) lastValue = v;
        return v;
      } catch (err) {
        lastError = err;
        throw err; // poll decides whether to swallow (tolerateErrors) or propagate
      }
    },
  });
  if (result !== undefined) {
    LOGGER.loadSuccess(loadId);
    return result;
  }
  LOGGER.loadError(loadId);
  const interval = opts.interval ?? SECOND;
  const attempts = opts.attempts ?? DEFAULT_TIMEOUT / SECOND;
  const observed = lastError !== undefined
    ? `last error: ${(lastError as { message?: string })?.message ?? String(lastError)}`
    : `last observed: ${JSON.stringify(lastValue)}`;
  throw new Error(
    `${opts.message} (after ${attempts} attempts, ${interval} ms interval, ${observed})`,
  );
}

/**
 * Temporal invariant — polls `check` and asserts it NEVER returns truthy within the
 * window. Timeout (no match) is the success path; a match is failure.
 * Drives a `LOGGER.load`/`loadSuccess`/`loadError` lifecycle labelled by `message`.
 * On match (failure) throws an Error including which attempt matched and the value.
 *
 * Use when "ensure X stays false / doesn't propagate / fails consistently" in a window.
 */
export async function never<T>(opts: PollOptions<T> & { message: string }): Promise<void> {
  const loadId = LOGGER.load(opts.message);
  let attemptNumber = 0;
  const result = await poll({
    ...opts,
    check: async () => {
      attemptNumber++;
      return await opts.check();
    },
  });
  if (result === undefined) {
    LOGGER.loadSuccess(loadId);
    return;
  }
  LOGGER.loadError(loadId);
  throw new Error(
    `${opts.message} — condition matched at attempt ${attemptNumber} (value: ${JSON.stringify(result)})`,
  );
}

/**
 * Send a transaction with nonce-retry and displaced-tx recovery.
 * Returns the mined receipt. Throws on failure.
 */
export async function submitTx(
  txFactory: () => Promise<ContractTransactionResponse>,
  message: string,
): Promise<ContractTransactionReceipt> {
  const loadId = LOGGER.load(message);
  const maxDisplacedRetries = 5;
  let receipt: any;

  for (let attempt = 1; attempt <= maxDisplacedRetries; attempt++) {
    const response = await retry(
      () => txFactory(),
      {
        attempts: 5,
        delayMs: 500,
        onRetry: (err, i) => LOGGER.log(
          `[TX RETRY] ${isNonceError(err) ? 'nonce' : 'transient'} attempt ${i}/5 for: ${message}`
        ),
        retryIf: (err) => isNonceError(err) || isTransientRpcError(err),
      }
    );

    try {
      receipt = await waitForReceipt(response, RECEIPT_TIMEOUT_MS);
      break;
    } catch (err: any) {
      const canRetry = attempt < maxDisplacedRetries;
      if (err instanceof ReceiptTimeoutError && canRetry) {
        LOGGER.log(`[DISPLACED] Receipt timeout for "${message}" (hash=${response.hash}), resubmitting (${attempt}/${maxDisplacedRetries})...`);
        continue;
      }
      if (err?.code === 'TRANSACTION_REPLACED' && canRetry) {
        LOGGER.log(`[REPLACED] Tx replaced for "${message}" (hash=${response.hash}), resubmitting (${attempt}/${maxDisplacedRetries})...`);
        continue;
      }
      throw err;
    }
  }

  if (!receipt) throw new Error('No receipt after displaced retries: ' + message);

  expect(receipt.status).to.be.equal(1);
  LOGGER.loadSuccess(loadId);
  return receipt;
}

export function getObjectIndexByKey<T>(arr: T[], key: keyof T, value: any): number {
    return arr.findIndex(obj => obj[key] === value);
}

export async function getMessageId(
  txOrReceipt: TransactionReceipt,
  endpointAddress: string,
  endpointIface: Interface
): Promise<string> {
  if (!txOrReceipt || !Array.isArray(txOrReceipt.logs)) throw new Error('receipt has no logs');
  const normalizedEndpoint = endpointAddress.toLowerCase();

  for (const log of txOrReceipt.logs) {
    if ((log.address || '').toLowerCase() !== normalizedEndpoint) continue;
    const parsed = endpointIface.parseLog(log);
    if (parsed && parsed.name === 'MessageDispatched') {
      let mid = parsed.args?.messageId;
      if (!mid) break;
      mid = String(mid);
      if (!mid.startsWith('0x')) mid = '0x' + mid;
      return mid;
    }
  }
  throw new Error('MessageDispatched.messageId not found in receipt logs');
}