import { generateRandomHex } from '../../utils/generators';
import {
  GAS_LIMIT,
  LOGGER,
  PUBLIC_CHAIN_RPC_URL,
  ZERO_ADDRESS,
  ZERO_HASH,
} from '../../config/env-config';
import { TokenStandards } from '../../enums/TokenStandards';
import { BaseContract, ContractTransactionReceipt, ethers } from 'ethers';
import { PrivacyNode } from '../PrivacyNode';
import { ContractFactoryRef, IBaseTokenWrapper, PublicConnector } from './interfaces/IBaseTokenWrapper';
import { PrivateHub } from '../PrivateHub';
import {
  EndpointV1,
  RaylsPublicApp__factory,
  RaylsAccessManagerV1__factory,
  PublicRNEndpointV1__factory,
  RNContractFactoryV1,
  RNContractFactoryV1__factory,
} from '../../../typechain-types';
import { expect } from 'chai';
import { eventually, submitTx } from '../../utils/common';
import { shortHex } from '../../utils/formatters';
import { getProvider } from '../../utils/network-utils';
import { createUserOperator } from '../../utils/wallet-factory';

export class BaseTokenWrapper<T extends BaseContract> implements IBaseTokenWrapper {
  public name: string;
  public symbol: string;
  public resourceId: string;
  public standard: TokenStandards;
  public address: { [chainId: string]: string };
  public uri: string;
  public factory: ContractFactoryRef;
  // Duck-typed on purpose. The base class and subclasses call concrete TypeChain methods
  // (mint/balanceOf/approve/depositIntoDvp/…) that are NOT on the `BaseContract` bound of `T`, and
  // production-deployed wrappers hold an instance whose type lacks the `*Example`-only methods
  // some flows invoke (e.g. EnygmaTokenExample.depositToDvp). Narrowing to `T`/`T | undefined` does
  // NOT remove the `as unknown as EnygmaTokenExample` casts (T still lacks those methods) and DOES
  // break ~390 call sites across wrappers + tests with "property does not exist on T" /
  // "possibly undefined". Concrete-typed access is opt-in at the call site via `as Pick<Concrete,'m'>`
  // (see ERC721/ERC1155 swapForEnygma) or `as unknown as Concrete` (EnygmaWrapper DvP ops).
  public contract: any;
  public publicContract: any;
  public privacyNode: PrivacyNode;
  public userWallet: ethers.HDNodeWallet | ethers.Wallet;

  constructor(privacyNode: PrivacyNode, factory: ContractFactoryRef, standard: TokenStandards) {
    const randomHex = generateRandomHex(6);

    this.name = randomHex;
    this.symbol = randomHex;
    this.resourceId = randomHex;
    this.address = {};
    this.uri = '';
    this.factory = factory;
    this.standard = standard;
    this.privacyNode = privacyNode;
    this.userWallet = createUserOperator(privacyNode.provider);
  }

  async deployContract(cachedKey: string, tokenArgs: Parameters<any>): Promise<T> {
    const store = this.privacyNode.contractStore;
    const tokenFactory = await store.getFactory(this.factory, this.userWallet);
    LOGGER.info(`Deploying token with cache key ${cachedKey}`);
    this.contract = await store.deploy<T>(tokenFactory, cachedKey, ...tokenArgs);
    this.address[this.privacyNode.chainId] = await this.contract.getAddress();
    return this.contract;
  }

  /**
   * Resolves the token address on a target Privacy Ledger by polling the endpoint.
   * Short-circuits if already known (address never changes once deployed).
   */
  protected async resolveAddressOnPL(node: PrivacyNode): Promise<string> {
    if (this.address[node.chainId] && this.address[node.chainId] !== ZERO_ADDRESS)
      return this.address[node.chainId];

    await eventually<boolean>({
      check: async () => {
        const endpointPL = node.getContract<EndpointV1>('EndpointV1');
        const address = await endpointPL.getAddressByResourceId(this.resourceId);
        if (address === ZERO_ADDRESS) return false;

        const code = await node.provider.getCode(address);
        if (!code || code === '0x') return false;

        this.address[node.chainId] = address;
        return true;
      },
      // Eventual-consistency probe against a (possibly remote, VPN-routed) PL: a transient
      // RPC throw — request timeout, brief unavailability, indexer lag — means "not ready",
      // not a real failure, so retry instead of aborting the test. A genuinely missing token
      // still fails on poll exhaustion, with the last error surfaced in the diagnostic.
      tolerateErrors: true,
      message: `Resolving ${this.symbol} on chain ${node.chainId}`,
    });

    return this.address[node.chainId];
  }

