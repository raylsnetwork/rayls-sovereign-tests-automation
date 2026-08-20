export class ReceiptTimeoutError extends Error {
  constructor(public readonly txHash: string, public readonly timeoutMs: number) {
    super(`Receipt timeout after ${timeoutMs}ms for tx ${txHash}`);
    this.name = 'ReceiptTimeoutError';
  }
}

export class NonceError extends Error {
  static readonly patterns = ['nonce'];

  constructor(message: string, public readonly cause?: Error) {
    super(message);
    this.name = 'NonceError';
  }

  static matches(err: any): boolean {
    const msg = (err?.message || err?.reason || '').toLowerCase();
    return this.patterns.some((p) => msg.includes(p));
  }
}

export class ReplacementTransactionError extends NonceError {
  static override readonly patterns = [
    'replacement transaction',
    'replacement fee too low',
    'transaction was replaced',  // ethers v6 TRANSACTION_REPLACED
    'repriced',                  // ethers v6 repriced variant
  ];

  constructor(cause?: Error) {
    super('Replacement transaction underpriced', cause);
    this.name = 'ReplacementTransactionError';
  }
}

export class KnownTransactionError extends NonceError {
  static override readonly patterns = ['known transaction', 'already known'];

  constructor(cause?: Error) {
    super('Transaction already known by the node', cause);
    this.name = 'KnownTransactionError';
  }
}

const NONCE_ERROR_CLASSES = [ReplacementTransactionError, KnownTransactionError, NonceError];

export function isNonceError(err: any): boolean {
  if (err instanceof NonceError) return true;
  // ethers v6 throws with code 'TRANSACTION_REPLACED' when tx.wait() detects replacement
  if (err?.code === 'TRANSACTION_REPLACED') return true;
  return NONCE_ERROR_CLASSES.some((cls) => cls.matches(err));
}

// Transient RPC failures: the node returned null / 5xx / pruned state instead of a
// real response. Retrying usually clears it.
export class TransientRpcError extends Error {
  static readonly patterns = [
    'invalid bytelike', // ethers hexlify(null) when an RPC result is null
    'value=null', // alternative ethers message shape for the same root cause
    'missing trie node', // geth: state pruned / not yet available
  ];

  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'TransientRpcError';
  }

  static matches(err: any): boolean {
    const msg = (err?.message || err?.reason || '').toLowerCase();
    return this.patterns.some(p => msg.includes(p));
  }
}

export function isTransientRpcError(err: any): boolean {
  if (err instanceof TransientRpcError) return true;
  if (err?.code === 'BAD_DATA') return true;
  return TransientRpcError.matches(err);
}
