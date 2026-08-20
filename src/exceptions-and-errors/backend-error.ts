import { isNonceError } from './block-chain-exceptions';

export class BackendError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: any;
  constructor(message: string, status: number, code?: string, details?: any) {
    super(message);
    this.name = `BackendError ${status}`;
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * A retryable condition: a named predicate that, when matched, means the error
 * is transient and the operation is worth re-attempting.
 */
interface RetryableCondition {
  readonly name: string;
  readonly matches: (err: any) => boolean;
}

/**
 * Classifies whether a backend/on-chain error is transient (worth retrying) or
 * permanent (fail fast). The retryable set is declared exhaustively below;
 * anything not matched is permanent.
 *
 * Mirrors the rayls-privacy-backend error taxonomy:
 *  - http-5xx → `token_handler.go` / `operator_token_handler.go` return 500 for
 *    any non-revert failure ("Failed to lock tokens", "Failed to set token
 *    status"). The backend's own RPC layer (evm-client.go) already absorbs
 *    connection/timeout/unmarshal errors, so a surfaced 5xx is worth one retry.
 *  - nonce-collision → concurrent-worker races (replacement underpriced, nonce
 *    too low, already known) that leak through paths forwarding the underlying
 *    error (AddToken's `Err: %v`) and direct sendTx calls.
 *  - addr-pair-not-mapped → the operator-approval endpoint (SetAddressPairStatus)
 *    reverts with a 400 "Public address not mapped to user" when it runs before
 *    the onboarding's on-chain address-pair mapping has propagated. This specific
 *    400 is transient (the mapping settles shortly); it's the one revert that
 *    backend wraps as 400 there — everything else on that path is 500.
 *  - other http-4xx (validation: "amount/tokenId is required", "invalid token
 *    standard"; generic reverts: "execution reverted: …") is intentionally
 *    ABSENT — retrying never changes the outcome, so it must fail fast.
 *
 * Use as `retry({ retryIf: TransientBackendError.isTransient })`.
 */
export class TransientBackendError {
  static readonly RETRYABLE: readonly RetryableCondition[] = [
    { name: 'http-5xx',          matches: (e) => typeof e?.status === 'number' && e.status >= 500 },
    { name: 'nonce-collision',   matches: (e) => isNonceError(e) },
    { name: 'addr-pair-not-mapped', matches: (e) => typeof e?.message === 'string' && e.message.toLowerCase().includes('public address not mapped to user') },
  ];

  static isTransient(err: any): boolean {
    return TransientBackendError.RETRYABLE.some((c) => c.matches(err));
  }

  /** Name of the matched retryable condition (for logs), or null if permanent. */
  static reason(err: any): string | null {
    return TransientBackendError.RETRYABLE.find((c) => c.matches(err))?.name ?? null;
  }
}