import { AbiCoder, AddressLike, ethers } from 'ethers';
import { SharedObjects } from '../../typechain-types/contracts/remote/rayls-protocol-sdk/tokens/RaylsEnygmaHandler';

// NOTE: the old `EnygmaCrossTransferCallable {resourceId, contractAddress, payload}` model was
// replaced by `EnygmaProgramData {resourceId, contractAddress, selector, args}`. The packed
// `payload` (selector ‖ args) is now split into the typed `selector` + `args` fields. The attested
// originSender is NOT part of the blob — the ProgrammabilityExecutor appends it as a trusted
// 20-byte calldata tail. Owner-attested userBlobs therefore encode ONLY the leading params in `args`.

/**
 * Generate EnygmaProgramData steps that call `receiveMsgA(string)` on the given addresses.
 *
 * @param addresses The addresses of contracts with a receiveMsgA(string) method.
 * @returns A list of program-data steps targeting by contractAddress.
 */
export function generateMsgAEnygmaProgramDataByAddresses(
  addresses: AddressLike[]
): SharedObjects.EnygmaProgramDataStruct[] {
  const functionSignatures = addresses.map(_ => 'receiveMsgA(string)');
  const types = addresses.map(_ => ['string']);
  const values = addresses.map(_ => ['Hello, World!']);

  return createEnygmaProgramDataByAddresses(addresses, functionSignatures, types, values);
}

/**
 * Build a series of EnygmaProgramData steps targeting by contractAddress. Each record across the
 * input arrays describes one call; the sequence is dispatched in order on the destination.
 *
 * @param contractAddresses The addresses of contracts to call
 * @param functionSignatures The function signature to call
 * @param types The ABI type specifications for each call's params
 * @param values The values to call the functions with
 * @returns an array of program-data steps [{ resourceId: 0, contractAddress, selector, args }]
 */
export function createEnygmaProgramDataByAddresses(
  contractAddresses: AddressLike[],
  functionSignatures: string[],
  types: string[][],
  values: any[][]
): SharedObjects.EnygmaProgramDataStruct[] {
  const steps: SharedObjects.EnygmaProgramDataStruct[] = [];
  const abiCoder = new ethers.AbiCoder();

  for (let i = 0; i < contractAddresses.length; i++) {
    // Function selector: first 4 bytes (8 hex chars) of the keccak-256 hash, with "0x" prefix.
    const selector = ethers.id(functionSignatures[i]).slice(0, 10);
    // ABI-encode the leading params; the executor appends originSender as a trusted tail.
    const args = abiCoder.encode(types[i], values[i]);
    steps.push({
      resourceId: ethers.ZeroHash,
      contractAddress: contractAddresses[i],
      selector,
      args,
    });
  }

  return steps;
}

/**
 * Generate EnygmaProgramData steps that call `receiveMsgA(string)` on the given resource ids.
 *
 * @param resourceIds The resource ids of contracts with a receiveMsgA(string) method.
 * @returns A list of program-data steps targeting by resourceId.
 */
export function generateMsgAEnygmaProgramDataByResourceIds(
  resourceIds: string[]
): SharedObjects.EnygmaProgramDataStruct[] {
  const functionSignatures = resourceIds.map(_ => 'receiveMsgA(string)');
  const types = resourceIds.map(_ => ['string']);
  const values = resourceIds.map(_ => ['Hello, World!']);

  return createEnygmaProgramDataByResourceIds(resourceIds, functionSignatures, types, values);
}

/**
 * Build a series of EnygmaProgramData steps targeting by resourceId. Each record across the input
 * arrays describes one call; the sequence is dispatched in order on the destination.
 *
 * @param resourceIds The resource ids of contracts to call
 * @param functionSignatures The function signature to call
 * @param types The ABI type specifications for each call's params
 * @param values The values to call the functions with
 * @returns an array of program-data steps [{ resourceId, contractAddress: 0, selector, args }]
 */
export function createEnygmaProgramDataByResourceIds(
  resourceIds: string[],
  functionSignatures: string[],
  types: string[][],
  values: any[][]
): SharedObjects.EnygmaProgramDataStruct[] {
  const steps: SharedObjects.EnygmaProgramDataStruct[] = [];
  const abiCoder = new AbiCoder();

  for (let i = 0; i < resourceIds.length; i++) {
    const selector = ethers.id(functionSignatures[i]).slice(0, 10);
    const args = abiCoder.encode(types[i], values[i]);
    steps.push({
      resourceId: resourceIds[i],
      contractAddress: ethers.ZeroAddress,
      selector,
      args,
    });
  }

  return steps;
}
