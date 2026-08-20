import { TokenStandards } from '../../enums/TokenStandards';
import { BaseTokenWrapper } from './BaseTokenWrapper';
import { sendTx, eventually, submitTx } from '../../utils/common';
import {
  Erc1155DvpExample__factory,
  ProductionErc1155Token__factory,
  ProductionErc1155Dvp__factory,
  PublicChainERC1155,
  PublicChainERC1155__factory,
  RaylsErc1155Example__factory,
  DvpErc1155PNH,
  DvpErc1155PNH__factory,
  ProductionErc1155Dvp,
} from '../../../typechain-types';
import { generateRandomHex } from '../../utils/generators';
import { PrivacyNode } from '../PrivacyNode';
import { PrivateHub } from '../PrivateHub';
import { IMintArgsERC1155 } from './interfaces/IMintArgs';
import { LOGGER } from '../../config/env-config';
import { expect } from 'chai';
import { BaseContract, ContractTransactionReceipt, ZeroAddress } from 'ethers';
import { ContractFactoryRef } from './interfaces/IBaseTokenWrapper';
import { ERC1155ForEnygmaSwapParams } from '../../types/DvpSwapParams';

// Plain (non-DvP) ERC1155 handlers: production canonical + the test example. The plain branch uses
// the (uri,name,endpoint,rnEndpoint,userGovernance) ctor and the (to,id,amount,data) mint.
const PLAIN_ERC1155_FACTORIES: ContractFactoryRef[] = [ProductionErc1155Token__factory, RaylsErc1155Example__factory];
// ERC1155 DvP handlers: production canonical + the test example.
const DVP_ERC1155_FACTORIES: ContractFactoryRef[] = [ProductionErc1155Dvp__factory, Erc1155DvpExample__factory];

export class ERC1155Wrapper<T extends BaseContract> extends BaseTokenWrapper<T> {
  constructor(privacyNode: PrivacyNode, factory: ContractFactoryRef) {
    const standard = DVP_ERC1155_FACTORIES.includes(factory)
      ? TokenStandards.DVPERC1155
      : TokenStandards.ERC1155;
    super(privacyNode, factory, standard);
    this.uri = `base://${generateRandomHex(6)}`;
  }

  /** True for the ERC1155 DvP handlers — production or test example. */
  private get isDvp(): boolean {
    return DVP_ERC1155_FACTORIES.includes(this.factory);
  }

  /** True for the plain (non-DvP) ERC1155 handlers — production or test example. */
  private get isPlainErc1155(): boolean {
    return PLAIN_ERC1155_FACTORIES.includes(this.factory);
  }

  async deploy(): Promise<T> {
    let ctorArgs: any[];
    if (this.isDvp) {
      // DvP ERC1155 expects (uri, name, endpointAddress)
      ctorArgs = [this.uri, this.name, this.privacyNode.endpointAddress];
    } else {
      // Plain ERC1155 expects (uri, name, endpointAddress, raylsNodeEndpoint, userGovernance)
      ctorArgs = [
        this.uri,
        this.name,
        this.privacyNode.endpointAddress,
        this.privacyNode.raylsNodeEndpointAddress,
        this.privacyNode.raylsNodeUserGovernance,
      ];
    }

    return await super.deployContract(this.symbol, ctorArgs);
  }

  async activateOnHub(privateHub: PrivateHub): Promise<void> {
    await super.activateOnHub(privateHub);
    if (this.isPlainErc1155) return;
    await privateHub.setContractByResourceId(DvpErc1155PNH__factory.name, this.resourceId, this.symbol);
  }

  async mintAndAwait(
    privateHub: PrivateHub | undefined,
    args: IMintArgsERC1155,
  ): Promise<void> {
    const balanceBefore = await this.getBalanceOf(args.toAddress, args.tokenId);
    // Plain and DvP take different mint signatures; they are mutually exclusive, so branch with
    // else-if and fail loud on a factory that is neither (rather than silently skipping the mint
    // and then timing out in waitForBalance).
    if (this.isPlainErc1155) {
      await this._callContractMint(args.toAddress, args.tokenId, args.amount, '0x');
    } else if (this.isDvp) {
      await this._callContractMint(args.toAddress, args.tokenId, args.amount, '0x', []);
    } else {
      throw new Error(`mintAndAwait: ${this.factory.name} is neither a plain nor a DvP ERC1155 factory`);
    }
    await this.waitForBalance(balanceBefore + args.amount, args.toAddress, args.tokenId);
  }

