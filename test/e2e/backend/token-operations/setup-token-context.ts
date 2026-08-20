import { BaseContract, ethers } from 'ethers';
import { IOperatorController } from '../../../../src/api/interfaces';
import { IUserController } from '../../../../src/api/interfaces/IUserController';
import { IOnboardingResponse } from '../../../../src/api/models/IOnboardingApiBodies';
import { LOGGER } from '../../../../src/config/env-config';
import { PrivacyNode } from '../../../../src/entities/PrivacyNode';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { BaseTokenWrapper } from '../../../../src/entities/tokens/BaseTokenWrapper';
import { ERC20Wrapper } from '../../../../src/entities/tokens/ERC20Wrapper';
import { ERC721Wrapper } from '../../../../src/entities/tokens/ERC721Wrapper';
import { ERC1155Wrapper } from '../../../../src/entities/tokens/ERC1155Wrapper';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import {
  IMintArgsERC20,
  IMintArgsERC721,
  IMintArgsERC1155,
  IMintArgsEnygma,
} from '../../../../src/entities/tokens/interfaces/IMintArgs';
import { OnboardingStatus } from '../../../../src/enums/OnboardingStatus';
import { TokenStatus } from '../../../../src/enums/TokenStatus';
import { registerTokenAndUpdateStatus, submitTokenToPublicChain } from '../../../../src/flows/backend/token-operations';
import { onboardUserAndUpdateStatus } from '../../../../src/flows/backend/user-onboarding';
import { randomSuffix } from '../../../../src/utils/generators';
import { initializePrivacyNodes, PrivacyNodeMap } from '../../../setup';

// `deploy()` and `mintAndAwait()` are defined on each concrete wrapper
// (ERC20/721/1155/Enygma) but not on BaseTokenWrapper itself, so we widen the
// constraint structurally. `transfer` is optional because Enygma uses
// `crossTransfer` instead — TransferArgsFor<W> resolves to `never` for it.
export type DeployableTokenWrapper = BaseTokenWrapper<any> & {
  deploy(): Promise<BaseContract>;
  mintAndAwait(privateHub: PrivateHub | undefined, args: any): Promise<unknown>;
  transfer?(to: string, args: any): Promise<void>;
};

// Maps a wrapper type to its mint args shape, minus `toAddress` (helper supplies it).
export type MintArgsFor<W> =
  W extends ERC20Wrapper<any>   ? Omit<IMintArgsERC20, 'toAddress'>   :
  W extends ERC721Wrapper<any>  ? Omit<IMintArgsERC721, 'toAddress'>  :
  W extends ERC1155Wrapper<any> ? Omit<IMintArgsERC1155, 'toAddress'> :
  W extends EnygmaWrapper<any>  ? Omit<IMintArgsEnygma, 'toAddress'>  :
  never;

// Maps a wrapper type to its transfer args (helper supplies from/to addresses).
export type TransferArgsFor<W> =
  W extends ERC20Wrapper<any>   ? { amount: bigint }                     :
  W extends ERC721Wrapper<any>  ? { tokenId: bigint }                    :
  W extends ERC1155Wrapper<any> ? { tokenId: bigint; amount: bigint }    :
  never;

export interface SetupBackendTokenContextOptions<W extends DeployableTokenWrapper> {
  // Closure carries the generic, e.g. `(node) => new ERC20Wrapper<ProductionErc20Token>(node, ProductionErc20Token__factory)`.
  // ALL standards MUST use a constructor-deployable *Production* factory here, NOT a *Example one —
  // this legacy flow registers by the constructor-deployed PL address and wants production bytecode.
  wrapper: (node: PrivacyNode) => W;
  // Seed for setFields() — typically `this.currentTest?.fullTitle()`. Falls back to random.
  title?: string;
  // Number of privacy nodes to initialize. Defaults to 1 (single-node flows). Pass 2+ for
  // cross-node tests (e.g. token-lock flows that later need privacyNodes.B). The token is always
  // deployed on node A regardless.
  nodeCount?: number;
}

export interface BackendTokenContext<W extends DeployableTokenWrapper> {
  tokenModel: W;
  tokenAddressInPLA: string;
  userOperator: ethers.HDNodeWallet | ethers.Wallet;
  signerAddress: string;
  privacyNodes: PrivacyNodeMap;
}

export async function setupBackendTokenContext<W extends DeployableTokenWrapper>(
  opts: SetupBackendTokenContextOptions<W>,
): Promise<BackendTokenContext<W>> {
  // Backend single-node flows are ops-api + PN-local (register/submit/onboard via ops-api, mint/transfer
  // on the token contract, teleport private→public). None touch the hub, so init PN-only (which also grants
  // the standard operator/bank roles). No PrivateHub — see activateTokenOnHubViaBackend (below) for the
  // CrossNode hub leg, which brings its own hub.
  const privacyNodes = await initializePrivacyNodes(opts.nodeCount ?? 1);

  const tokenModel = opts.wrapper(privacyNodes.A);
  tokenModel.setFields(randomSuffix(opts.title));
  const tokenInstance = await tokenModel.deploy();

  const userOperator = tokenModel.userWallet;
  const tokenAddressInPLA = await tokenInstance.getAddress();
  LOGGER.log(`[DEBUG] Token address in PLA ${tokenAddressInPLA}`);
  const signerAddress = await userOperator.getAddress();

  // Deploy-only. Minting is deferred to AFTER PN authorization (the token contract gates
  // mint/transfer with `whenPrivacyNodeActive`): `setupTokenForUser` mints post-register, and
  // the bypasser suites that skip it mint after their own `registerTokenAndUpdateStatus`.
  tokenModel.address[privacyNodes.A.chainId] = tokenAddressInPLA;

  return {
    tokenModel,
    tokenAddressInPLA,
    userOperator,
    signerAddress,
    privacyNodes,
  };
}

