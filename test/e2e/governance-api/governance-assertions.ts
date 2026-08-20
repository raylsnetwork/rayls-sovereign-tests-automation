import { expect } from 'chai';
import { BatchTransaction, DvpSwapStatus, DvpSwapTransaction, MessageType, Protocol, TransactionDetail, TransactionStatus } from '../../../src/types';
import { PrivateHub } from '../../../src/entities/PrivateHub';

// ── Polling constants ──────────────────────────────────────────────────
export const GOV_POLL_INTERVAL_MS = 6000;
export const GOV_POLL_ATTEMPTS_SHORT = 6;     // ~36s  — token activation, participant status
export const GOV_POLL_ATTEMPTS_MEDIUM = 10;   // ~60s  — settlement window checks, single tx indexing
export const GOV_POLL_ATTEMPTS_LONG = 15;     // ~90s  — DvP deposits/withdrawals, flagged records
export const GOV_POLL_ATTEMPTS_TX = 20;       // ~120s — transaction indexing (atomic teleports)
export const GOV_POLL_ATTEMPTS_XLONG = 30;    // ~180s — DvP swap completion, cancellation

// ── Shared types ──────────────────────────────────────────────────────
export interface TokenInfo {
  name: string;
  symbol: string;
  resourceId: string;
  userWallet: { address: string };
}

// ── Private helpers ────────────────────────────────────────────────────
interface HubFields {
  hubTimestamp?: string;
  hubHash?: string;
  hubBlockNumber?: string;
  destinationTransactionHash?: string;
  protocol?: string;
  messageType?: string;
}

function normalizeResourceId(resourceId: string): string {
  return resourceId.replace(/^0x/, '');
}

function expectAddress(actual: string, expected: string, label?: string) {
  expect(actual.toLowerCase(), label).to.equal(expected.toLowerCase());
}

function extractHubFields(tx: TransactionDetail | DvpSwapTransaction): HubFields {
  return {
    hubTimestamp: tx.hubTimestamp,
    hubHash: tx.hubHash,
    hubBlockNumber: 'hubBlockNumber' in tx ? tx.hubBlockNumber : undefined,
    destinationTransactionHash: tx.destinationTransactionHash,
    protocol: tx.protocol,
    messageType: tx.messageType,
  };
}

function expectOptional<T>(actual: T | undefined, expected: T | undefined, label?: string) {
  if (expected !== undefined) expect(actual, label).to.equal(expected);
}

// ── Hub validation ─────────────────────────────────────────────────────
const validateHubFields = async (
  tx: HubFields,
  privateHub: PrivateHub,
  status?: TransactionStatus | DvpSwapStatus,
): Promise<void> => {
  const isExecuted = status === TransactionStatus.EXECUTED || status === DvpSwapStatus.COMPLETED;
  const isEnygma = tx.messageType === MessageType.ENYGMA;
  if (isExecuted && isEnygma)
    expect(tx.hubHash, 'hubHash should be set for executed enygma transactions').to.be.a('string').and.not.be.empty;

  if (tx.hubHash) {
    expect(tx.hubTimestamp, 'hubTimestamp should be set').to.not.be.empty;
    const hubReceipt = await privateHub.provider.getTransactionReceipt(tx.hubHash);
    expect(hubReceipt, 'hub tx should exist on chain').to.not.be.null;
    expect(hubReceipt!.status, 'hub tx should be successful').to.equal(1);
    const ccBlock = await privateHub.provider.getBlock(hubReceipt!.blockNumber);
    const apiHubTimestamp = Number(tx.hubTimestamp!);
    expect(apiHubTimestamp, 'hubTimestamp should match block timestamp').to.equal(ccBlock!.timestamp);
  }
  if (tx.hubBlockNumber)
    expect(tx.hubBlockNumber, 'hubBlockNumber should be set').to.not.be.empty;
  if ((tx.protocol == Protocol.DVP_DEPOSIT || tx.protocol == Protocol.DVP_WITHDRAW) && tx.messageType == MessageType.ENYGMA)
    expect(tx.destinationTransactionHash).to.equal(tx.hubHash);
};

// ── Exported assertion functions ───────────────────────────────────────
// Expected-transaction shape, discriminated on `messageType`. Each token standard
// is forced to provide the fields that are meaningful for it — and forbidden the ones
// that aren't — so a wrong-shaped expectation is a compile error rather than a runtime guess:
//   • fungible (ERC20 / Enygma) → `amount`, no token id
//   • non-fungible (ERC721)     → `ercId` (the tokenId), no fungible amount
//   • semi-fungible (ERC1155)   → `amount` and `ercId` (the tokenId)
interface ExpectedTransactionBase {
  sourceChainId: string;
  destinationChainId: string;
  status: TransactionStatus;
  sourceAddress: string;
  destinationAddress: string;
  protocol: string;
  messageId?: string;
}
interface ExpectedFungibleTransaction extends ExpectedTransactionBase {
  messageType: MessageType.ERC20 | MessageType.ENYGMA;
  amount: number;
}
interface ExpectedNftTransaction extends ExpectedTransactionBase {
  messageType: MessageType.ERC721;
  ercId: string; // tokenId
}
interface ExpectedSemiFungibleTransaction extends ExpectedTransactionBase {
  messageType: MessageType.ERC1155;
  amount: number;
  ercId: string; // tokenId
}
export type ExpectedTransaction =
  | ExpectedFungibleTransaction
  | ExpectedNftTransaction
  | ExpectedSemiFungibleTransaction;

