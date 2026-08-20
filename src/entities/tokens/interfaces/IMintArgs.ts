export interface IMintArgsERC20 {
  toAddress: string;
  amount: bigint;
}

export interface IMintArgsERC721 {
  toAddress: string;
  tokenId?: bigint;
}

export interface IMintArgsERC1155 {
  toAddress: string;
  tokenId: bigint;
  amount: bigint;
}

export interface IMintArgsEnygma {
  toAddress: string;
  amount: bigint;
}