import { BaseContract, ContractFactory, HDNodeWallet, JsonRpcProvider, parseEther, Signer, Wallet } from 'ethers';
import { queryOne } from '../utils/pg-client';

// TypeChain types and factories
import {
  DeploymentProxyRegistryV1__factory,
  EndpointV1,
  EndpointV1__factory,
  PNCommunicatorV1,
  PNCommunicatorV1__factory,
  PNTokenFreezeManagerV1,
  PNTokenFreezeManagerV1__factory,
  PNTokenRegistryV1,
  PNTokenRegistryV1__factory,
  RaylsAccessManagerV1,
  RaylsAccessManagerV1__factory,
  RNUserGovernanceV1,
  RNUserGovernanceV1__factory,
} from '../../typechain-types';
import {
  CHAIN_ID,
  DEPLOYMENT_PROXY_REGISTRY_ADDRESS,
  ENDPOINT_ADDRESS,
  LOGGER,
  DB_CONNECTION,
  PROVIDER,
  RAYLS_NODE_ENDPOINT_ADDRESS,
  RAYLS_NODE_TOKEN_GOVERNANCE,
  RAYLS_NODE_USER_GOVERNANCE,
  RPC_URL,
  ZERO_ADDRESS,
} from '../config/env-config';
import { eventually, retry, sendTx } from '../utils/common';
import { isNonceError, isTransientRpcError } from '../exceptions-and-errors/block-chain-exceptions';
import {
  adminWallet,
  bankEmployeeWallet,
  createUserOperator,
  operatorWallet,
  userWallet,
} from '../utils/wallet-factory';
import { ContractStore } from './ContractStore';
import { formatFactoryName, shortHex } from '../utils/formatters';

export class PrivacyNode {
  private static instances = new Map<string, PrivacyNode>();

  public rpcUrl: string;
  public provider: JsonRpcProvider;
  public endpointAddress: string;
  public raylsNodeEndpointAddress: string;
  public raylsNodeUserGovernance: string;
  public raylsNodeTokenGovernance: string;
  public deploymentProxyRegistryAddress: string;
  public chainId: string;
  public adminWallet: HDNodeWallet | Wallet;
  public userWallet: HDNodeWallet | Wallet;
  /** Wallet with PRIVACY_NODE_OPERATOR role — used for runtime operator actions (user governance, token approval). */
  public operatorWallet: HDNodeWallet | Wallet;
  /** Wallet with BANK_EMPLOYEE role — day-to-day operations (addToken, addAddressPair). */
  public bankEmployeeWallet: HDNodeWallet | Wallet;
  public db: {
    connection: string;
  };
  public node: string;
  public contractStore: ContractStore;

  protected constructor(node: string) {
    this.rpcUrl = RPC_URL[node];
    this.provider = PROVIDER[node];
    this.endpointAddress = ENDPOINT_ADDRESS[node];
    this.raylsNodeEndpointAddress = RAYLS_NODE_ENDPOINT_ADDRESS[node];
    this.raylsNodeUserGovernance = RAYLS_NODE_USER_GOVERNANCE[node];
    this.raylsNodeTokenGovernance = RAYLS_NODE_TOKEN_GOVERNANCE[node];
    this.deploymentProxyRegistryAddress = DEPLOYMENT_PROXY_REGISTRY_ADDRESS[node];
    this.chainId = CHAIN_ID[node];
    this.adminWallet = adminWallet(this.provider);
    this.userWallet = userWallet(this.provider);
    this.operatorWallet = operatorWallet(this.provider);
    this.bankEmployeeWallet = bankEmployeeWallet(this.provider);
    this.db = {
      connection: DB_CONNECTION[node]
    };
    this.node = node;
    this.contractStore = new ContractStore();
  }

  static async getInstance(node: string): Promise<PrivacyNode> {
    if (!PrivacyNode.instances.has(node)) {
      const instance = new PrivacyNode(node);
      await instance.initialize();
      PrivacyNode.instances.set(node, instance);
    }
    return PrivacyNode.instances.get(node)!;
  }

