import { BaseContract, ContractFactory, Signer } from 'ethers';
import hre from 'hardhat';
import { formatFactoryName } from '../utils/formatters';
import { retry } from '../utils/common';
import { isNonceError } from '../exceptions-and-errors/block-chain-exceptions';
import { LOGGER } from '../config/env-config';

export class ContractStore {
  private cache = new Map<string, BaseContract>();

  async connectAt<T extends BaseContract>(
    factoryName: string,
    address: string,
    key: string,
    signer: Signer,
  ): Promise<T> {
    const formattedKey = formatFactoryName(key);
    const cached = this.cache.get(formattedKey);

    if (cached && cached.runner === signer) return cached as T;

    const contract = await hre.ethers.getContractAt(formatFactoryName(factoryName), address, signer);
    this.cache.set(formattedKey, contract);

    return contract as unknown as T;
  }

  async getFactory<T extends ContractFactory>(
    factoryRef: string | { name: string },
    signer: Signer,
  ): Promise<T> {
    return (await hre.ethers.getContractFactory(formatFactoryName(factoryRef), signer)) as T;
  }

  async deploy<T extends BaseContract>(
    contractFactory: ContractFactory,
    key: string,
    ...args: Parameters<typeof contractFactory.deploy>
  ): Promise<T> {
    const instance = await retry(
      async () => {
        const deployed = await contractFactory.deploy(...args);
        await deployed.waitForDeployment();
        return deployed;
      },
      {
        attempts: 5,
        delayMs: 500,
        retryIf: isNonceError,
        onRetry: (_err, i) => LOGGER.log(`[NONCE RETRY] Deploy attempt ${i}/5 for ${key}`),
      }
    );
    LOGGER.success(`Deployed contract successfully ${await instance.getAddress()}`);
    this.cache.set(key, instance);
    return instance as T;
  }

  get<T extends BaseContract>(key: string): T {
    const contract = this.cache.get(key);
    if (!contract) throw new Error(`Contract "${key}" not found`);
    return contract as T;
  }

  set(key: string, contract: BaseContract): void {
    this.cache.set(key, contract);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }
}