  async getBalanceOf(...args: any[]): Promise<bigint> {
    return BigInt(await this.contract.balanceOf(...args));
  }

  protected async _callContractMint(
    ...mintArgs: unknown[]
  ): Promise<ContractTransactionReceipt> {
    // Owner-gated mint: the instance owner is the deployer (userWallet) on both the constructor-deploy
    // and deploy-as-user paths, so `this.contract` (bound to userWallet) is the minter.
    return submitTx(
      () => this.contract.mint(...mintArgs, { gasLimit: GAS_LIMIT }),
      `Minting ${this.symbol}`,
    );
  }

  async waitForBalance(expectedBalance: bigint, ...args: any[]): Promise<void> {
    LOGGER.info(`Waiting for balance ${expectedBalance} and args ${args}`);
    await eventually<boolean>({
      check: async () => {
        const balance = await this.getBalanceOf(...args);
        return balance === BigInt(expectedBalance);
      },
      message: `Waiting for ${this.symbol} PL balance → ${expectedBalance} for ${shortHex(args[0])}`,
    });
  }

  async setPublicContract<T extends BaseContract>(connector : PublicConnector) : Promise<T> {
    const tokenAddressInPC = await this.getPublicAddress();

      // Use the Public Chain provider, not the Privacy Ledger provider
      const pcProvider = getProvider(PUBLIC_CHAIN_RPC_URL);
      this.publicContract = connector.connect(
        tokenAddressInPC,
        pcProvider
      );

    return this.publicContract as T;
  }

  /**
   * PN-authorization leg (PNTokenRegistryV1 flow) — the shared prerequisite for BOTH activation
   * legs (`activateOnHub` / `activateOnPublicChain`), kept as an explicit, standalone step:
   *   registerToken(addr)            → privacyNodeStatus = WAITING_APPROVAL
   *   updatePrivacyNodeStatus(addr,2)→ privacyNodeStatus = AUTHORIZED
   * registerToken reads the token metadata on-chain (no name/symbol/uri args). Both facade
   * selectors are `restricted`: per the deployed role model (privacy-node.ts deploy task)
   * registerToken → TOKEN_CREATOR (held only by the contract factory — no EOA holds it) and
   * updatePrivacyNodeStatus → PN_TOKEN_REGISTRY_ADMIN (held by initialOwner). Both are reached
   * here via `adminWallet`, which holds ADMIN — RaylsAccessManager.canCall short-circuits true
   * for ADMIN regardless of the per-selector role map. registerToken records no msg.sender
   * (PNTokenCoreV1: no ownership capture), so the token's owner stays userWallet (deployer) and
   * mint via `this.contract` is unaffected.
   *
   * NOT idempotent (registerToken reverts `TokenCoreV1__TokenDoesNotExist`/duplicate on an
   * already-registered token): call exactly once, on the issuer node, on a freshly deployed token.
   * Do NOT call on a hub-callback-authorized receiver (e.g. node B in the private→public flow) —
   * that node is auto-AUTHORIZED by the hub `activateToken` callback; call `activateOnPublicChain()`
   * on it directly.
   */
  async activateOnPn(): Promise<void> {
    const addr = this.address[this.privacyNode.chainId];
    const registry = await this.privacyNode.getPnTokenRegistry(this.privacyNode.adminWallet);
    await submitTx(
      () => registry.registerToken(addr, { gasLimit: GAS_LIMIT }),
      `Registering ${this.symbol} on PN registry (${shortHex(addr)})...`,
    );
    await submitTx(
      () => registry.updatePrivacyNodeStatus(addr, 2 /* AUTHORIZED */, { gasLimit: GAS_LIMIT }),
      `Approving ${this.symbol} on PN → AUTHORIZED...`,
    );
  }

