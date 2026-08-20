import { TokenStandards } from '../../enums/TokenStandards';
import { BaseTokenWrapper } from './BaseTokenWrapper';
import { sendTx, eventually, submitTx } from '../../utils/common';
import {
  Erc721DvpExample__factory,
  Erc721DvpOverrideExample__factory,
  ProductionErc721Token__factory,
  ProductionErc721Dvp__factory,
  PublicChainERC721,
  PublicChainERC721__factory,
  RaylsErc721Example__factory,
  DvpErc721PNH,
  DvpErc721PNH__factory,
  ProductionErc721Dvp,
} from '../../../typechain-types';
import { PrivateHub } from '../PrivateHub';
import { PrivacyNode } from '../PrivacyNode';
import { expect } from 'chai';

import { IMintArgsERC721 } from './interfaces/IMintArgs';
import { BaseContract, ContractTransactionReceipt } from 'ethers';
import { ContractFactoryRef } from './interfaces/IBaseTokenWrapper';
import { ERC721ForEnygmaSwapParams } from '../../types/DvpSwapParams';
import { waitForDvpDepositConfirmed } from '../../utils/db-utils';

// Plain (non-DvP) ERC721 handlers: production canonical + the test example. The plain branch
// uses the (uri,name,symbol,endpoint,rnEndpoint,userGovernance) ctor and the single-arg mint.
const PLAIN_ERC721_FACTORIES: ContractFactoryRef[] = [ProductionErc721Token__factory, RaylsErc721Example__factory];
// ERC721 DvP handlers: production canonical + the test example (NOT the override variant).
const DVP_ERC721_FACTORIES: ContractFactoryRef[] = [ProductionErc721Dvp__factory, Erc721DvpExample__factory];

export class ERC721Wrapper<T extends BaseContract> extends BaseTokenWrapper<T> {
  private _currentTokenId: bigint;
  private _nextTokenId : bigint;

  constructor(privacyNode: PrivacyNode, factory: ContractFactoryRef) {
    const isDvp = factory === Erc721DvpOverrideExample__factory || DVP_ERC721_FACTORIES.includes(factory);
    super(privacyNode, factory, isDvp ? TokenStandards.DVPERC721 : TokenStandards.ERC721);
    this._currentTokenId = 0n;
    this._nextTokenId = 1n;
  }

  private get isPlainErc721(): boolean {
    return PLAIN_ERC721_FACTORIES.includes(this.factory);
  }

  get currentTokenId(): bigint {
    return this._currentTokenId;
  }

  get nextTokenId(): bigint {
    return this._nextTokenId;
  }

  async deploy(): Promise<T> {
    const ctorArgs: any[] = [
      this.uri, this.name, this.symbol,
      this.privacyNode.endpointAddress
      ]

    if(this.factory == Erc721DvpOverrideExample__factory){
      ctorArgs.push(this.userWallet.address,
        false)

    } else if (this.isPlainErc721) {
      ctorArgs.push(this.privacyNode.raylsNodeEndpointAddress,
        this.privacyNode.raylsNodeUserGovernance
      )
    }

    return await super.deployContract(this.symbol, ctorArgs);
  }

  async activateOnHub(privateHub: PrivateHub): Promise<void> {
    await super.activateOnHub(privateHub);
    if (this.isPlainErc721) return;
    await privateHub.setContractByResourceId(DvpErc721PNH__factory.name, this.resourceId, this.symbol);
  }

  /** Advances the internal token ID counter. Guarantees uniqueness for a single instance. */
  private incrementTokenId(): bigint {
    if(this._currentTokenId >= this._nextTokenId) throw new Error(
      `Current token id ${this._currentTokenId} is greater than next token id ${this._nextTokenId}`
    )
    this._currentTokenId = this._nextTokenId;
    return this._nextTokenId++;
  }

  async mintAndAwait(
    privateHub: PrivateHub | undefined,
    args: IMintArgsERC721,
  ): Promise<bigint> {
    const tokenId = args.tokenId ?? this._nextTokenId;
    const balanceBefore = await this.getBalanceOf(args.toAddress);
    if (this.isPlainErc721) {
      await this._callContractMint(args.toAddress, tokenId);
    } else {
      await this._callContractMint(args.toAddress, tokenId, []);
    }
    await this.waitForBalance(balanceBefore + 1n, args.toAddress);
    this.incrementTokenId();
    return tokenId;
  }

