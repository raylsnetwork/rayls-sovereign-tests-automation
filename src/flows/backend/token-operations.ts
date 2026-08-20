import {IUserController} from "../../api/interfaces/IUserController";
import {
  ITokenLockRequest,
  ITokenLockRequestERC20,
  ITokenLockRequestERC721,
  ITokenLockRequestERC1155,
} from '../../api/models/ITokensApiBodies';
import {expect} from "chai";
import {IOperatorController} from "../../api/interfaces";
import { TokenStatus } from "../../enums/TokenStatus";
import { FreezeLayer } from "../../enums/FreezeLayer";
import { SubmitTarget } from "../../enums/SubmitTarget";
import { retry } from '../../utils/common';
import { shortHex } from '../../utils/formatters';
import { LOGGER } from '../../config/env-config';
import { TransientBackendError } from '../../exceptions-and-errors/backend-error';
import { TokenStandards } from '../../enums/TokenStandards';
import { IOnboardingResponse } from '../../api/models/IOnboardingApiBodies';

/**
 * Register a token in ops-api for a user (POST /api/tokens/:address/register) and then promote it as
 * an operator (PATCH /api/v1/admin/tokens/:address/status).
 *
 * Notes:
 * - Registration (user POST) is attempted once (no retry loop), to surface errors deterministically.
 * - Approval (operator PATCH) uses retries to account for block/relayer propagation delays.
 *
 * @param userController
 * @param operatorController
 * @param tokenAddressInPL
 * @param newStatus AUTHORIZED (2) or UNAUTHORIZED (3) — the only values set-status accepts
 * @returns The registry response for the added token
 */
export async function registerTokenAndUpdateStatus(
  userController : IUserController,
  operatorController : IOperatorController,
  tokenAddressInPL:string,
  newStatus: TokenStatus
){
    // 1) Register token (user) - includes built-in propagation delay
    const registeredToken = await registerToken(
      userController,
      tokenAddressInPL,
    );

    // 2) Promote token (operator)
    await updateTokenStatus(operatorController, registeredToken.address, newStatus);
    await userController.pollUntilTokenStatusIsUpdated(
      registeredToken.address,
      newStatus,
    );
    return registeredToken;
}

/**
 * Register a token in ops-api (user POST /api/tokens/:address/register; address is the path param,
 * no body — the contract reads name/symbol/standard/supply on-chain). The token starts at
 * WAITING_APPROVAL (1). Retries on transient nonce-collision errors from the backend's on-chain submission.
 */
export async function registerToken(userController : IUserController, tokenAddressInPL:string){
  LOGGER.log(`Registering token in ops-api with address: ${tokenAddressInPL}`);
  const registeredToken = await retry(
    () => userController.registerToken(tokenAddressInPL),
    {
      attempts: 10,
      delayMs: 3000,
      retryIf: TransientBackendError.isTransient,
      onRetry: (err, i) => LOGGER.log(`Retrying token registration (${i}/10): ${TransientBackendError.reason(err)} — ${err.message}`),
    }
  );
  // ops-api returns the address lowercased; compare case-insensitively (EIP-55 case is display-only).
  expect(registeredToken.address.toLowerCase()).to.be.equal(tokenAddressInPL.toLowerCase());
  LOGGER.log(`Successful registration of token with address: ${tokenAddressInPL}`);

  await userController.pollUntilTokenStatusIsUpdated(
    registeredToken.address,
    registeredToken.status,
  );

  return registeredToken;
}

/**
 * Promote a token in ops-api (operator PATCH /api/v1/admin/tokens/:address/status) with retries.
 * The token address is the path param; the body carries only `{ status }`.
 */
export async function updateTokenStatus(
  operatorController: IOperatorController,
  address: string,
  status: TokenStatus,
  opts?: { attempts?: number; delayMs?: number }
): Promise<void> {
  const approveAttempts = opts?.attempts ?? 20;
  const approveDelayMs = opts?.delayMs ?? 3000;

  await retry(
    async () => {
      await operatorController.updateTokenStatus(address, { status });
      LOGGER.log(`Token update status request succeeded`);
    },
    {
      attempts: approveAttempts,
      delayMs: approveDelayMs,
      retryIf: TransientBackendError.isTransient,
      onRetry: (err, i) => {
        LOGGER.error(
          `[RETRY ${i}/${approveAttempts}] updateTokenStatus failed: ${err.message} ` +
          `(status=${err.status}, reason=${TransientBackendError.reason(err)})\n  ${shortHex(address)} → ${status}`,
        );
      },
    },
  );
}

/**
 * Freeze a token on a given layer via ops-api (operator POST /api/v1/admin/tokens/:address/freeze),
 * with retries. Address is the path param; body carries only `{ layer }`.
 */
export async function freezeToken(
  operatorController: IOperatorController,
  address: string,
  layer: FreezeLayer,
  opts?: { attempts?: number; delayMs?: number }
): Promise<void> {
  await retry(
    async () => {
      await operatorController.freezeToken(address, { layer });
      LOGGER.log(`Token freeze request succeeded (${layer})`);
    },
    {
      attempts: opts?.attempts ?? 20,
      delayMs: opts?.delayMs ?? 3000,
      retryIf: TransientBackendError.isTransient,
      onRetry: (err, i) =>
        LOGGER.error(`[RETRY ${i}] freezeToken failed: ${err.message}\n  ${shortHex(address)} layer=${layer}`),
    },
  );
}

/**
 * Unfreeze a token on a given layer via ops-api (operator POST /api/v1/admin/tokens/:address/unfreeze),
 * with retries. Address is the path param; body carries only `{ layer }`.
 */