  /**
   * Hub-activation leg on PNTokenRegistryV1 (pure — does one thing). Requires
   * privacyNodeStatus == AUTHORIZED — call `activateOnPn()` first on the issuer (this leg
   * deliberately does NOT run it, so the PN step stays explicit at the call site):
   *   submitToHub(addr)                 → hubStatus = WAITING_APPROVAL, endpoint.send metadata to PNH
   *   PNH assigns resourceId (getTokenFromRegistry)
   *   privateHub.updateTokenStatus(rid) → operator approve → PNH callback activateToken(rid, addr)
   *   activateToken (PN)                → sets token.resourceId + hubStatus = AUTHORIZED
   * submitToHub is a PN_TOKEN_REGISTRY_ADMIN selector → sign as adminWallet (ADMIN bypass in canCall),
   * same as activateOnPn / submitToPublicChain. Subclasses override this to append PNH-contract
   * wiring after the resourceId is set (Enygma resourceId refresh, DvP ERC721/1155 PNH bind).
   */
  async activateOnHub(privateHub: PrivateHub): Promise<void> {
    const addr = this.address[this.privacyNode.chainId];
    const registry = await this.privacyNode.getPnTokenRegistry(this.privacyNode.adminWallet);
    await submitTx(
      () => registry.submitToHub(addr, { gasLimit: GAS_LIMIT }),
      `Submitting ${this.symbol} to hub (${shortHex(addr)})...`,
    );

    // PNH assigns the resourceId during addToken; read it back, then operator-approve on the hub.
    const tokenOnRegistry = await privateHub.getTokenFromRegistry(this.symbol);
    if (!tokenOnRegistry)
      throw new Error(`Hub activation: ${this.symbol} not on PNH registry after submitToHub`);
    this.resourceId = tokenOnRegistry.resourceId;
    await privateHub.updateTokenStatus(this.resourceId);

    // Relayer delivers activateToken → the PN token gets its resourceId (facade calls
    // setResourceId on the instance). This is the exact precondition token.contract.teleport()
    // needs (else "Token not registered").
    await eventually<boolean>({
      check: async () => (await this.contract.resourceId()) !== ZERO_HASH,
      tolerateErrors: true,
      message: `Waiting for ${this.symbol} hub activation (resourceId on PN, ${shortHex(addr)})`,
    });
  }

  /**
   * Public-chain activation, step 4: submitToPublicChain(addr) → publicChainStatus =
   * PENDING_DEPLOYMENT. Requires privacyNodeStatus == AUTHORIZED. Idempotent — no-op once
   * the token is already PENDING_DEPLOYMENT(1) or DEPLOYED(2). Signs as `adminWallet`
   * (PN_TOKEN_REGISTRY_ADMIN selector, reached via the ADMIN bypass in canCall).
   */
  async submitToPublicChain(): Promise<void> {
    const addr = this.address[this.privacyNode.chainId];
    const registry = await this.privacyNode.getPnTokenRegistry(this.privacyNode.adminWallet);
    if (Number(await registry.getPublicChainStatus(addr)) >= 1) return;
    await submitTx(
      () => registry.submitToPublicChain(addr, { gasLimit: GAS_LIMIT }),
      `Submitting ${this.symbol} to public chain (${shortHex(addr)})...`,
    );
  }

  /**
   * Public-chain-activation leg (pure): submitToPublicChain → wait for the relayer to deploy the
   * public token (publicChainStatus == DEPLOYED) → wait for it to become AUTHORIZED_SENDER on the
   * public endpoint. Requires privacyNodeStatus == AUTHORIZED — on the issuer, call `activateOnPn()`
   * first (this leg keeps the PN step explicit, mirroring `activateOnHub`); on a hub-callback-
   * authorized receiver (node B) call this standalone (do NOT call `activateOnPn()` there — the
   * token is already registered). Returns the public token address.
   */
  async activateOnPublicChain(): Promise<string> {
    await this.submitToPublicChain();
    const publicAddress = await this.getPublicAddress();
    await this.waitForPublicTokenAuthorized(publicAddress);
    return publicAddress;
  }