  async approve(toAddress: string, tokenId: bigint): Promise<void> {
    await sendTx(() => this.contract.approve(toAddress, tokenId), `approve ${this.symbol}`);
  }

  async transfer(to: string, args: { tokenId: bigint }): Promise<void> {
    const from = this.userWallet.address;
    await this.approve(to, args.tokenId);
    await sendTx(() => this.contract.transferFrom(from, to, args.tokenId), `transferFrom ${this.symbol}`);
    const owner = await this.contract.ownerOf(args.tokenId);
    expect(owner).to.equal(to);
  }

  async verifyPublicBalance(nftsCount: bigint, address: string): Promise<void> {
    await this.setPublicContract<PublicChainERC721>(PublicChainERC721__factory);
    await super.verifyPublicBalance(nftsCount, address);
  }

  async depositNftToDvp(privateHub: PrivateHub, nftId: bigint): Promise<ContractTransactionReceipt> {
    const txHash = await super.depositNftToDvp(privateHub, nftId);
    await this.waitForDeposit(privateHub, nftId);
    // Wait for relayer to confirm deposit (Pending → Unspent).
    // The relayer stores the CC-side token address, not the PL-side address.
    const nftContractOnCC = privateHub.getPNHContract<DvpErc721PNH>(this.symbol);
    const ccTokenAddress = await nftContractOnCC.getAddress();
    await waitForDvpDepositConfirmed(this.privacyNode.db.connection, ccTokenAddress, nftId.toString());
    return txHash;
  }

  async waitForDeposit(privateHub: PrivateHub, nftId: bigint): Promise<void> {
    const nftContractOnPrivateHub = privateHub.getPNHContract<DvpErc721PNH>(this.symbol);

    // Get the vault address from the NFT contract
    const coinVaultAddress = await nftContractOnPrivateHub.vaultAddress();

    await eventually<boolean>({
      check: async () => {
        const owner = await nftContractOnPrivateHub.ownerOf(nftId);

        return owner === coinVaultAddress;
      },
      message: `Checking ${this.symbol}#${nftId} owner`,
    });
  };

  async withdrawNftFromDvp(privateHub: PrivateHub, tokenId: bigint, _newOwnerAddress?: string): Promise<ContractTransactionReceipt> {
    // Wait for swap settlement: token must be owned by the actual tx sender (this.userWallet)
    await eventually<boolean>({
      check: async () => (await this.contract.ownerOf(tokenId)) === this.userWallet.address,
      message: `Waiting for ${this.symbol}#${tokenId} owned by caller on destination PN`,
      tolerateErrors: true,
    });

    // Wait for the receiver-side deposit (created during swap) to be confirmed in DB.
    // The relayer creates a new deposit on the destination PN during swap completion,
    // and it must reach Unspent before withdrawFromDvp can succeed.
    const nftContractOnCC = privateHub.getPNHContract<DvpErc721PNH>(this.symbol);
    const ccTokenAddress = await nftContractOnCC.getAddress();
    await waitForDvpDepositConfirmed(this.privacyNode.db.connection, ccTokenAddress, tokenId.toString());

    return await super.withdrawNftFromDvp(privateHub, tokenId);
  };

  async swapForEnygma(
    privateHub: PrivateHub,
    swapParams: ERC721ForEnygmaSwapParams,
  ): Promise<ContractTransactionReceipt> {
    // this.contract is duck-typed (BaseTokenWrapper holds it as `any`); pin the DvP method to its
    // TypeChain signature so an arg-shape drift fails to compile instead of silently passing.
    const dvp = this.contract as Pick<ProductionErc721Dvp, 'swapWithDvpForEnygma'>;
    return await submitTx(
      () => dvp.swapWithDvpForEnygma(
        swapParams.nftId,
        swapParams.enygmaAmount,
        swapParams.enygmaResourceId,
        swapParams.enygmaPLChainId,
        swapParams.sharedId,
        swapParams.validity,
      ),
      `Swapping from NFT side`,
    );
  }
}