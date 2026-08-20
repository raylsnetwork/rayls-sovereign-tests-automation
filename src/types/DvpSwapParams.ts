export type EnygmaForErc721SwapParams = {
  nftId: bigint;
  nftResourceId: string;
  enygmaAmount: bigint;
  nftPLChainId: string;
  sharedId: string;
  validity: number;
};

export type EnygmaForErc1155SwapParams = {
  nftId: bigint;
  nftAmount: bigint;
  nftResourceId: string;
  enygmaAmount: bigint;
  nftPLChainId: string;
  sharedId: string;
  validity: number;
};

export interface ERC721ForEnygmaSwapParams {
  nftId: bigint;
  enygmaAmount: bigint;
  enygmaResourceId: string;
  enygmaPLChainId: string;
  sharedId: string;
  validity: number;
}

export interface ERC1155ForEnygmaSwapParams {
  nftId: bigint;
  nftAmount: bigint;
  data: '0x';
  enygmaAmount: bigint;
  enygmaResourceId: string;
  enygmaPLChainId: string;
  sharedId: string;
  validity: number;
}