export async function unfreezeToken(
  operatorController: IOperatorController,
  address: string,
  layer: FreezeLayer,
  opts?: { attempts?: number; delayMs?: number }
): Promise<void> {
  await retry(
    async () => {
      await operatorController.unfreezeToken(address, { layer });
      LOGGER.log(`Token unfreeze request succeeded (${layer})`);
    },
    {
      attempts: opts?.attempts ?? 20,
      delayMs: opts?.delayMs ?? 3000,
      retryIf: TransientBackendError.isTransient,
      onRetry: (err, i) =>
        LOGGER.error(`[RETRY ${i}] unfreezeToken failed: ${err.message}\n  ${shortHex(address)} layer=${layer}`),
    },
  );
}

/**
 * Submit an AUTHORIZED token to the public chain via ops-api
 * (operator POST /api/v1/admin/tokens/:address/submit, body `{ target: 'public_chain' }`), with retries.
 * Initiate-only: this kicks off the relayer public-chain deployment; it does NOT wait for
 * publicChainStatus == DEPLOYED (ops-api exposes no poll for it). Callers observe DEPLOYED via the
 * contract-side `BaseTokenWrapper.getPublicAddress()` / `verifyPublicBalance()`. Requires the token to be
 * privacyNodeStatus == AUTHORIZED first (else 422).
 */
export async function submitTokenToPublicChain(
  operatorController: IOperatorController,
  address: string,
  opts?: { attempts?: number; delayMs?: number }
): Promise<void> {
  await retry(
    async () => {
      await operatorController.submitToken(address, { target: SubmitTarget.PUBLIC_CHAIN });
      LOGGER.log(`Token submit-to-public-chain request succeeded`);
    },
    {
      attempts: opts?.attempts ?? 20,
      delayMs: opts?.delayMs ?? 3000,
      retryIf: TransientBackendError.isTransient,
      onRetry: (err, i) =>
        LOGGER.error(`[RETRY ${i}] submitTokenToPublicChain failed: ${err.message}\n  ${shortHex(address)}`),
    },
  );
}

/**
* Teleport a token to the public chain via ops-api (POST /api/tokens/:address/teleport), with retries.
* The token address is the path param; returns the `tx_hash` from the teleport response.
*
* Module-private: callers must use the standard-specific entry points
* (`teleportERC20` / `teleportERC721` / `teleportERC1155`), which embed the standard and
* build a correctly-shaped payload. For negative assertions that need a single,
* deterministic attempt, call `userController.teleport(address, ...)` directly.
* @returns Transaction hash as a string
*/
async function teleportTokenAndSend<T extends ITokenLockRequest>(
  userController: IUserController,
  address: string,
  request: T,
  opts?: { attempts?: number; delayMs?: number }
): Promise<string> {
  const attempts = opts?.attempts ?? 5;
  const delayMs = opts?.delayMs ?? 5000;

  return retry(
    async () => {
      const resp = await userController.teleport<T>(address, request);
      if (!resp.tx_hash) throw new Error('Transaction hash not found in teleport response');
      LOGGER.log(`Token teleport request succeeded`);
      return resp.tx_hash;
    },
    {
      attempts,
      delayMs,
      // Happy-path only (negatives call teleport directly), so retry any error —
      // a failure here is usually a transient revert while teleport/public-counterpart settles.
      onRetry: (err, i) => {
        LOGGER.error(
          `[RETRY ${i}/${attempts}] teleport failed: ${err.message ?? err} ` +
          `(status=${err.status ?? '?'})\n  ${shortHex(address)} payload: ${JSON.stringify(request)}`,
        );
      },
    },
  );
}

interface TeleportHelperBase {
  // Onboarding result: supplies the private_chain (from) and public_chain (to) addresses.
  pair: IOnboardingResponse;
  // Token address on the privacy ledger (routed to the teleport path param).
  token: string;
}

type TeleportOpts = { attempts?: number; delayMs?: number };

/**
 * Standard-specific teleport entry points. Each embeds the token standard and builds
 * the payload, so the call site can't mismatch fields (e.g. teleport an ERC20 with a
 * tokenId). All return the teleport transaction hash.
 */
export function teleportERC20(
  userController: IUserController,
  params: TeleportHelperBase & { amount: bigint },
  opts?: TeleportOpts,
): Promise<string> {
  const request: ITokenLockRequestERC20 = {
    from: params.pair.private_chain_address,
    to: params.pair.public_chain_address,
    standard: TokenStandards.ERC20,
    amount: params.amount.toString(),
  };
  return teleportTokenAndSend(userController, params.token, request, opts);
}

export function teleportERC721(
  userController: IUserController,
  params: TeleportHelperBase & { tokenId: bigint },
  opts?: TeleportOpts,
): Promise<string> {
  const request: ITokenLockRequestERC721 = {
    from: params.pair.private_chain_address,
    to: params.pair.public_chain_address,
    standard: TokenStandards.ERC721,
    tokenId: params.tokenId.toString(),
  };
  return teleportTokenAndSend(userController, params.token, request, opts);
}

export function teleportERC1155(
  userController: IUserController,
  params: TeleportHelperBase & { tokenId: bigint; amount: bigint },
  opts?: TeleportOpts,
): Promise<string> {
  const request: ITokenLockRequestERC1155 = {
    from: params.pair.private_chain_address,
    to: params.pair.public_chain_address,
    standard: TokenStandards.ERC1155,
    tokenId: params.tokenId.toString(),
    amount: params.amount.toString(),
  };
  return teleportTokenAndSend(userController, params.token, request, opts);
}
