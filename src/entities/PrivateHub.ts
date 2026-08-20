import { BaseContract, ContractTransactionReceipt, ContractTransactionResponse, ethers } from 'ethers';
import { PrivacyNode } from './PrivacyNode';
import { expect } from 'chai';
import {
  DEFAULT_TIMEOUT,
  GAS_LIMIT,
  LOGGER,
  SECOND,
  ZERO_ADDRESS,
  ZERO_HASH,
} from '../config/env-config';
import {
  DeploymentProxyRegistryV1__factory,
  EndpointV1__factory,
  EnygmaPNEvents__factory,
  ParticipantStorageV1,
  ParticipantStorageV1__factory,
  PNCommunicatorV1,
  Proofs__factory,
  ResourceRegistryV1__factory,
  TeleportV1,
  TeleportV1__factory,
  TokenCoreV1__factory,
  TokenRegistryV1,
  TokenRegistryV1__factory,
  Dvp__factory,
  DvpTeleport,
  DvpTeleport__factory,
} from '../../typechain-types';
import { eventually, submitTx } from '../utils/common';
import { shortHex } from '../utils/formatters';
import { complianceWallet } from '../utils/wallet-factory';
import TokenStructOutput = TokenStructs.TokenStructOutput;
import { TokenStructs } from '../../typechain-types/contracts/remote/privateHub/TokenRegistry/TokenRegistryV1';

// PNH contract wiring — `getProxyRegistryDeployment()` iterates this to connect every
// contract uniformly. New PNH contract = new row here + new address field on the class.
// Special-cased (NOT here): EnygmaPNEvents (legacy alias EnygmaCCEvents, optional).
type PnhAddressField =
  | 'resourceRegistryAddress' | 'teleportAddress' | 'endpointAddress'
  | 'tokenRegistryAddress' | 'tokenCoreAddress' | 'proofsAddress'
  | 'participantStorageAddress' | 'dvpAddress' | 'dvpTeleportAddress';

const PNH_CONTRACT_WIRING: ReadonlyArray<{ name: string; factory: { name: string }; cacheKey: string; addressField: PnhAddressField }> = [
  { name: 'ResourceRegistry',   factory: ResourceRegistryV1__factory,   cacheKey: 'ResourceRegistryV1',   addressField: 'resourceRegistryAddress' },
  { name: 'Teleport',           factory: TeleportV1__factory,           cacheKey: 'TeleportV1',           addressField: 'teleportAddress' },
  { name: 'Endpoint',           factory: EndpointV1__factory,           cacheKey: 'EndpointV1',           addressField: 'endpointAddress' },
  { name: 'TokenRegistry',      factory: TokenRegistryV1__factory,      cacheKey: 'TokenRegistryV1',      addressField: 'tokenRegistryAddress' },
  { name: 'TokenCore',          factory: TokenCoreV1__factory,          cacheKey: 'TokenCoreV1',          addressField: 'tokenCoreAddress' },
  { name: 'Proofs',             factory: Proofs__factory,               cacheKey: 'Proofs',               addressField: 'proofsAddress' },
  { name: 'ParticipantStorage', factory: ParticipantStorageV1__factory, cacheKey: 'ParticipantStorageV1', addressField: 'participantStorageAddress' },
  { name: 'Dvp',                factory: Dvp__factory,                  cacheKey: 'Dvp',                  addressField: 'dvpAddress' },
  { name: 'DvpTeleport',        factory: DvpTeleport__factory,          cacheKey: 'DvpTeleport',          addressField: 'dvpTeleportAddress' },
];

export class PrivateHub extends PrivacyNode {
  private static instance: PrivateHub | null = null;

  public deployNamesAndAddresses: { [key: string]: string } = {};