  async initialize(): Promise<void> {
    this.endpointAddress = await this.getEndpointAddress();
    await this.getContractAt(EndpointV1__factory.name, this.endpointAddress, 'EndpointV1');
    this.raylsNodeEndpointAddress = await this.resolveFromRegistry('RNEndpoint');
  }

  async getEndpointAddress(): Promise<string> {
    return await this.resolveFromRegistry('Endpoint');
  }

  /**
   * Resolves a contract address registered in this PN's DeploymentProxyRegistry.
   * Throws if the registry has no entry for `name`, or if the registered address
   * has no code (catches env misconfiguration early instead of producing confusing
   * downstream failures).
   *
   * Common registered names: 'Endpoint', 'RNEndpoint', 'RaylsAccessManager',
   * 'ContractFactory' (RaylsContractFactoryV1), 'RNContractFactory' (RNContractFactoryV1).
   */
  async resolveFromRegistry(name: string): Promise<string> {
    if (!this.deploymentProxyRegistryAddress) {
      throw new Error(`Deployment proxy registry is not set in the .env file`);
    }
    const deploymentProxyRegistry = DeploymentProxyRegistryV1__factory.connect(
      this.deploymentProxyRegistryAddress,
      this.userWallet,
    );
    const address = await deploymentProxyRegistry.getContract(name);
    if (!address || address === ZERO_ADDRESS) {
      throw new Error(`Contract '${name}' not registered in DeploymentProxyRegistry on PN ${this.node}`);
    }
    const code = await retry(
      () => this.provider.getCode(address),
      {
        attempts: 5,
        delayMs: 300,
        retryIf: isTransientRpcError,
        onRetry: (_e, i) => LOGGER.log(`[RPC RETRY] getCode for ${name} on PN ${this.node} (attempt ${i}/5)`),
      },
    );
    if (!code || code === '0x') {
      throw new Error(`No code at address ${address} (registered as '${name}' on PN ${this.node})`);
    }
    return address;
  }

  getEndpointV1() {
    return this.getContract<EndpointV1>('EndpointV1');
  }

  async getUserGovernance(): Promise<RNUserGovernanceV1> {
    return await this.getContractAt<RNUserGovernanceV1>(
      RNUserGovernanceV1__factory.name,
      this.raylsNodeUserGovernance,
      'RNUserGovernanceV1',
      this.operatorWallet,
    );
  }

  /**
   * PN-side token registry (PNTokenRegistryV1 UUPS facade over TokenCore + FreezeManager).
   * Address resolved via the endpoint. Pass `signer` to bind role-specific handles
   * (TOKEN_CREATOR for registerToken, PN_TOKEN_REGISTRY_ADMIN for status/submit);
   * getContractAt signer-scopes the cache key so creator vs admin handles coexist.
   */
  async getPnTokenRegistry(signer?: Signer): Promise<PNTokenRegistryV1> {
    const tokenRegistryAddress = await this.getEndpointV1().getTokenRegistry();
    return await this.getContractAt<PNTokenRegistryV1>(
      PNTokenRegistryV1__factory.name,
      tokenRegistryAddress,
      'PNTokenRegistryV1',
      signer,
    );
  }

  /**
   * PN-side freeze manager (PNTokenFreezeManagerV1) — the module behind the registry facade that
   * carries the per-participant frozen map and the TokenFreezeManagerV1__TokenFrozenForParticipant
   * revert (the token/facade ABIs do NOT carry it). Address resolved off the registry's
   * getTokenFreezeManager(). Pass `signer` (adminWallet) to read the `restricted`
   * getFrozenTokenForParticipant getter (ADMIN bypass in canCall).
   */
  async getPnTokenFreezeManager(signer?: Signer): Promise<PNTokenFreezeManagerV1> {
    const registry = await this.getPnTokenRegistry(signer);
    const freezeManagerAddress = await registry.getTokenFreezeManager();
    return await this.getContractAt<PNTokenFreezeManagerV1>(
      PNTokenFreezeManagerV1__factory.name,
      freezeManagerAddress,
      'PNTokenFreezeManagerV1',
      signer,
    );
  }

