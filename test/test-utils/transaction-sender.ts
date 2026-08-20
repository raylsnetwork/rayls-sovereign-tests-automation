import axios from 'axios';
import { LOGGER } from '../../src/config/env-config';

export interface BatchRpcResult {
  jsonrpc: string;
  id: number;
  result?: string;
  error?: { code: number; message: string };
}

export class TransactionSender {
  /**
   * Sends a batch of already signed raw transactions to an RPC endpoint using JSON-RPC batch.
   * Returns the array of JSON-RPC responses for inspection.
   */
  static async sendBatchRawTransactions(signedRawTxs: string[], rpcUrl: string, context?: string): Promise<BatchRpcResult[]> {
    if (!signedRawTxs?.length) {
      LOGGER.error('TransactionSender: no transactions to send');
      return [];
    }

    const batchPayload = signedRawTxs.map((signedTx, index) => ({
      jsonrpc: '2.0',
      method: 'eth_sendRawTransaction',
      params: [signedTx],
      id: index + 1,
    }));

    const label = context ? ` (${context})` : '';
    LOGGER.info(`TransactionSender: sending ${signedRawTxs.length} txs${label}...`);

    const response = await axios.post(rpcUrl, batchPayload, {
      headers: { 'Content-Type': 'application/json' },
    });

    if (response.status !== 200) {
      throw new Error(`TransactionSender: RPC returned ${response.status} ${response.statusText}`);
    }

    LOGGER.info(`TransactionSender: batch sent successfully${label}`);
    return response.data as BatchRpcResult[];
  }

  /**
   * Checks if any response in a batch contains a nonce-related error.
   */
  static hasNonceError(results: BatchRpcResult[]): boolean {
    return results.some((r) => {
      const msg = (r.error?.message || '').toLowerCase();
      return msg.includes('nonce') || msg.includes('replacement transaction');
    });
  }
}