export interface SetupTokenForUserOptions<W extends DeployableTokenWrapper>
  extends SetupBackendTokenContextOptions<W> {
  userController: IUserController;
  operatorController: IOperatorController;
  // Mint to the signer AFTER the token is AUTHORIZED on the PN (mint is gated by
  // `whenPrivacyNodeActive`). `toAddress` is filled by the helper. Requires registerAs to
  // resolve to AUTHORIZED; omit for deploy-only / non-authorized setups.
  mint?: MintArgsFor<W>;
  // Defaults to TokenStatus.AUTHORIZED. Pass 'skip' to leave the token unregistered
  // (negative tests that test the unregistered-token failure path).
  registerAs?: TokenStatus | 'skip';
  // Transfer minted balance from signer to the user's private chain address.
  // Omit to leave the balance on the signer (negative tests for "not-owned-by-user" scenarios).
  transfer?: TransferArgsFor<W>;
}

export interface TokenForUserContext<W extends DeployableTokenWrapper>
  extends BackendTokenContext<W> {
  addressPair: IOnboardingResponse;
}

export async function setupTokenForUser<W extends DeployableTokenWrapper>(
  opts: SetupTokenForUserOptions<W>,
): Promise<TokenForUserContext<W>> {
  const ctx = await setupBackendTokenContext(opts);

  // Register/promote the token BEFORE onboarding. The token register/approve writes the operator
  // wallet to HSM custody, and the custody mock retains only the most-recently-written wallet
  // (sequential _id upsert). Onboarding last makes the user's HSM pair the live custody wallet so
  // teleport can sign with `from` = private_chain_address. Mirrors the multi-pair flow in
  // Token_Lock_ERC20.ts — doing it the other way evicts the user pair → teleport custody 204 → 500.
  const registerAs = opts.registerAs ?? TokenStatus.AUTHORIZED;
  const isAuthorized = registerAs === TokenStatus.AUTHORIZED;
  if (registerAs !== 'skip') {
    await registerTokenAndUpdateStatus(
      opts.userController, opts.operatorController,
      ctx.tokenAddressInPLA, registerAs,
    );
    // Propagate to the public chain so teleport (lock) can land. Operator-signed — must run BEFORE
    // onboarding (same HSM-custody-eviction reason register/approve do). Only AUTHORIZED tokens can
    // submit (else 422). Initiate-only; tests wait for DEPLOYED via getPublicAddress()/verifyPublicBalance.
    if (isAuthorized) {
      await submitTokenToPublicChain(opts.operatorController, ctx.tokenAddressInPLA);
    }
  }

  const addressPair = await onboardUserAndUpdateStatus(
    opts.userController, opts.operatorController,
    OnboardingStatus.APPROVED,
  );

  // Mint AFTER PN authorization — the token contract gates mint with `whenPrivacyNodeActive`, so a
  // pre-authorization mint reverts `RaylsApp__PrivacyNodeNotActive`. Mint is EOA (userWallet)-signed
  // and does NOT touch HSM custody, so it safely follows onboarding (the last custody write).
  if (opts.mint) {
    if (!isAuthorized) {
      throw new Error(
        `setupTokenForUser: mint requires registerAs === AUTHORIZED (mint is gated by whenPrivacyNodeActive)`,
      );
    }
    await ctx.tokenModel.mintAndAwait(undefined, { toAddress: ctx.signerAddress, ...opts.mint });
  }

  if (opts.transfer) {
    if (!ctx.tokenModel.transfer) {
      throw new Error(
        `setupTokenForUser: transfer is not supported for ${ctx.tokenModel.constructor.name}`,
      );
    }
    await ctx.tokenModel.transfer(addressPair.private_chain_address, opts.transfer);
  }

  return { ...ctx, addressPair };
}

/**
 * Hub-activate an issuer token, driving the PN authorize step through ops-api: `register` → `approve`
 * (updatePrivacyNodeStatus → AUTHORIZED) via ops-api — the PN transactions issued via the API — then the
 * hub leg via the contract `activateOnHub` (submitToHub as adminWallet → PNH operator approve → wait for
 * the resourceId on the PN). Net effect equals `activateOnPn()` + `activateOnHub()`, with register+approve
 * over ops-api. The hub leg stays contract-side because ops-api `submit {target:hub}` reverts on-chain in
 * this stack (the PN-side `submitToHub` hub-messaging body), so it is NOT a viable ops-api path.
 *
 * Used by the CrossNode `before` hooks on node A (the issuer). No onboarding happens before this, so the
 * operator-signed register/approve writes are custody-safe (onboarding, the last custody write before
 * teleport, happens later in the `it`).
 */
export async function activateTokenOnHubViaBackend<W extends DeployableTokenWrapper>(opts: {
  userController: IUserController;
  operatorController: IOperatorController;
  tokenModel: W;
  tokenAddress: string;
  privateHub: PrivateHub;
}): Promise<void> {
  await registerTokenAndUpdateStatus(
    opts.userController, opts.operatorController,
    opts.tokenAddress, TokenStatus.AUTHORIZED,
  );
  await opts.tokenModel.activateOnHub(opts.privateHub);
}
