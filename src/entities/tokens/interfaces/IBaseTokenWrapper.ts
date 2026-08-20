import { TokenStandards } from '../../../enums/TokenStandards';
import { BaseContract, ContractTransactionResponse } from 'ethers';

/** A reference to a TypeChain factory class — used for identity checks and name resolution. */
export type ContractFactoryRef = Function & { name: string };

export type WithResourceId = BaseContract & { resourceId(): Promise<string> };
export type WithdrawFromDvp = BaseContract & { withdrawFromDvp(...args: any[]): Promise<ContractTransactionResponse> };
export type PublicConnector<TPublic extends BaseContract = BaseContract> = {
  connect(address: string, runner: any): TPublic;
};

export interface IBaseTokenWrapper {
  name: string;
  symbol: string;
  resourceId: string;
  standard: TokenStandards;
  address: { [chainId: string]: string };
  uri: string;
  factory: ContractFactoryRef;

  deployContract(cachedKey:string, tokenArgs: string[]): Promise<BaseContract>;
}