export const assertTransactionResponse = async (
  transaction: TransactionDetail,
  token: TokenInfo,
  expected: ExpectedTransaction,
  privateHub?: PrivateHub,
) => {
  const expectedAmount = 'amount' in expected ? expected.amount : undefined;
  // ercId carries the tokenId for token-id-bearing standards and is empty for fungible ones —
  // the union encodes which, so one compare enforces both directions.
  const expectedErcId = 'ercId' in expected ? expected.ercId : '';

  expect(transaction.tokenName).to.equal(token.name);
  expect(transaction.tokenSymbol).to.equal(token.symbol);
  expect(transaction.resourceId).to.equal(normalizeResourceId(token.resourceId));
  expect(transaction.sourceChainId).to.equal(expected.sourceChainId);
  expect(transaction.destinationChainId).to.equal(expected.destinationChainId);
  expect(transaction.messageType).to.equal(expected.messageType);
  expect(transaction.status).to.equal(expected.status);
  expectAddress(transaction.sourceAddress, expected.sourceAddress);
  expectAddress(transaction.destinationAddress, expected.destinationAddress);
  expectOptional(transaction.messageId, expected.messageId);
  if (expectedAmount !== undefined) expect(Number(transaction.amount)).to.equal(expectedAmount);
  expect(transaction.ercId ?? '', `ercId for ${expected.messageType}`).to.equal(expectedErcId);
  expect(transaction.protocol).to.equal(expected.protocol);
  if (privateHub !== undefined)
    await validateHubFields(extractHubFields(transaction), privateHub, expected.status);
};

export const assertDvpDepositWithdrawItem = async (
  transaction: TransactionDetail,
  token: TokenInfo,
  expected: {
    protocol: Protocol.DVP_DEPOSIT | Protocol.DVP_WITHDRAW;
    sourceChainId: string;
    sourceAddress: string;
    messageType: MessageType;
    amount: number;
    sourceTransactionHash: string;
    destinationChainId: string;
    destinationAddress: string;
    ercId?: string;
  },
  privateHub: PrivateHub,
) => {
  expect(transaction.protocol).to.equal(expected.protocol);
  expect(transaction.messageType).to.equal(expected.messageType);
  expect(transaction.resourceId).to.equal(normalizeResourceId(token.resourceId));
  expect(transaction.sourceChainId).to.equal(expected.sourceChainId);
  expectAddress(transaction.sourceAddress, expected.sourceAddress);
  expectAddress(transaction.destinationAddress, expected.destinationAddress);
  expect(transaction.tokenSymbol).to.equal(token.symbol);
  expect(transaction.tokenName).to.equal(token.name);
  expect(Number(transaction.amount)).to.equal(expected.amount);
  expect(transaction.sourceTransactionHash).to.equal(expected.sourceTransactionHash);
  expect(transaction.destinationChainId).to.equal(expected.destinationChainId);
  expectOptional(transaction.ercId, expected.ercId);
  await validateHubFields(extractHubFields(transaction), privateHub);
};

export const assertDvpSwapTransactionResponse = async (
  transaction: DvpSwapTransaction,
  token: TokenInfo,
  expected: {
    messageType: string;
    status: DvpSwapStatus;
    protocol: string;
    amount: number;
    sourceChainId?: string;
    sourceAddress?: string;
    destinationChainId?: string;
    destinationAddress?: string;
    ercId?: string;
    sourceTransactionHash?: string;
    destinationTransactionHash?: string;
  },
  privateHub: PrivateHub,
) => {
  expect(transaction.tokenSymbol).to.equal(token.symbol);
  expect(transaction.tokenName).to.equal(token.name);
  expect(transaction.resourceId).to.equal(normalizeResourceId(token.resourceId));
  expect(transaction.messageType).to.equal(expected.messageType);
  expect(transaction.status).to.equal(expected.status);
  expect(transaction.protocol).to.equal(expected.protocol);
  expect(Number(transaction.amount)).to.equal(expected.amount);
  expectOptional(transaction.sourceChainId, expected.sourceChainId);
  if (expected.sourceAddress !== undefined)
    expectAddress(transaction.sourceAddress, expected.sourceAddress);
  expectOptional(transaction.destinationChainId, expected.destinationChainId);
  if (expected.destinationAddress !== undefined)
    expectAddress(transaction.destinationAddress, expected.destinationAddress);
  expectOptional(transaction.ercId, expected.ercId);
  expectOptional(transaction.sourceTransactionHash, expected.sourceTransactionHash);
  expectOptional(transaction.destinationTransactionHash, expected.destinationTransactionHash);
  await validateHubFields(extractHubFields(transaction), privateHub, expected.status);
};

export const assertEnygmaBatchTransactionResponse = (
  transaction: BatchTransaction,
  expected: {
    sourceChainId: string;
    destinationChainId: string;
    sourceAddress: string;
    destinationAddress: string;
    tokenSymbol: string;
    amount: number;
  }
) => {
  expect(transaction.messageId, 'messageId should be set').to.be.a('string').and.not.be.empty;
  expect(transaction.sourceChainId).to.equal(expected.sourceChainId);
  expect(transaction.destinationChainId).to.equal(expected.destinationChainId);
  expectAddress(transaction.sourceAddress, expected.sourceAddress);
  expectAddress(transaction.destinationAddress, expected.destinationAddress);
  expect(transaction.tokenSymbol).to.equal(expected.tokenSymbol);
  expect(Number(transaction.amount)).to.equal(expected.amount);
};