   async getPnCommunicatorForToken(tokenKey: string): Promise<PNCommunicatorV1> {
    // tokenKey should be the symbol-based key used in PrivacyNode (e.g., enygma.symbol or nft.symbol)
    const tokenContract: any = this.getContract<any>(tokenKey);
    const communicatorAddress: string = await tokenContract.getPNCommunicatorAddress();
    // Fallback key to avoid clashes in PrivacyNode cache
    const cacheKey = `${tokenKey}_PNCommunicatorV1`;
    return await this.getContractAt<PNCommunicatorV1>(PNCommunicatorV1__factory.name, communicatorAddress, cacheKey);
  }

    async getEnygmaByResourceId(resourceId: string): Promise<any> {
        const resourceIdWithout0x = resourceId.substring(2);
        return await queryOne(
            this.db.connection,
            'SELECT * FROM enygma WHERE resource_id = $1 LIMIT 1',
            [resourceIdWithout0x]
        );
    }

  async getContractFactory<T extends ContractFactory>(factory: { name: string }): Promise<T> {
    return await this.contractStore.getFactory<T>(factory, this.userWallet);
  }

  getContract<T extends BaseContract>(key: string): T {
    return this.contractStore.get<T>(key);
  }

  async getAccessManager(): Promise<RaylsAccessManagerV1> {
    const managerAddress = await this.resolveFromRegistry('RaylsAccessManager');
    return RaylsAccessManagerV1__factory.connect(managerAddress, this.userWallet);
  }

  /**
   * Grants ENDPOINT_SENDER to the given addresses via the AccessManager.
   * Used only for RaylsApp contracts (ArbitraryMessage, BatchTransfer) that are
   * deployed directly (not through the factory) and need ENDPOINT_SENDER before
   * their constructor calls endpoint.send().
   * The adminWallet holds ADMIN which can grant any role.
   */
  async grantEndpointSender(tokenAddresses: string[]) {
    const manager = await this.getAccessManager();
    const endpointSenderRoleId = await manager.getRoleIdByName('ENDPOINT_SENDER');
    const managerAsAdmin = manager.connect(this.adminWallet) as typeof manager;
    for (const addr of tokenAddresses) {
      const [hasRole] = await manager.hasRole(endpointSenderRoleId, addr);
      if (hasRole) continue;
      const tx = await managerAsAdmin.grantRole(endpointSenderRoleId, addr, 0);
      await tx.wait();
    }
    LOGGER.success(`Granted ENDPOINT_SENDER to ${tokenAddresses.join(', ')}`);
  }

  /**
   * Grants RESOURCE_REGISTRAR role to the given addresses so they can call
   * endpoint.registerResourceId(). Used for RaylsApp contracts that register
   * their own resource ID during construction.
   */
  async grantResourceRegistrar(addresses: string[]) {
    const manager = await this.getAccessManager();
    const roleId = await manager.getRoleIdByName('RESOURCE_REGISTRAR');
    const managerAsAdmin = manager.connect(this.adminWallet) as typeof manager;
    for (const addr of addresses) {
      const [hasRole] = await manager.hasRole(roleId, addr);
      if (hasRole) continue;
      const tx = await managerAsAdmin.grantRole(roleId, addr, 0);
      await tx.wait();
    }
    LOGGER.success(`Granted RESOURCE_REGISTRAR to ${addresses.join(', ')}`);
  }

  /**
   * Grants the PRIVACY_NODE_OPERATOR role to this node's operatorWallet.
   * PRIVACY_NODE_OPERATOR's admin is ADMIN — requires adminWallet.
   */
  async grantOperatorRole(): Promise<void> {
    const manager = await this.getAccessManager();
    const operatorRoleId = await manager.getRoleIdByName('PRIVACY_NODE_OPERATOR');
    const [hasRole] = await manager.hasRole(operatorRoleId, this.operatorWallet.address);
    if (hasRole) return;
    await sendTx(
      () => (manager.connect(this.adminWallet) as typeof manager)
        .grantRole(operatorRoleId, this.operatorWallet.address, 0),
      'grantOperatorRole',
    );
    LOGGER.success(`Granted PRIVACY_NODE_OPERATOR to operatorWallet ${this.operatorWallet.address}`);
  }

