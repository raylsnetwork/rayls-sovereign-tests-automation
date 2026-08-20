export enum TokenStatus{
  New= 'new',
  Active = 'active',
  Inactive = 'inactive'
}

export enum TokenERCStandard{
  Custom = 'custom',
  ERC20 = 'erc20',
  ERC721 = 'erc721',
  ERC1155 = 'erc1155',
  Enygma = 'enygma',
  DvpERC721 = 'dvp_erc721',
  DvpERC1155 = 'dvp_erc1155'
}

export interface TokensByQueryParams{
  name?:string;
  issuerId?:string;
  status?:TokenStatus;
  ercStandard?:TokenERCStandard;
  symbol?:string;
  decimals?:number;
  createdAfter?:string;
  createdBefore?:string;
}

export interface CirculatingSupplyEntry {
  participantId: string;
  tokenId?: string;
  balance: string;
}

export interface Tokens{
  resourceId:string;
  name:string;
  symbol:string;
  metadataURL?:string | null;
  decimals:number;
  issuerId?:string;
  status: TokenStatus;
  ercStandard: TokenERCStandard;
  totalSupply?:string | null;
  circulatingSupply: CirculatingSupplyEntry[];
  frozenChainIds: string[];
  createdAt:string;
  updatedAt:string;
}

export type TokenPaginatedResponse = {
  data: Tokens[];
  total: number;
  limit: number;
  page: number;
};

// Legacy alias
export type TokenResponse = TokenPaginatedResponse;