  // Addresses default to ZERO_ADDRESS and are populated by getProxyRegistryDeployment().
  // The set of address fields here must stay in sync with PNH_CONTRACT_WIRING + the
  // special-cased enygmaPNEventsAddress below.
  public resourceRegistryAddress: string = ZERO_ADDRESS;
  public teleportAddress: string = ZERO_ADDRESS;
  public endpointAddress: string = ZERO_ADDRESS;
  public tokenRegistryAddress: string = ZERO_ADDRESS;
  public tokenCoreAddress: string = ZERO_ADDRESS;
  public proofsAddress: string = ZERO_ADDRESS;
  public participantStorageAddress: string = ZERO_ADDRESS;
  public dvpAddress: string = ZERO_ADDRESS;
  public dvpTeleportAddress: string = ZERO_ADDRESS;
  public enygmaPNEventsAddress: string = ZERO_ADDRESS;

  /** Wallet with COMPLIANCE_OFFICER role — used for freeze/unfreeze operations. */
  public complianceWallet: ethers.HDNodeWallet | ethers.Wallet;

  private constructor() {
    super('PNH');
    // PNH needs a COMPLIANCE_OFFICER wallet on top of the base PrivacyNode set
    // (admin / user / operator / bankEmployee inherited from super). bankEmployee
    // is unused on PNH but kept inherited for type compatibility — no extra picks.
    this.complianceWallet = complianceWallet(this.provider);
  }

  async initialize(): Promise<void> {
    await this.getProxyRegistryDeployment();
  }

  static async getInstance(_node?: string): Promise<PrivateHub> {
    if (!PrivateHub.instance) {
      const cc = new PrivateHub();
      await cc.initialize();
      PrivateHub.instance = cc;
    }
    return PrivateHub.instance;
  }
  /** Lazily resolves PNH contract addresses + connects typed instances. Idempotent — caches `deployNamesAndAddresses`. */
  async getProxyRegistryDeployment(): Promise<{ [key: string]: string }> {
    if (Object.keys(this.deployNamesAndAddresses).length > 0) return this.deployNamesAndAddresses;

    const deploymentProxyRegistryAddress = this.deploymentProxyRegistryAddress;
    const deploymentProxyRegistry = DeploymentProxyRegistryV1__factory.connect(
      deploymentProxyRegistryAddress,
      this.userWallet
    );

    const deployment = await deploymentProxyRegistry.getAllContracts();

    this.deployNamesAndAddresses = deployment.names.reduce(
      (acc, name, index) => {
        acc[name] = deployment.addresses[index];
        return acc;
      },
      {} as { [key: string]: string }
    );

    // Wire every contract from the PNH_CONTRACT_WIRING table — connect via ContractStore + mirror address.
    for (const { name, factory, cacheKey, addressField } of PNH_CONTRACT_WIRING) {
      const address = this.deployNamesAndAddresses[name];
      await this.getContractAt(factory.name, address, cacheKey);
      this[addressField] = address;
    }

    // Special case: Enygma events. Name may be either 'EnygmaPNEvents' (new) or
    // 'EnygmaCCEvents' (legacy upstream alias). Wire only if present.
    const enygmaEventsAddress = this.deployNamesAndAddresses['EnygmaPNEvents']
      ?? this.deployNamesAndAddresses['EnygmaCCEvents'];
    if (enygmaEventsAddress) {
      await this.getContractAt(EnygmaPNEvents__factory.name, enygmaEventsAddress, 'EnygmaPNEvents');
      this.enygmaPNEventsAddress = enygmaEventsAddress;
    }

    return this.deployNamesAndAddresses;
  }

  async getTokenFromRegistry(tokenSymbol: string): Promise<TokenStructOutput | undefined> {
    let tokenOnPNH: TokenStructOutput | undefined;
    const tokenRegistry = this.getContract<TokenRegistryV1>('TokenRegistryV1');
    await eventually<boolean>({
      check: async () => {
        const allTokens = await tokenRegistry.getAllTokens();
        tokenOnPNH = allTokens.find((x: TokenStructOutput) => x.symbol === tokenSymbol);
        return !!tokenOnPNH;
      },
      message: `Waiting for token ${tokenSymbol} on PNH registry`,
    });

    return tokenOnPNH;
  }