  /**
   * Creates a fresh HD wallet, funds it with 1 ETH from adminWallet (so it can pay
   * gas), and grants it `roleName` on this PN's AccessManager. Returns the wallet.
   *
   * Used by tests that need to exercise a privileged surface as a freshly-credentialed
   * actor — the caller doesn't have to pre-fund or grant by hand.
   *
   * `granter` defaults to adminWallet (which can grant any role whose admin is ADMIN).
   * Roles whose admin is something else (e.g. BANK_EMPLOYEE's admin is
   * PRIVACY_NODE_OPERATOR) require passing the appropriate granter explicitly.
   */
  async makeRoleHolder(
    roleName: string,
    granter: Signer = this.adminWallet,
  ): Promise<HDNodeWallet> {
    const wallet = createUserOperator(this.provider);

    await retry(
      async () => {
        const tx = await this.adminWallet.sendTransaction({
          to: wallet.address,
          value: parseEther('1'),
        });
        await tx.wait();
      },
      {
        attempts: 5,
        delayMs: 500,
        retryIf: (err) => isNonceError(err) || isTransientRpcError(err),
        onRetry: (_err, i) => LOGGER.log(`[TX RETRY] makeRoleHolder funding attempt ${i}/5`),
      },
    );

    const manager = await this.getAccessManager();
    const roleId = await manager.getRoleIdByName(roleName);
    await sendTx(
      () => (manager.connect(granter) as typeof manager)
        .grantRole(roleId, wallet.address, 0),
      `makeRoleHolder grantRole ${roleName}`,
    );

    return wallet;
  }

  /**
   * Grants the BANK_EMPLOYEE role to this node's bankEmployeeWallet.
   * BANK_EMPLOYEE's admin is PRIVACY_NODE_OPERATOR — uses operatorWallet (not admin).
   */
  async grantBankEmployeeRole(): Promise<void> {
    const manager = await this.getAccessManager();
    const roleId = await manager.getRoleIdByName('BANK_EMPLOYEE');
    const [hasRole] = await manager.hasRole(roleId, this.bankEmployeeWallet.address);
    if (hasRole) return;
    await sendTx(
      () => (manager.connect(this.operatorWallet) as typeof manager)
        .grantRole(roleId, this.bankEmployeeWallet.address, 0),
      'grantBankEmployeeRole',
    );
    LOGGER.success(`Granted BANK_EMPLOYEE to bankEmployeeWallet ${this.bankEmployeeWallet.address}`);
  }

  async setContractByResourceId<T extends BaseContract>(
    factoryName: string,
    resourceId: string,
    cacheKey: string,
    signer: Signer,
  ): Promise<T> {
    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const tokenBAddress = await this.getEndpointV1().getAddressByResourceId(resourceId);
        if (tokenBAddress === ZERO_ADDRESS) return false;

        await this.contractStore.connectAt(factoryName, tokenBAddress, cacheKey, signer);
        return true;
      },
      interval: 1000,
      attempts: 300,
      message: `Resolving rid=${shortHex(resourceId)} (factory=${factoryName}, chain=${this.chainId})`,
    });
    return this.contractStore.get<T>(cacheKey);
  }

  async getContractAt<T extends BaseContract>(
    factoryName: string,
    address: string,
    key: string,
    signer?: Signer,
  ): Promise<T> {
    const effectiveSigner = signer ?? this.userWallet;
    // Key policy lives here (only the node knows userWallet is the default signer):
    // an explicit signer caches under a signer-scoped key so role-specific bindings
    // coexist (e.g. TokenRegistry as operator vs compliance vs the userWallet entry
    // read back by getContract()); the default binds to userWallet under the plain
    // key. The connect + cache mechanics are owned by ContractStore.
    const cacheKey = signer
      ? `${formatFactoryName(key)}_${await signer.getAddress()}`
      : formatFactoryName(key);

    return this.contractStore.connectAt<T>(factoryName, address, cacheKey, effectiveSigner);
  }

  async deploy<T extends BaseContract>(
    contractFactory: ContractFactory,
    key: string,
    ...args: Parameters<typeof contractFactory.deploy>
  ): Promise<T> {
    // Deploy mechanics (nonce-retry, success log, caching) live in ContractStore;
    // the node owns the store, so delegate rather than duplicate the loop.
    return this.contractStore.deploy<T>(contractFactory, key, ...args);
  }
}