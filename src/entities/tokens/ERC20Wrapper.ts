import { BaseTokenWrapper } from './BaseTokenWrapper';
import { TokenStandards } from '../../enums/TokenStandards';
import {
  Erc20BatchTeleport__factory,
  ProductionErc20Token__factory,
  PublicChainERC20,
  PublicChainERC20__factory,
  TokenExample__factory,
} from '../../../typechain-types';
import { PrivacyNode } from '../PrivacyNode';
import { PrivateHub } from '../PrivateHub';
import { IMintArgsERC20 } from './interfaces/IMintArgs';
import { AbiCoder, BaseContract, Signer } from 'ethers';
import { ContractFactoryRef } from './interfaces/IBaseTokenWrapper';
import { GAS_LIMIT, LOGGER } from '../../config/env-config';
import { sendTx, submitTx } from '../../utils/common';

export class ERC20Wrapper<T extends BaseContract> extends BaseTokenWrapper<T> {
  constructor(privacyNode: PrivacyNode, factory: ContractFactoryRef) {
    super(privacyNode, factory, TokenStandards.ERC20);
  }

  /**
   * Deploy the ERC20 instance through the node's own `RNContractFactoryV1.deployRegisteredAsUser`
   * instead of a constructor deploy — mirrors `EnygmaWrapper.deployViaFactory`. Deploys off a
   * *seeded* factory template so the instance's codehash matches the approved programmability
   * template (needed when the token is a `crossMint`/`crossBurn` target).
   *
   * The seeded key is inferred from the wrapper's `factory` ref (set at construction):
   *   - `TokenExample__factory`      → `RAYLS_ERC20_TEST_KEY` (example runtime — self-identifies as
   *     `ErcStandard.ERC20Test` via `GetERCStandard`, keeping example-only surfaces; requires the
   *     `RAYLS_ERC20_TEST_KEY` codehash seeded on the PNH gate).
   *   - anything else (`ProductionErc20Token__factory`) → `RAYLS_ERC20_KEY` (production runtime).
   *     Byte-for-byte the old `deployErc20AsUser(name, symbol, decimals)` — both reduce to
   *     `_deployRegistered(RAYLS_ERC20_KEY, abi.encode(name,symbol,decimals), bytes32(0))`.
   *
   * `deployRegisteredAsUser` is NOT `restricted` (permissionless "you own what you deploy") and sets
   * TOKEN_OWNER = the deploy `signer` via `_pendingOwnerOverride` (default `userWallet`; pass
   * `adminWallet` to make the admin the owner/authority). The factory no longer accepts a resourceId;
   * the hub callback assigns the real resourceId during `activateOnHub`
   * (PNTokenCoreV1.activateToken). Does NOT auto-register as a hub token, so `activateOnPn()`
   * afterwards runs fresh.
   */
  async deployViaFactory(decimals: number = 18, signer: Signer = this.userWallet): Promise<T> {
    if (this.factory === Erc20BatchTeleport__factory)
      throw new Error('Erc20BatchTeleport has no seeded factory bytecode; use deploy() + activateOnPn() + activateOnHub()');

    const rnFactory = await this.getRnFactory(signer);
    const key = this.factory === TokenExample__factory
      ? await rnFactory.RAYLS_ERC20_TEST_KEY()   // example runtime → ERC20Test
      : await rnFactory.RAYLS_ERC20_KEY();         // production runtime
    const userArgs = AbiCoder.defaultAbiCoder().encode(
      ['string', 'string', 'uint8'],
      [this.name, this.symbol, decimals],
    );
    const receipt = await submitTx(
      () => rnFactory.deployRegisteredAsUser(key, userArgs, { gasLimit: GAS_LIMIT }),
      `Factory-deploying ${this.symbol} as user (${this.factory.name})...`,
    );
    return this.connectFactoryDeployed(receipt, rnFactory, signer);
  }

  async deploy(): Promise<T> {
    const needsUserGovernance = this.factory !== Erc20BatchTeleport__factory;
    const ctorArgs = [
      this.name,
      this.symbol,
      this.privacyNode.endpointAddress,
      this.privacyNode.raylsNodeEndpointAddress,
      ...(needsUserGovernance ? [this.privacyNode.raylsNodeUserGovernance] : []),
    ];
    return await super.deployContract(this.symbol, ctorArgs);
  }

  async mintAndAwait(
    privateHub: PrivateHub | undefined,
    args: IMintArgsERC20,
  ): Promise<void> {
    const balanceBefore = await this.getBalanceOf(args.toAddress);
    await this._callContractMint(args.toAddress, args.amount);
    await this.waitForBalance(balanceBefore + args.amount, args.toAddress);
  }

  async transfer(to: string, args: { amount: bigint }): Promise<void> {
    LOGGER.info(`Transferring ${args.amount} ${this.symbol} to ${to}`);
    await sendTx(() => this.contract.transfer(to, args.amount), `transfer ${this.symbol}`);
    LOGGER.success(`Token transfer successful: ${args.amount} ${this.symbol} → ${to}`);
  }

  async verifyPublicBalance(amount: bigint,  address: string): Promise<void> {
    await this.setPublicContract<PublicChainERC20>(PublicChainERC20__factory);
    await super.verifyPublicBalance(amount, address);
  }
}