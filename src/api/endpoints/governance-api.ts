export const GOVERNANCE_API_ENDPOINTS = {
  GET_TOKENS: "/audit/tokens",
  GET_PARTICIPANTS: '/audit/participants',
  GET_TRANSACTIONS: '/audit/transactions',
  GET_TRANSACTION_BY_MESSAGE_ID: (messageId: string) => `/audit/transactions/${messageId}`,
  GET_HEADER_PROOFS: '/audit/header-proofs',
  GET_TRANSACTION_BY_TRANSACTION_ID: (transactionId: string) => `/audit/transactions/dvp/${transactionId}`,
  GET_ENYGMA_BATCH_TRANSACTIONS: (batchId: string) => `/audit/transactions/enygma/batch/${batchId}`,
  GET_PARTICIPANT_BY_CHAIN_ID: (chainId: string) => `/audit/participants/${chainId}`,
  GET_TRANSACTIONS_BY_SHARED_ID: (sharedId: string) => `/audit/transactions/dvp/swap/${sharedId}`,
  GET_TOKEN_BY_RESOURCE_ID: (resourceId: string) => `/audit/tokens/${resourceId}`,
  GET_FLAGGED_TRANSACTIONS: '/flagged',
};