  async waitForBalance(expectedAmount: bigint, address: string, tokenId: bigint): Promise<void> {
    await super.waitForBalance(expectedAmount, address, tokenId)
  }

  async waitForPNHMintRelay(privateHub: PrivateHub, nftId: bigint, expectedAmount: bigint): Promise<string> {
    const ccContract = privateHub.getPNHContract<DvpErc1155PNH>(this.symbol);
    // Stay under Besu's --rpc-max-logs-range default of 5000.
    const lookback = 4000;
    const tipAtCall = await privateHub.provider.getBlockNumber();
    const fromBlock = Math.max(0, tipAtCall - lookback);
    const vaultAddr = (await ccContract.vaultAddress()).toLowerCase();
    const zero = ZeroAddress.toLowerCase();
    let owner = '';
    await eventually<boolean>({
      check: async () => {
        // The on-PNH holder of the deposit-bound supply is whichever relayer
        // DvpOperator EOA currently owns the tokens. That EOA can become the
        // holder via a fresh mint (first-time deposit) OR a vault → relayer
        // transfer driven by the prior cycle's withdrawal — so scan every
        // TransferSingle for this nftId (newest first), skip the zero address
        // and the vault, and pick the first `to` whose current balance can
        // cover `expectedAmount`. Mint-only filtering would miss the post-
        // withdrawal case because the relayer receives those tokens via a
        // regular transfer, not a mint.
        const filter = ccContract.filters.TransferSingle();
        const tip = await privateHub.provider.getBlockNumber();
        const events = await ccContract.queryFilter(filter, fromBlock, tip);

        const seen = new Set<string>();
        const candidates: string[] = [];
        for (let i = events.length - 1; i >= 0; i--) {
          const event = events[i];
          if (!('args' in event)) continue;
          if (event.args.id !== nftId) continue;
          const to: string = event.args.to;
          const toLower = to.toLowerCase();
          if (toLower === zero || toLower === vaultAddr) continue;
          if (seen.has(toLower)) continue;
          seen.add(toLower);
          candidates.push(to);
        }

        for (const candidate of candidates) {
          const bal = await ccContract.balanceOf(candidate, nftId);
          if (bal >= expectedAmount) {
            owner = candidate;
            return true;
          }
        }
        return false;
      },
      message: `Waiting for CC ${this.symbol} mint relay #${nftId}`,
    });
    return owner;
  }

  async depositNftToDvp(privateHub: PrivateHub, nftId: bigint, amount: bigint): Promise<ContractTransactionReceipt> {
    const nftContractOnPrivateHub = privateHub.getPNHContract<DvpErc1155PNH>(this.symbol);

    const coinVaultAddress = await nftContractOnPrivateHub.vaultAddress();

    const owner = await this.waitForPNHMintRelay(privateHub, nftId, amount);

    const balanceOfOwnerInitial = await nftContractOnPrivateHub.balanceOf(owner, nftId);

    const balanceToCheck = balanceOfOwnerInitial - BigInt(amount);
    const initialBalanceOfVault = await nftContractOnPrivateHub.balanceOf(
      coinVaultAddress,
      nftId
    );

    const receipt = await super.depositNftToDvp(privateHub, nftId, amount, '0x');

    await eventually<boolean>({
      check: async () => {
        const balanceOfOwner = await nftContractOnPrivateHub.balanceOf(owner, nftId);
        return balanceOfOwner === balanceToCheck;
      },
      message: `Waiting for relayer ${this.symbol}#${nftId} balance → ${balanceToCheck}`,
    });

    const finalVaultBalance = initialBalanceOfVault + BigInt(amount);
    await eventually<boolean>({
      check: async () => {
        const vaultBalance = await nftContractOnPrivateHub.balanceOf(coinVaultAddress, nftId);
        return vaultBalance === finalVaultBalance;
      },
      message: `Waiting for CoinVault ${this.symbol}#${nftId} balance → ${finalVaultBalance}`,
    });

    return receipt;
  }

  async waitForDeposit(privateHub: PrivateHub, nftId: bigint, amount: bigint): Promise<void> {
    const nftContractOnPrivateHub = privateHub.getPNHContract<DvpErc1155PNH>(this.symbol);

    await eventually<boolean>({
      check: async () => {
        const dvpBalance = await nftContractOnPrivateHub.balanceOf(privateHub.dvpAddress, nftId);
        return dvpBalance === BigInt(amount);
      },
      message: `Waiting for Dvp ${this.symbol}#${nftId} balance → ${amount}`,
    });
  }

