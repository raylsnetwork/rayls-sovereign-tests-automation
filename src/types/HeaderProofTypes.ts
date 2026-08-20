export interface HeaderProofFilters {
  chainId: string;
  startBlock: string;
  endBlock: string;
  page?: number;
  pageSize?: number;
}

export interface HeaderProofResponse {
  id: number;
  chainId: string;
  blockNumber: string;
  blockHash: string;
  createdAt: string;
}

export interface PaginationMetadata {
  currentPage: number;
  pageSize: number;
  totalRecords: number;
  totalPages: number;
}

export interface HeaderProofListResponse {
  data: HeaderProofResponse[];
  pagination: PaginationMetadata;
}
