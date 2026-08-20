import {
  BatchTransactionsResponse,
  DvpSwapTransactionsResponse,
  FlaggedTransaction,
  FlaggedTransactionsResponse,
  HeaderProofFilters,
  HeaderProofListResponse,
  Participant,
  ParticipantResponse,
  ParticipantsByQueryParameters,
  TokenPaginatedResponse,
  Tokens,
  TokensByQueryParams,
  TransactionDetail,
  TransactionListItem,
  TransactionsByQueryParams,
  TransactionsListResponse,
  TransactionStatus,
} from '../types';
import { eventually } from '../utils/common';
import { shortHex } from '../utils/formatters';
import { BaseController } from './BaseController';
import { GOVERNANCE_API_ENDPOINTS } from './endpoints/governance-api';

export default class GovernanceController extends BaseController{
  constructor(baseUrl: string) {
    super(baseUrl);
  }

  public async getTokens(filters?: TokensByQueryParams): Promise<TokenPaginatedResponse> {
    const response = await this.get<TokenPaginatedResponse>(GOVERNANCE_API_ENDPOINTS.GET_TOKENS, { params: filters });
    return response.data;
  }

  public async getTokenByResourceId(resourceId: string): Promise<Tokens> {
    const response = await this.get<Tokens>(GOVERNANCE_API_ENDPOINTS.GET_TOKEN_BY_RESOURCE_ID(resourceId));
    return response.data;
  }

  public async getParticipants(filters?: ParticipantsByQueryParameters): Promise<ParticipantResponse> {
    const response = await this.get<ParticipantResponse>(GOVERNANCE_API_ENDPOINTS.GET_PARTICIPANTS, { params: filters });
    return response.data;
  }

  public async getTransactions(filters?: TransactionsByQueryParams): Promise<TransactionsListResponse> {
    const response = await this.get<TransactionsListResponse>(GOVERNANCE_API_ENDPOINTS.GET_TRANSACTIONS, { params: filters });
    return response.data;
  }

  public async getTransactionByMessageId(messageId: string): Promise<TransactionDetail> {
    const response = await this.get<TransactionDetail>(GOVERNANCE_API_ENDPOINTS.GET_TRANSACTION_BY_MESSAGE_ID(messageId));
    return response.data;
  }

  public async getHeaderProofs(filters: HeaderProofFilters): Promise<HeaderProofListResponse> {
    const response = await this.get<HeaderProofListResponse>(GOVERNANCE_API_ENDPOINTS.GET_HEADER_PROOFS, { params: filters });
    return response.data;
  }

  public async getEnygmaBatchTransactions(batchId: string): Promise<BatchTransactionsResponse> {
    const response = await this.get<BatchTransactionsResponse>(GOVERNANCE_API_ENDPOINTS.GET_ENYGMA_BATCH_TRANSACTIONS(batchId));
    return response.data;
  }

  public async getParticipantByChainId(chainId: string): Promise<Participant> {
    const response = await this.get<Participant>(GOVERNANCE_API_ENDPOINTS.GET_PARTICIPANT_BY_CHAIN_ID(chainId));
    return response.data;
  }

  public async getTransactionByTransactionId(transactionId: string): Promise<TransactionDetail> {
    const response = await this.get<TransactionDetail>(GOVERNANCE_API_ENDPOINTS.GET_TRANSACTION_BY_TRANSACTION_ID(transactionId));
    return response.data;
  }

  public async getTransactionsBySharedId(sharedId: string): Promise<DvpSwapTransactionsResponse> {
    const response = await this.get<DvpSwapTransactionsResponse>(GOVERNANCE_API_ENDPOINTS.GET_TRANSACTIONS_BY_SHARED_ID(sharedId));
    return response.data;
  }

  public async getFlaggedTransactions(): Promise<FlaggedTransactionsResponse> {
    const response = await this.get<FlaggedTransactionsResponse>(GOVERNANCE_API_ENDPOINTS.GET_FLAGGED_TRANSACTIONS);
    return response.data;
  }

  // ── Polling helpers ──────────────────────────────────────────────────

  public async waitForTransactionStatus(
    messageId: string,
    status: TransactionStatus,
    interval: number,
    maxAttempts: number,
  ): Promise<TransactionDetail> {
    return eventually({
      check: async () => {
        const tx = await this.getTransactionByMessageId(messageId);
        if (tx.status === status) return tx;
      },
      interval,
      attempts: maxAttempts,
      message: `Waiting for tx ${shortHex(messageId)} status → ${status}`,
      tolerateErrors: true,
    });
  }

  public async waitForFlaggedByTransactionId(
    transactionId: string,
    interval: number,
    maxAttempts: number,
  ): Promise<FlaggedTransaction> {
    return eventually({
      check: async () => {
        const { flagged } = await this.getFlaggedTransactions();
        return flagged.find((f) => f.transactionId === transactionId);
      },
      interval,
      attempts: maxAttempts,
      message: `Waiting for flagged record (txId=${shortHex(transactionId)})`,
      tolerateErrors: true,
    });
  }

  public async waitForFlaggedSince(
    since: number,
    interval: number,
    maxAttempts: number,
  ): Promise<FlaggedTransaction> {
    return eventually({
      check: async () => {
        const { flagged } = await this.getFlaggedTransactions();
        return flagged.find((f) => new Date(f.createdAt).getTime() / 1000 > since);
      },
      interval,
      attempts: maxAttempts,
      message: 'Waiting for new flagged tx record',
      tolerateErrors: true,
    });
  }

  public async waitForTransactionByMessageId(
    messageId: string,
    interval: number,
    maxAttempts: number,
  ): Promise<TransactionDetail> {
    return eventually({
      check: () => this.getTransactionByMessageId(messageId),
      interval,
      attempts: maxAttempts,
      message: `Waiting for tx detail messageId=${shortHex(messageId)}`,
      tolerateErrors: true, // 404s until the row is indexed
    });
  }

  public async waitForTransaction(
    filters: TransactionsByQueryParams,
    interval: number,
    maxAttempts: number,
  ): Promise<TransactionListItem> {
    return eventually({
      check: async () => {
        const result = await this.getTransactions(filters);
        return result.data.length > 0 ? result.data[0] : undefined;
      },
      interval,
      attempts: maxAttempts,
      message: 'Waiting for tx matching filters',
    });
  }

  public async waitForCirculatingSupply(
    resourceId: string,
    expected: { participantId: string; balance: string }[],
    interval: number,
    maxAttempts: number,
  ): Promise<Tokens> {
    return eventually({
      check: async () => {
        const token = await this.getTokenByResourceId(resourceId.replace(/^0x/, ''));
        const allMatch = expected.every(({ participantId, balance }) =>
          token.circulatingSupply.some(e => e.participantId === participantId && e.balance === balance)
        );
        return allMatch ? token : undefined;
      },
      interval,
      attempts: maxAttempts,
      message: `Waiting for circulatingSupply rid=${shortHex(resourceId)} → ${JSON.stringify(expected)}`,
      tolerateErrors: true,
    });
  }
}