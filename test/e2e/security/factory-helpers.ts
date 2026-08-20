/**
 * Shared helpers for the contract-factory security tests (RNContractFactoryV1 and
 * RaylsContractFactoryV1). Each helper encodes one piece of the test scenario so tests
 * can read top-to-bottom as a story.
 */

import { getCreate2Address, hexlify, JsonRpcProvider, keccak256, toBeHex } from 'ethers';

/**
 * Builds a deterministic byte-pattern runtime of the given length:
 *   - bytes [0..1]:  STOP, STOP  (lets the factory's post-deploy init-call halt cleanly
 *                                 regardless of any one-byte runtime shift)
 *   - bytes [2..N):  unique pattern 0x01..  (any shift, truncation, padding is visible)
 *
 * Used by tests that verify "the factory must store exactly the bytes supplied as the
 * deployed contract's runtime".
 */
export function buildSentinelRuntime(length: number): string {
  const arr = new Uint8Array(length);
  if (length >= 1) arr[0] = 0x00;
  if (length >= 2) arr[1] = 0x00;
  for (let i = 2; i < length; i++) arr[i] = (i - 1) & 0xff;
  return hexlify(arr);
}

/**
 * Hand-crafted runtime that stores the calling msg.sig in storage slot 0:
 *   PUSH1 0  CALLDATALOAD                  // load first 32 bytes of calldata
 *   PUSH1 0xe0  SHR                        // shift right 224 bits → low 4 bytes (msg.sig)
 *   PUSH1 0  SSTORE                        // persist at slot 0
 *   STOP                                   // halt cleanly
 *   <padding to >= 256 bytes>              // PUSH2 init-code path
 *
 * Used by selector-binding tests: deploy this, observe slot 0 to see what selector the
 * factory dispatched on the freshly deployed contract.
 */
export function buildSelectorObservingRuntime(): string {
  const core = '60003560e01c60005500'; // 10 bytes
  const padding = '00'.repeat(256 - 10); // → 256 bytes total (PUSH2 path)
  return '0x' + core + padding;
}

/**
 * Mirror of the factory's private `_getInitCodeOfEmptyConstructor` so tests can predict
 * the CREATE2 address before the deploy tx confirms.
 */
export function buildInitStub(runtimeLengthBytes: number): string {
  const headerHex = '608060405234801561001057600080fd5b50'; // 18 bytes
  // PUSH1 path tail uses CODECOPY offset 0x001f; PUSH2 path uses 0x0020.
  if (runtimeLengthBytes <= 255) {
    return headerHex + '60' + runtimeLengthBytes.toString(16).padStart(2, '0') + '8061001f6000396000f3fe';
  }
  return headerHex + '61' + runtimeLengthBytes.toString(16).padStart(4, '0') + '806100206000396000f3fe';
}

/**
 * Predicts the address at which `factory.deploy(runtime, ...)` will place the new
 * contract. Reads the live `saltCounter` (storage slot 0) and computes:
 *   salt     = bytes32(saltCounter + 1)          // raw cast, NOT hashed
 *   codeHash = keccak256(stub(runtime.length) || runtime)
 *   address  = CREATE2(factory, salt, codeHash)
 *
 * The salt is the raw uint256 cast to bytes32 (left-padded). This matches the
 * factory's `bytes32(++saltCounter)` exactly — wrapping it in keccak256 (as an
 * earlier revision of this helper did) drifts the predicted address from the
 * actual CREATE2 placement and breaks every test that reads code at the
 * predicted address.
 */
export async function predictNextDeployAddress(
  provider: JsonRpcProvider,
  factoryAddress: string,
  runtime: string,
): Promise<string> {
  const saltCounterHex = await provider.getStorage(factoryAddress, 0);
  const nextSalt = BigInt(saltCounterHex) + 1n;
  const runtimeLen = (runtime.length - 2) / 2;
  const stubHex = buildInitStub(runtimeLen);
  const fullDeployment = '0x' + stubHex + runtime.slice(2);
  const codeHash = keccak256(fullDeployment);
  const salt = toBeHex(nextSalt, 32);
  return getCreate2Address(factoryAddress, salt, codeHash);
}

/**
 * Returns true if the given selector is callable on the contract (the call doesn't
 * revert on selector resolution). Used by dead-storage sentinels to verify that a
 * removed accessor's selector is no longer present in the contract's dispatch table.
 */
export async function selectorIsCallable(
  provider: JsonRpcProvider,
  contract: string,
  selectorHex10: string, // 0x + 8 hex chars
): Promise<boolean> {
  // Append a 32-byte zero arg so contracts expecting one parameter accept the call.
  const calldata = selectorHex10 + '00'.repeat(32);
  try {
    await provider.call({ to: contract, data: calldata });
    return true;
  } catch {
    return false;
  }
}
