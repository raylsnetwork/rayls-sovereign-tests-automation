import { SharedObjects } from '../../typechain-types/contracts/remote/rayls-protocol-sdk/tokens/RaylsEnygmaHandler';

export enum TransactionStatus{
    PENDING='pending',
    EXECUTED='executed',
    REJECTED='rejected',
    REVERTED='reverted',
    CREDIT_MEMO='credit_memo'
}

export enum MessageType{
    ERC20='erc20',
    ERC721='erc721',
    ERC1155='erc1155',
    ENYGMA='enygma',
    CUSTOM='custom',
    DVP_ERC721='dvp_erc721',
    DVP_ERC1155='dvp_erc1155',
}

export enum Protocol {
    CUSTOM = 'CUSTOM',
    VANILLA = 'VANILLA',
    ATOMIC = 'ATOMIC',
    ENYGMA = 'ENYGMA',
    DVP_DEPOSIT = 'DVP_DEPOSIT',
    DVP_WITHDRAW = 'DVP_WITHDRAW',
    DVP_SWAP = 'DVP_SWAP',
}

export enum DvpSwapStatus {
    PENDING   = 'pending',
    COMPLETED = 'completed',
    FAILED    = 'failed',
    CANCELLED = 'cancelled',
    EXPIRED   = 'expired',
}

export interface DvpSwapTransaction {
    transactionId: string;
    createdAt: string;
    sourceChainId: string;
    sourceAddress: string;
    destinationChainId: string;
    destinationAddress: string;
    amount: string;
    tokenName: string;
    tokenSymbol: string;
    sourceTransactionHash: string;
    destinationTransactionHash: string;
    hubTimestamp: string;
    resourceId: string;
    messageType: string;
    protocol: string;
    status: string;
    ercId?: string;
    payload?: string;
    hubHash?: string;
}

export type DvpSwapTransactionsResponse = DvpSwapTransaction[];

export interface TransactionsByQueryParams{
    limit?:string;
    page?: string;
    messageId?:string;
    status?:TransactionStatus;
    sourceChainId?:string;
    destinationChainId?: string ;
    fromAddress?: string;
    toAddress?:string;
    messageType?:MessageType;
    resourceId?:string ;
    amountMin?: number ;
    initiatedBefore?: number;
    initiatedAfter?: number;
}

// Matches TransactionListDto from the governance API (list endpoint)
export interface TransactionListItem {
    type: string;
    id: string;
    idType: string;
    createdAt: string;
    sourceChainId: string;
    sourceAddress: string;
}

// Matches TransactionDetailDto from the governance API (detail endpoint)
export interface TransactionDetail {
    id: string;
    messageId: string;
    sourceTransactionHash?: string;
    destinationTransactionHash?: string;
    status?: string;
    sourceChainId?: string;
    destinationChainId?: string;
    sourceTimestamp?: string;
    destinationTimestamp?: string;
    sourceAddress: string;
    destinationAddress: string;
    amount: string;
    resourceId: string;
    messageType: string;
    tokenName?: string;
    tokenSymbol?: string;
    protocol: string;
    ercId?: string;
    tokenMetadataImageUrl?: string;
    tokenMetadataName?: string;
    tokenMetadataDescription?: string;
    payload?: string;
    hubHash?: string;
    hubTimestamp?: string;
    hubBlockNumber?: string;
    revertDataTransaction?: RevertDataTransaction;
    type?: string;
    createdAt?: string;
}

// Revert data returned for reverted transactions
export interface RevertDataTransaction {
    txHashDestinationRevert?: string;
    txHashDestinationRevertStatus?: number;
    txHashSourceRevert?: string;
    txHashSourceRevertStatus?: number;
}

// Individual transaction in an Enygma batch
export interface BatchTransaction {
    messageId: string;
    createdAt: string;
    sourceChainId: string;
    sourceAddress: string;
    destinationChainId: string;
    destinationAddress: string;
    amount: string;
    tokenSymbol: string;
}

// Wrapper returned by GET /audit/transactions/enygma/batch/:batchId
export type BatchTransactionsResponse = {
    data: BatchTransaction[];
    total: number;
    limit: number;
    page: number;
}

// Legacy alias kept for backward compatibility with any remaining usages
export type Transaction = TransactionListItem;

// Wrapper returned by GET /audit/transactions
export type TransactionsListResponse = {
  data: TransactionListItem[];
  total: number;
  limit: number;
  page: number;
}

// Flagged transaction returned by GET /flagged
export interface FlaggedTransaction {
    id: string;
    transactionId: string;
    createdAt: string;
    updatedAt: string;
}

export type FlaggedTransactionsResponse = {
    flagged: FlaggedTransaction[];
}

export type EnygmaCrossTransfer = {
  destinationAddresses: string[];
  amounts: bigint[];
  destinationChainIds: string[];
  // Per-recipient programmability steps (parallel to destinationAddresses). `[]` per recipient = a
  // plain transfer; the handler auto-prepends the settlement mint blob.
  programData: SharedObjects.EnygmaProgramDataStruct[][];
}

export type EnygmaLinearTransfer = {
  destinationAddress: string;
  amount: bigint;
  destinationChainId: string,
  // Programmability steps for the single recipient (`[]` = plain transfer).
  programData: SharedObjects.EnygmaProgramDataStruct[],
}