  /**
   * Resolves the token's public-chain address from the PN registry. Waits until the relayer
   * has deployed the public token (publicChainStatus == DEPLOYED(2)) and recorded a non-zero
   * publicTokenAddress via updatePublicTokenAddress.
   */
  async getPublicAddress(): Promise<string> {
    const addr = this.address[this.privacyNode.chainId];
    const registry = await this.privacyNode.getPnTokenRegistry();
    return eventually<string>({
      check: async () => {
        if (Number(await registry.getPublicChainStatus(addr)) !== 2 /* DEPLOYED */) return undefined;
        const pub = (await registry.getTokenByAddress(addr)).publicTokenAddress;
        return pub && pub !== ZERO_ADDRESS ? pub : undefined;
      },
      interval: 3000,
      attempts: 40,
      tolerateErrors: true,
      message: `Waiting for ${this.symbol} public token DEPLOYED (${shortHex(addr)})`,
    });
  }

  /**
   * Blocks until the deployed public token is AUTHORIZED to call the public Endpoint's
   * sendToAddress (the AUTHORIZED_SENDER role). The relayer publishes the private->public
   * address mapping (which getPublicAddress() waits on) BEFORE it grants this role
   * (public-relayer/service/deployer.go: UpdatePublicTokenAddress then
   * GrantAuthorizedSenderRole), so a public->private teleport issued right after
   * getPublicAddress() races the grant and reverts with RaylsAccessManaged__Unauthorized
   * (0xbb34f40c). canCall is a read-only gate that needs no public-chain token balance, so
   * it is safe to poll in `before` before the user holds any public tokens.
   */
  async waitForPublicTokenAuthorized(publicTokenAddr?: string): Promise<void> {
    // Reuse the caller's already-resolved address when provided (the suites resolve it once in
    // before()); only fall back to the retry-backed lookup when called standalone.
    const tokenAddr = publicTokenAddr ?? (await this.getPublicAddress());
    const pcProvider = getProvider(PUBLIC_CHAIN_RPC_URL);

    // Endpoint + AccessManager are derived from the token itself — no extra config needed.
    const tokenApp = RaylsPublicApp__factory.connect(tokenAddr, pcProvider);

    // The access-gated Endpoint function the public token calls inside teleportToPrivacyNode.
    // Derived from the ABI so it can't drift from the contract's actual selector. Pure (no RPC),
    // so it stays outside the loop.
    const sendToAddressSelector = PublicRNEndpointV1__factory
      .createInterface()
      .getFunction('sendToAddress').selector;

    await eventually<boolean>({
      check: async () => {
        // Resolve endpoint + access manager inside the loop so a transient RPC blip on these
        // reads is treated as "not ready yet" (tolerateErrors) instead of aborting before() —
        // the same failure class this guard exists to fix. Both are immutable view calls, so
        // re-reading per attempt is cheap and the happy path resolves on the first iteration.
        const [endpointAddr, accessManagerAddr] = await Promise.all([
          tokenApp.getPublicRaylsNodeEndpoint(),
          tokenApp.authority(),
        ]);
        const accessManager = RaylsAccessManagerV1__factory.connect(accessManagerAddr, pcProvider);
        const [allowed] = await accessManager.canCall(
          tokenAddr,
          endpointAddr,
          sendToAddressSelector,
        );
        return allowed || undefined; // eventually() retries on falsy
      },
      interval: 2000,
      attempts: 45,
      tolerateErrors: true,
      message: `Waiting for public token ${shortHex(tokenAddr)} to become AUTHORIZED_SENDER on the public endpoint`,
    });
  }

  async verifyPublicBalance(expectedBalance: bigint, ...args: any[]): Promise<void> {
    const tokenAddressInPC = await this.getPublicAddress();
    const publicBal: bigint = await eventually({
      check: async () => this.publicContract.balanceOf(...args),
      interval: 3000,
      attempts: 30,
      message: `Waiting for ${this.symbol} public balance → ${expectedBalance}` +
      ` (token=${shortHex(tokenAddressInPC)})`,
    });
    expect(publicBal).to.be.eq(expectedBalance);
  }