  async withdrawNftFromDvp(privateHub: PrivateHub, nftId: bigint, amount: bigint, newOwnerAddress: string): Promise<ContractTransactionReceipt> {

    let balanceLockedBefore = 0n;

    const ownerBalanceBefore: bigint = await this.contract.balanceOf(newOwnerAddress, nftId);

    await eventually<boolean>({
      check: async () => {
        balanceLockedBefore = await this.contract.lockedForDvp(this.userWallet.address, nftId);
        return balanceLockedBefore >= BigInt(amount);
      },
      message: `Checking ${this.symbol}#${nftId} locked balance pre-withdraw`,
    });

    const receipt = await submitTx(() => this.contract.withdrawFromDvp(nftId, amount, "0x"), `Withdrawing NFT from Dvp`);

    // NOTE: if newOwnerAddress starts with 0 balance the correct condition is
    // balance === ownerBalanceBefore + BigInt(amount). Verify against the intended
    // test scenario before changing this.
    await eventually<boolean>({
      check: async () => {
        const balance = await this.contract.balanceOf(newOwnerAddress, nftId);
        return balance === ownerBalanceBefore;
      },
      message: `Checking ${this.symbol}#${nftId} owner balance post-withdraw`,
    });

    return receipt;
  }

  async approveForAll(toAddress: string, approved: boolean): Promise<void> {
    LOGGER.log(`[DEBUG] Approving all for ${toAddress} to ${approved}`);
    await sendTx(() => this.contract.setApprovalForAll(toAddress, approved), `approveForAll ${this.symbol}`);
  }

  async transfer(to: string, args: { tokenId: bigint; amount: bigint }): Promise<void> {
    const from = this.userWallet.address;
    await this.approveForAll(to, true);
    LOGGER.log(`[DEBUG] Transferring ${args.amount} of token ${args.tokenId} from ${from} to ${to}`);
    await sendTx(
      () => this.contract.safeTransferFrom(from, to, args.tokenId, args.amount, '0x'),
      `safeTransferFrom ${this.symbol}`,
    );
    const balanceOwner = await this.contract.balanceOf(to, args.tokenId);
    expect(balanceOwner).to.equal(args.amount);
  }

  async verifyPublicBalance(
    expectedBalance: bigint,
    address: string,
    tokenId: bigint
  ): Promise<void> {
    await this.setPublicContract<PublicChainERC1155>(PublicChainERC1155__factory);
    await super.verifyPublicBalance( expectedBalance, address, tokenId)
  }

  async swapForEnygma(
    privateHub: PrivateHub,
    swapParams: ERC1155ForEnygmaSwapParams,
  ): Promise<ContractTransactionReceipt> {
    // this.contract is duck-typed (BaseTokenWrapper holds it as `any`); pin the DvP method to its
    // TypeChain signature so an arg-shape drift fails to compile instead of silently passing.
    const dvp = this.contract as Pick<ProductionErc1155Dvp, 'swapWithDvpForEnygma'>;
    return await submitTx(
      () => dvp.swapWithDvpForEnygma(
        swapParams.nftId,
        swapParams.nftAmount,
        swapParams.data,
        swapParams.enygmaAmount,
        swapParams.enygmaResourceId,
        swapParams.enygmaPLChainId,
        swapParams.sharedId,
        swapParams.validity,
      ),
      `Swapping from NFT side`,
    );
  }

  async waitForLockedAndDvpBalance(
    privateHub: PrivateHub,
    ownerAddress: string,
    tokenId: bigint,
    expectedLocked: bigint,
    expectedDvp: bigint,
    message?: string
  ): Promise<void> {
    const ccAddress = await privateHub.getEndpointV1().getAddressByResourceId(this.resourceId);
    const cc = await privateHub.getContractAt<DvpErc1155PNH>(
      DvpErc1155PNH__factory.name,
      ccAddress,
      `${this.symbol}_DvpErc1155PNH`
    );

    await eventually<boolean>({
      check: async () => {
        const locked = await this.contract.lockedForDvp(ownerAddress, tokenId);
        const dvpBal = await cc.balanceOf(privateHub.dvpAddress, tokenId);
        LOGGER.log(`[DEBUG] Invariant polling tokenId=${tokenId}: locked=${locked} (exp=${expectedLocked}), dvp=${dvpBal} (exp=${expectedDvp})`);
        return locked === BigInt(expectedLocked) && dvpBal === BigInt(expectedDvp);
      },
      message: message || `Waiting for ${this.symbol}#${tokenId} locked → ${expectedLocked}, dvp → ${expectedDvp}`,
    });
  }

  data(value: string = "") {
    return Buffer.from(value);
  }
}