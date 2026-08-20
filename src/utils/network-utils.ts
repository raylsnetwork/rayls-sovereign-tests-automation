import { AbiCoder, ethers, JsonRpcProvider, Provider, Wallet } from 'ethers';
import { expect } from 'chai';
import { eventually } from './common';

export interface FunctionCall {
  signature: string;
  argumentTypes: string[];
  arguments: unknown[];
}
import { LOGGER } from '../config/env-config';

export function getProvider(rpcUrl: string): JsonRpcProvider {
  if (!rpcUrl) {
    expect.fail('[DEBUG] RPC URL not configured or missing');
  }
  return new ethers.JsonRpcProvider(rpcUrl);
}

/**
 * Build and return a signer connected to a JSON-RPC endpoint.
 * Fails fast with clear messages when inputs are missing.
 *
 * @param provider
 * @param privateKey Hex-encoded private key for the signer
 * @returns Connected signer instance
 */
export function getSigner(provider: JsonRpcProvider, privateKey: string): Wallet {
  if (!privateKey) {
    expect.fail('[DEBUG] Private key not configured or missing)');
  }
  return new ethers.Wallet(privateKey).connect(provider);
}

export function getSignerByRpcUrl( rpcUrl: string, privateKey: string): Wallet {
  const provider = getProvider(rpcUrl);
  return getSigner(provider, privateKey);
}

export async function getBalance(rpcUrl: string, signer: Wallet): Promise<bigint> {
  const provider = getProvider(rpcUrl);
  return await provider.getBalance(signer.address);
}

export function encodeFunctionCall(functionCall: FunctionCall) {
  const abiCoder = new AbiCoder();
  const functionSelector = ethers.id(functionCall.signature).slice(0, 10);
  const encodedParameters = abiCoder.encode(functionCall.argumentTypes, functionCall.arguments).slice(2);
  return functionSelector + encodedParameters;
}

export async function waitForNumberOfBlocks(numberOfBlocks: number, provider: Provider) {
  const initialBlockNumber = await provider.getBlockNumber();
  const targetBlockNumber = initialBlockNumber + numberOfBlocks;

  LOGGER.log(`Waiting for ${numberOfBlocks} blocks to be mined...`);

  return eventually<boolean>({
    check: async (): Promise<boolean> => {
      const currentBlockNumber = await provider.getBlockNumber();
      return currentBlockNumber >= targetBlockNumber;
    },
    interval: 1000,
    attempts: 300,
    message: `Waiting for block ${targetBlockNumber} (from ${initialBlockNumber})`,
  });
}