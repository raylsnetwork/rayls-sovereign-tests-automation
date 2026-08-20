import { BaseTokenWrapper } from './BaseTokenWrapper';
import { TokenStandards } from '../../enums/TokenStandards';
import {
  Dvp,
  Dvp__factory,
  DvpTeleport,
  EnygmaDvpIntegration,
  EnygmaDvpIntegration__factory,
  EnygmaTokenExample,
  EnygmaTokenExample__factory,
  EnygmaV1,
  EnygmaV1__factory,
  Merkle,
  Merkle__factory,
} from '../../../typechain-types';
import { PrivateHub } from '../PrivateHub';
import { PrivacyNode } from '../PrivacyNode';
import { DEFAULT_TIMEOUT, GAS_LIMIT, SECOND, USE_DB_CHECKS, ZERO_ADDRESS, ZERO_HASH } from '../../config/env-config';
import { AbiCoder, BaseContract, ContractTransactionReceipt, Signer } from 'ethers';
import {
  EnygmaForErc721SwapParams,
  EnygmaForErc1155SwapParams,
} from '../../types/DvpSwapParams';
import { eventually, submitTx } from '../../utils/common';
import { checkDbBalance } from '../../utils/db-utils';
import { ContractFactoryRef } from './interfaces/IBaseTokenWrapper';
import { IMintArgsEnygma } from './interfaces/IMintArgs';

export class EnygmaWrapper<T extends BaseContract> extends BaseTokenWrapper<T> {
  public resourceId: string;

  constructor(privacyNode: PrivacyNode, factory: ContractFactoryRef) {
    super(privacyNode, factory, TokenStandards.ENYGMA);
    this.resourceId = '';
  }

  async deploy(): Promise<T> {
    // Constructor-deploy is valid for a SEND-ONLY / source token that is registered afterwards
    // (deploy() → activateOnPn() → activateOnHub()). The example
    // bytecode is deployed as-is, so example-only surfaces (e.g. EnygmaTokenExample.addressToFail) stay
    // available (see test/e2e/governance-api/Transactions_Enygma.ts). WARNING: a constructor-deployed
    // instance has a codehash the PNH TemplateRegistry does NOT approve, so any cross-transfer that
    // mints BACK to this instance (bidirectional flows, or a B-side receiver) reverts
    // ProgramData__UnapprovedTemplate — those MUST use deployViaFactory() instead. enygma-payment
    // stays on deployViaFactory().
    const ctorArgs = [
      this.name,
      this.symbol,
      this.privacyNode.endpointAddress,
    ];

    return await super.deployContract(this.symbol, ctorArgs);
  }

