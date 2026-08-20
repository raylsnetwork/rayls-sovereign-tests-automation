import { ethers } from 'ethers';
import { AccessManagerRoleConfigLib__factory } from '../../typechain-types';

/**
 * Bind `AccessManagerRoleConfigLib` to the manager address so chai's
 * `revertedWithCustomError` can resolve errors declared/reverted from the lib
 * (e.g. `RaylsAccessManagerV1__NotRoleAdmin`, `RaylsAccessManagerV1__CannotPauseSelf`).
 * The errors live in `AccessManagerTypes.sol` as free errors and aren't on the
 * manager's own ABI, so we connect the lib factory directly at the manager address.
 */
export function notRoleAdminErr(managerAddress: string, signerOrProvider: ethers.Signer | ethers.Provider) {
  return AccessManagerRoleConfigLib__factory.connect(managerAddress, signerOrProvider);
}