  async verifyTokenExistsInGovernance(privacyNode: PrivacyNode, tokenAddressInPL: string): Promise<void> {
    const registry = await privacyNode.getPnTokenRegistry();

    const isFound = await eventually<boolean>({
      check: async () => registry.tokenExists(tokenAddressInPL),
      interval: 15000,
      attempts: 2000,
      message: `Waiting for token ${shortHex(tokenAddressInPL)} registered on PN registry (chain=${privacyNode.chainId})`,
    });
    LOGGER.log(`[DEBUG] Token exists on PN registry: ${isFound}`);
  }

  /**
   * Resolve + connect the PN's `RNContractFactoryV1` for a `deploy*AsUser` call. Shared by the
   * per-standard `deployViaFactory` methods (Enygma / ERC20) — the only per-standard
   * difference is which `deploy*AsUser` entry they invoke on the returned factory.
   */
  protected async getRnFactory(signer: ethers.Signer): Promise<RNContractFactoryV1> {
    const factoryAddr = await this.privacyNode.resolveFromRegistry('RNContractFactory');
    return RNContractFactoryV1__factory.connect(factoryAddr, signer);
  }

  /**
   * Wire this wrapper to a freshly `deploy*AsUser`-deployed instance: pull the address from the
   * factory's `RegisteredContractDeployed(key, deployedAddress, resourceId)` event, record it, and
   * connect `this.contract` with `signer` (the deploy signer, which is the instance TOKEN_OWNER via
   * the factory's `_pendingOwnerOverride`). NOTE the event field is `deployedAddress` (not `deployed`).
   */
  protected async connectFactoryDeployed(
    receipt: ContractTransactionReceipt,
    rnFactory: RNContractFactoryV1,
    signer: ethers.Signer,
  ): Promise<T> {
    const deployed = receipt.logs
      .map(l => { try { return rnFactory.interface.parseLog(l); } catch { return null; } })
      .find(p => p?.name === 'RegisteredContractDeployed')?.args?.deployedAddress as string | undefined;
    if (!deployed)
      throw new Error(`deploy*AsUser: RegisteredContractDeployed not emitted for ${this.symbol}`);

    this.address[this.privacyNode.chainId] = deployed;
    this.contract = await this.privacyNode.contractStore.connectAt(
      this.factory.name, deployed, this.symbol, signer,
    );
    return this.contract;
  }

  /**
   * Returns a new wrapper instance pointed at a different Privacy Ledger.
   * Shares identity (name, symbol, resourceId, address map) but resolves
   * the contract on the target node using this wrapper's userWallet.
   * Original wrapper is not mutated.
   *
   * If the address on the target node isn't known yet, pass `resolve = true`
   * to polling the endpoint until it's deployed.
   */
  async forNode(
    node: PrivacyNode,
    resolve: boolean = false,
    signer?: ethers.HDNodeWallet | ethers.Wallet,
  ): Promise<this> {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this)),
      this,
    );
    clone.privacyNode = node;
    clone.address = { ...this.address };
    clone.userWallet = signer
      ? signer.connect(node.provider)
      : this.userWallet.connect(node.provider);
    if (resolve) await clone.resolveAddressOnPL(node);
    clone.contract = await node.contractStore.connectAt(
      this.factory.name,
      clone.address[node.chainId],
      this.symbol,
      clone.userWallet,
    );
    return clone;
  }

  async depositNftToDvp(privateHub: PrivateHub, ...args: any[]): Promise<ContractTransactionReceipt> {
    const receipt = await submitTx(() => this.contract.depositIntoDvp(...args), `Depositing NFT ${this.symbol} to Dvp`);
    return receipt
  }

  async withdrawNftFromDvp(privateHub: PrivateHub, ...withdrawArgs: any[]): Promise<ContractTransactionReceipt> {
    const receipt = await submitTx(() => this.contract.withdrawFromDvp(...withdrawArgs), `Withdrawing NFT from Dvp`);
    return receipt
  }

  log() {
    LOGGER.data(`${this.name} ${this.symbol} ${this.resourceId} ${this.address[this.privacyNode.chainId]}`);
  }

  setFields(suffix: string): this {
    const suf = suffix.replace(/\s+/g, '-').slice(0, 16);
    this.name = `${this.name}-${suf}`;
    this.symbol = `${this.symbol}-${suf}`;
    this.uri = `$uri://${generateRandomHex(6)}.${suf}`;
    return this;
  }
}