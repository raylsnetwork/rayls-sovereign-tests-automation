import { BigNumber } from '@ethersproject/bignumber';
import { Contract } from '@ethersproject/contracts';
import { Wallet } from '@ethersproject/wallet';

/**
 * Generic transaction builder for signing single and batch transactions.
 * Works with any ABI by method name.
 */
export class TransactionBuilder {
  public chainId: number;
  public contract: Contract;
  public wallet: Wallet;

  constructor(abi: any, tokenAddress: string, pk: string, chainId: number) {
    this.chainId = chainId;
    this.wallet = new Wallet(pk);
    this.contract = new Contract(tokenAddress, abi, this.wallet);
  }

  /**
   * Populate and sign a single contract method call.
   */
  async sign(
    method: string,
    args: any[],
    nonce: number,
    overrides?: { gasLimit?: number; gasPrice?: number }
  ): Promise<string> {
    // @ts-ignore – dynamic access to populateTransaction
    const call = await this.contract.populateTransaction[method](...args);

    const tx: any = {
      ...call,
      from: this.wallet.address,
      nonce,
      gasPrice: BigNumber.from(overrides?.gasPrice ?? 0),
      gasLimit: BigNumber.from(overrides?.gasLimit ?? 5_000_000),
      chainId: this.chainId,
    };

    return await this.wallet.signTransaction(tx);
  }

  /**
   * Populate and sign a batch of calls to the same method, incrementing nonce.
   */
  async signBatch(
    txCount: number,
    method: string,
    argsList: any[],
    startNonce: number,
    overrides?: { gasLimit?: number; gasPrice?: number }
  ): Promise<string[]> {
    const signed: string[] = [];
    let nonce = startNonce;
    for (let i = 0; i < txCount; i++) {
      const raw = await this.sign(method, argsList, nonce, overrides);
      signed.push(raw);
      nonce++;
    }
    return signed;
  }
}