  /**
   * Grants PRIVATE_NETWORK_OPERATOR to this hub's operatorWallet.
   * PRIVATE_NETWORK_OPERATOR's admin is ADMIN — requires adminWallet.
   */
  async grantNetworkOperatorRole(): Promise<void> {
    const manager = await this.getAccessManager();
    const networkOperatorRoleId = await manager.getRoleIdByName('PRIVATE_NETWORK_OPERATOR');
    const [hasRole] = await manager.hasRole(networkOperatorRoleId, this.operatorWallet.address);
    if (!hasRole) {
      await submitTx(
        () => (manager.connect(this.adminWallet) as typeof manager)
          .grantRole(networkOperatorRoleId, this.operatorWallet.address, 0),
        `Granting PRIVATE_NETWORK_OPERATOR to ${this.operatorWallet.address}`,
      );
      LOGGER.success(`Granted PRIVATE_NETWORK_OPERATOR to operatorWallet ${this.operatorWallet.address}`);
    }
  }

  /**
   * Grants COMPLIANCE_OFFICER to this hub's complianceWallet and maps
   * freezeToken / unfreezeToken selectors on the TokenRegistry to that role.
   * COMPLIANCE_OFFICER's admin is PRIVATE_NETWORK_OPERATOR — uses operatorWallet (not admin).
   */
  async grantComplianceRole(): Promise<void> {
    const manager = await this.getAccessManager();
    const complianceRoleId = await manager.getRoleIdByName('COMPLIANCE_OFFICER');
    const [hasRole] = await manager.hasRole(complianceRoleId, this.complianceWallet.address);
    if (!hasRole) {
      await submitTx(
        () => (manager.connect(this.operatorWallet) as typeof manager)
          .grantRole(complianceRoleId, this.complianceWallet.address, 0),
        `Granting COMPLIANCE_OFFICER to ${this.complianceWallet.address}`,
      );
      LOGGER.success(`Granted COMPLIANCE_OFFICER to complianceWallet ${this.complianceWallet.address}`);
    }

    // Map freezeToken / unfreezeToken selectors to COMPLIANCE_OFFICER on TokenRegistry
    if (this.tokenRegistryAddress && this.tokenRegistryAddress !== ZERO_ADDRESS) {
      const trIface = TokenRegistryV1__factory.createInterface();
      const freezeSel = trIface.getFunction('freezeToken')!.selector;
      const unfreezeSel = trIface.getFunction('unfreezeToken')!.selector;
      const managerAsAdmin = manager.connect(this.adminWallet) as typeof manager;
      await submitTx(
        () => managerAsAdmin.addFunctionAllowedRoles(
          this.tokenRegistryAddress,
          [freezeSel, unfreezeSel],
          [complianceRoleId],
        ),
        `Mapping freezeToken/unfreezeToken → COMPLIANCE_OFFICER on TokenRegistry`,
      );
      LOGGER.success(`Mapped freezeToken/unfreezeToken → COMPLIANCE_OFFICER on TokenRegistry`);
    }
  }

  async getTokenRegistryAsOperator(): Promise<TokenRegistryV1> {
    return this.getContractAt<TokenRegistryV1>(
      TokenRegistryV1__factory.name,
      this.tokenRegistryAddress,
      'TokenRegistryV1',
      this.operatorWallet,
    );
  }

  async getTokenRegistryAsCompliance(): Promise<TokenRegistryV1> {
    return this.getContractAt<TokenRegistryV1>(
      TokenRegistryV1__factory.name,
      this.tokenRegistryAddress,
      'TokenRegistryV1',
      this.complianceWallet,
    );
  }