  /**
   * Deploy the issuer instance through the node's own `RNContractFactoryV1.deployRegisteredAsUser`
   * instead of a constructor deploy. WHY: every Enygma cross-transfer rides the codehash-gated
   * programmability mint (`crossMintStandard`), and the PNH TemplateRegistry approves only the
   * node's *seeded* factory bytecode codehash. A test-repo constructor-deploy compiles to a
   * different codehash → the return-leg mint reverts `ProgramData__UnapprovedTemplate`.
   * `deployRegisteredAsUser` deploys off the seeded template, so the instance's extcodehash matches
   * the approved one and clears the gate.
   *
   * The seeded key is inferred from the wrapper's `factory` ref (set at construction):
   *   - `EnygmaTokenExample__factory` → `RAYLS_ENYGMA_TEST_KEY` (the *example* runtime — exposes
   *     example-only surfaces like `addressToFail`/`receiveMsgA` and self-identifies as
   *     `ErcStandard.EnygmaTest`, so the receiver auto-deploys the example mirror on the destination
   *     PN via `ResourceManager._keyForTemplate`; the mirror carries the native `addressToFail`
   *     revert trap, so a cross-transfer to `addressToFail` reverts at the destination contract —
   *     no relayer fault-injection needed). REQUIRES the `RAYLS_ENYGMA_TEST_KEY` codehash seeded on
   *     the PNH TemplateRegistry for `crossMintStandard`/`crossMint`/`crossBurn`
   *     (see `seed-standard-templates`), else the example mirror's settlement mint reverts
   *     `ProgramData__UnapprovedTemplate`. Used by `test/e2e/governance-api/Transactions_Enygma.ts`.
   *   - anything else (`ProductionEnygmaToken__factory`) → `RAYLS_ENYGMA_KEY` (production runtime).
   *     Equivalent to the old `deployEnygmaAsUser(name, symbol, decimals)` — both reduce to
   *     `_deployRegistered(RAYLS_ENYGMA_KEY, abi.encode(name,symbol,decimals), bytes32(0))`.
   *
   * `deployRegisteredAsUser` is NOT `restricted` (permissionless "you own what you deploy") — safe to
   * sign as userWallet — and sets `_pendingOwnerOverride = msg.sender`, so TOKEN_OWNER = userWallet
   * (mint via `this.contract`). The token deploys with `bytes32(0)` resourceId; the hub callback
   * (`activateToken` → `setResourceId`) assigns the real rid during activateOnHub. It does NOT
   * auto-register as a hub token, so `registerToken(addr)` afterwards runs fresh.
   */
  async deployViaFactory(decimals: number = 18, signer: Signer = this.userWallet): Promise<T> {
    const rnFactory = await this.getRnFactory(signer);
    const key = this.factory === EnygmaTokenExample__factory
      ? await rnFactory.RAYLS_ENYGMA_TEST_KEY()   // example runtime → EnygmaTest, addressToFail trap
      : await rnFactory.RAYLS_ENYGMA_KEY();        // production runtime
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

  async activateOnHub(privateHub: PrivateHub): Promise<void> {
    await super.activateOnHub(privateHub);
    const EnygmaV1 = await privateHub.setContractByResourceId<EnygmaV1>(EnygmaV1__factory.name, this.resourceId, this.symbol);
    this.resourceId = await EnygmaV1.resourceId();
  }

  async mintAndAwait(
    privateHub: PrivateHub | undefined,
    args: IMintArgsEnygma,
  ): Promise<void> {
    const balanceBefore = await this.getBalanceOf(args.toAddress);
    await this._callContractMint(args.toAddress, args.amount);
    await this.waitForBalance(balanceBefore + args.amount, args.toAddress);

    if (privateHub && USE_DB_CHECKS) {
      await checkDbBalance<T>(
        Number(args.amount),
        privateHub, this.privacyNode, this);
    }
  }

  async depositEnygmaToDvp(
    depositAmount: bigint,
    expectedBalance: bigint,
    privateHub: PrivateHub,
  ): Promise<ContractTransactionReceipt> {
    // Use a safety margin to avoid missing Commitments events that the Merkle
    // processor may emit in blocks before our snapshot when running in parallel.
    const currentBlock = await privateHub.provider.getBlockNumber();
    const fromBlockNumber = Math.max(0, currentBlock - 10);
    const initialEventCount = await this.getCommitmentsEventCount(privateHub, fromBlockNumber);

    const receipt = await submitTx(
      () => (this.contract as unknown as EnygmaTokenExample).depositToDvp(depositAmount),
      `Depositing ${depositAmount} tokens to Dvp`,
    );

    await this.waitForDepositsToComplete(initialEventCount + 1, privateHub, fromBlockNumber);
    await checkDbBalance(Number(expectedBalance), privateHub, this.privacyNode, this);

    return receipt;
  };

  async withdrawEnygmaFromDvp(
    withdrawAmount: bigint,
    privateHub: PrivateHub,
  ): Promise<ContractTransactionReceipt> {
    const balanceBefore = await this.getBalanceOf(this.userWallet.address);
    const expectedBalance = balanceBefore + BigInt(withdrawAmount);

    const receipt = await submitTx(
      () => (this.contract as unknown as EnygmaTokenExample).callWithdrawFromDvp(withdrawAmount),
      `Withdrawing ${withdrawAmount} tokens from Dvp`,
    );

    await eventually<boolean>({
      check: async () => {
        const balance = await this.getBalanceOf(this.userWallet.address);
        return balance === expectedBalance;
      },
      message: `Checking ${this.symbol} balance post-withdraw`,
    });

    await checkDbBalance(Number(expectedBalance), privateHub, this.privacyNode, this);
    return receipt;
  }

  async waitForDepositsToComplete(
    numberOfDeposits: number,
    privateHub: PrivateHub,
    fromBlockNumber: number = 0,
  ): Promise<void> {
    await this.waitForDvpAddressReady(privateHub);
    const merkleContract = await this.resolveMerkleContract(privateHub);
    await this.waitForMerkleCommitments(merkleContract, numberOfDeposits, privateHub, fromBlockNumber);
  }

  async waitForDeploymentOnNode(destination: PrivacyNode): Promise<void> {
    await this.resolveAddressOnPL(destination);
    const signerOnDest = this.userWallet.connect(destination.provider);
    await destination.contractStore.connectAt(this.factory.name, this.address[destination.chainId], this.symbol, signerOnDest);
  }

  async swapForERC721(
    privateHub: PrivateHub,
    swapParams: EnygmaForErc721SwapParams,
  ): Promise<ContractTransactionReceipt> {
    return await submitTx(
      () => (this.contract as unknown as EnygmaTokenExample).swapWithDvpForERC721(
        swapParams.nftId, swapParams.nftResourceId, swapParams.enygmaAmount,
        swapParams.nftPLChainId, swapParams.sharedId, swapParams.validity,
      ),
      `Swapping from enygma side`,
    );
  }

  async swapForERC1155(
    privateHub: PrivateHub,
    swapParams: EnygmaForErc1155SwapParams,
  ): Promise<void> {
    await submitTx(
      () => this.contract.swapWithDvpForERC1155(
        swapParams.nftId, swapParams.nftAmount, swapParams.nftResourceId,
        swapParams.enygmaAmount, swapParams.nftPLChainId, swapParams.sharedId,
        swapParams.validity,
      ),
      `Swapping from enygma side`,
    );
  }

  private async waitForDvpAddressReady(privateHub: PrivateHub): Promise<void> {
    await eventually<boolean>({
      check: async () => {
        const dvpIntegrationAddress = await privateHub
          .getPNHContract<EnygmaV1>(this.symbol)
          .getDvpIntegrationContractAddress();

        const dvpIntegration: EnygmaDvpIntegration = await privateHub.getContractAt(
          EnygmaDvpIntegration__factory.name,
          dvpIntegrationAddress,
          `${this.symbol}_EnygmaDvpIntegration`,
        );
        const dvpAddress = await dvpIntegration.getDvpAddress();

        return dvpAddress !== ZERO_ADDRESS;
      },
      message: `Resolving ${this.symbol} DvpAddress`,
    });
  }

  private async resolveMerkleContract(privateHub: PrivateHub): Promise<Merkle> {
    const dvpIntegration = privateHub.getContract<EnygmaDvpIntegration>(`${this.symbol}_EnygmaDvpIntegration`);
    const dvpAddress = await dvpIntegration.getDvpAddress();
    const dvp: Dvp = await privateHub.getContractAt(Dvp__factory.name, dvpAddress, `${this.symbol}_Dvp`);
    const vaultId = await dvpIntegration.getVaultId();
    const enygmaVaultAddress = await dvp.vaultById(vaultId);

    return privateHub.getContractAt(Merkle__factory.name, enygmaVaultAddress, `${this.symbol}_Merkle`);
  }

  private async waitForMerkleCommitments(
    merkleContract: Merkle,
    numberOfDeposits: number,
    privateHub: PrivateHub,
    fromBlockNumber: number,
  ): Promise<void> {
    const dvpTeleport = privateHub.getContract<DvpTeleport>('DvpTeleport');
    const enygmaTokenAddress = await privateHub.getPNHContract<EnygmaV1>(this.symbol).getAddress();

    await eventually<boolean>({
      check: async () => {
        const currentRoot = await merkleContract.currentRoot();
        const treeNumber = await merkleContract.treeNumber();
        const isValidRoot = await merkleContract.isValidRoot(treeNumber, currentRoot);

        const toBlockNumber = await privateHub.provider.getBlockNumber();
        const commitmentsFilter = dvpTeleport.filters.Commitments(enygmaTokenAddress);
        const logs = await dvpTeleport.queryFilter(commitmentsFilter, fromBlockNumber, toBlockNumber);

        return isValidRoot && logs.length === numberOfDeposits;
      },
      message: `Waiting for ${numberOfDeposits} ${this.symbol} deposits on Merkle Tree`,
      attempts: (DEFAULT_TIMEOUT * 2) / SECOND,
    });
  }

  private async getCommitmentsEventCount(privateHub: PrivateHub, fromBlockNumber: number): Promise<number> {
    try {
      const dvpTeleport = privateHub.getContract<DvpTeleport>('DvpTeleport');
      const enygmaTokenAddress = await privateHub.getPNHContract<EnygmaV1>(this.symbol).getAddress();
      const commitmentsFilter = dvpTeleport.filters.Commitments(enygmaTokenAddress);
      const toBlockNumber = await privateHub.provider.getBlockNumber();
      const logs = await dvpTeleport.queryFilter(commitmentsFilter, fromBlockNumber, toBlockNumber);
      return logs.length;
    } catch {
      return 0;
    }
  }

  // Helper to get the associated EnygmaDvpIntegration associated with EnygmaV1 contract
  async getDvpIntegrationAddress(privateHub: PrivateHub): Promise<string> {
    const dvpIntegrationAddress = await privateHub
          .getPNHContract<EnygmaV1>(this.symbol)
          .getDvpIntegrationContractAddress();
    return dvpIntegrationAddress
  }
}