  async updateTokenStatus(resourceId: string, status: number = 1) {
    const tokenRegistry = await this.getTokenRegistryAsOperator();

    const token = await tokenRegistry.getTokenByResourceId(resourceId);
    if (Number(token.status) === status) {
      LOGGER.log(`Token ${resourceId} already has status ${status} — skipping updateTokenStatus`);
      return;
    }

    await submitTx(() => tokenRegistry.updateStatus(resourceId, status, { gasLimit: GAS_LIMIT }), `Updating status...`);
  }

  async updateParticipantStatus(chainId: string, status: bigint): Promise<void> {
    const ps = await this.getContractAt<ParticipantStorageV1>(
      ParticipantStorageV1__factory.name,
      this.participantStorageAddress,
      'ParticipantStorageV1',
      this.operatorWallet,
    );
    await submitTx(
      () => ps.updateStatus(chainId, status, { gasLimit: GAS_LIMIT }),
      `Updating participant ${chainId} status to ${status}...`,
    );
  }

  getPNHContract<T extends BaseContract>(key: string): T {
    return this.getContract<T>(key + 'PNH');
  }

  async setContractByResourceId<T extends BaseContract>(factoryName: string, resourceId: string, cacheKey: string) {
    const endpointPNH = this.getEndpointV1();
    await eventually<boolean>({
      check: async () => {
        if (resourceId === ZERO_HASH) return false;

        const tokenAddress = await endpointPNH.getAddressByResourceId(resourceId);

        await this.getContractAt<T>(factoryName, tokenAddress, cacheKey + 'PNH');

        return true;
      },
      message: `Resolving token rid=${shortHex(resourceId)} via Endpoint on PNH`,
    });

    return this.getPNHContract<T>(cacheKey);
  }

  async waitForSwapCompleted(sharedId: string, blockNumber: number): Promise<void> {
    const dvpTeleport = this.getContract<DvpTeleport>('DvpTeleport');
    const swapCompletedFilter = dvpTeleport.filters.SwapCompleted(sharedId);

    await eventually<boolean>({
      check: async () => {
        // Query [start, tip] each attempt — a fixed +300 window can fall behind the
        // swap under load/slow finality and miss the event forever (looks like a relayer
        // failure but is a test-window bug).
        const tip = await this.provider.getBlockNumber();
        const logs = await dvpTeleport.queryFilter(swapCompletedFilter, blockNumber, tip);
        return logs.length > 0;
      },
      message: `Checking SwapCompleted event (sharedId=${shortHex(sharedId)})`,
    });
  }

  // waitForSwapInitialized polls until the DvpTeleport emits the SwapInitiated event, then optionally waits
  // for the relayer to propagate data to PNCommunicator.
  async waitForSwapInitialized(sharedId: string, blockNumber: number, pnCommunicator?: PNCommunicatorV1,): Promise<void> {
    const dvpTeleport = this.getContract<DvpTeleport>('DvpTeleport');
    const swapInitiatedFilter = dvpTeleport.filters.SwapInitiated(sharedId);

    await eventually<boolean>({
      check: async () => {
        // Query [start, tip] each attempt — a fixed +300 window can fall behind the
        // swap under load/slow finality and miss the event forever.
        const tip = await this.provider.getBlockNumber();
        const logs = await dvpTeleport.queryFilter(swapInitiatedFilter, blockNumber, tip);
        return logs.length > 0;
      },
      message: `Checking SwapInitiated event (sharedId=${shortHex(sharedId)})`,
    });

    // SwapInitiated above is the deterministic signal that the swap is on-chain. When a
    // communicator is supplied, additionally wait for the relayer to propagate the shared
    // info — an observable condition. Without it there is nothing to poll, so don't add a
    // fixed sleep (timing-based flakiness); the SwapInitiated wait already gates the caller.
    if (pnCommunicator) {
      await eventually<boolean>({
        check: async () => {
          const sharedInfo = await pnCommunicator.getAllSharedInfo(sharedId);
          return sharedInfo[1].length > 0;
        },
        message: `Waiting for relayer to process swap (sharedId=${shortHex(sharedId)})`,
      });
    }
  }
}
