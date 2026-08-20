import { IUserController } from '../../api/interfaces/IUserController';
import { IOperatorController } from '../../api/interfaces';
import { IOnboardingResponse, IUpdateOnbStatusRequest, IUserAddressPair } from '../../api/models/IOnboardingApiBodies';
import { eventually, retry } from '../../utils/common';
import { LOGGER } from '../../config/env-config';
import { OnboardingStatus } from '../../enums/OnboardingStatus';
import { TransientBackendError } from '../../exceptions-and-errors/backend-error';
import { shortHex } from '../../utils/formatters';

// ops-api has one shared JWT user per node, so the self-list accumulates every prior test's pair.
// Match a pair by its (case-insensitive) address tuple rather than by list position/length.
export function findAddressPair<T extends IOnboardingResponse>(
  pairs: T[],
  target: IOnboardingResponse,
): T | undefined {
  return pairs.find(
    (p) =>
      p.public_chain_address.toLowerCase() === target.public_chain_address.toLowerCase() &&
      p.private_chain_address.toLowerCase() === target.private_chain_address.toLowerCase(),
  );
}

/**
 * Onboards a fresh address pair and transitions it to `newStatus`.
 *
 * NOTE: the resolved ops-api `userId` is surfaced via the `opts.onUserId(userId)` callback, NOT the
 * return value (which is the address pair). If a later test step needs to transition the SAME pair
 * again (e.g. APPROVED→REJECTED), capture the id here and feed it back via `opts.userId` on
 * `updateOnboardingStatus` — the pair leaves the admin pending list after the first transition and
 * can no longer be re-discovered. See CLAUDE.md "Backend Onboarding / Address Pairs".
 */
export async function onboardUserAndUpdateStatus(
  userController: IUserController,
  operatorController: IOperatorController,
  newStatus: OnboardingStatus,
  opts?: { operatorApprovalAttempts?: number; operatorApprovalDelayMs?: number; onUserId?: (userId: string) => void },
): Promise<IOnboardingResponse> {
  const onboardingResponse = await onboardUser(userController);
  // Surface the userId resolved during the PENDING→APPROVED discovery. Once the pair leaves PENDING it
  // drops out of the admin pending list, so a later transition on the same pair can only target it by
  // this cached id (passed back via `opts.userId`).
  const userId = await updateOnboardingStatus(operatorController, onboardingResponse, newStatus, opts);
  opts?.onUserId?.(userId);

  // For APPROVED, don't hand back the raw add-pair POST response (a PENDING snapshot). Confirm the
  // operator approval propagated and that the JWT caller can see its own pair as APPROVED, then return
  // the listed pair — its addresses are in the exact form ops-api stores, which teleport `from`/`to`
  // (and HSM custody lookup) must match. A caller that can't see its approved pair throws here with a
  // clear message instead of an opaque downstream custody 204.
  if (newStatus !== OnboardingStatus.APPROVED) return onboardingResponse;

  return await eventually<IUserAddressPair>({
    check: async () => {
      const mine = await userController.listMyAddressPairs();
      const pair = findAddressPair(mine, onboardingResponse);
      return pair?.status === OnboardingStatus.APPROVED ? pair : undefined;
    },
    message: `Waiting for pair ${shortHex(onboardingResponse.private_chain_address)} → APPROVED & visible to caller`,
    tolerateErrors: true,
  });
}

// Adds a fresh HSM address pair for the JWT's user (identity is server-side). Returns the created pair.
export async function onboardUser(userController: IUserController): Promise<IOnboardingResponse> {
  LOGGER.info('Onboarding user — adding a fresh HSM address pair');
  let userOnboardingRes: IOnboardingResponse = {} as IOnboardingResponse;
  await retry(async () => {
    userOnboardingRes = await userController.addAddressPair();
  });
  return userOnboardingRes;
}

// Resolves the ops-api UUID (`:id`) for a pair by matching it in the admin pending-discovery list.
// Only pending pairs are discoverable — capture the returned id before transitioning the pair away
// from PENDING if a later transition on the same pair is needed.
export async function discoverUserId(
  operatorController: IOperatorController,
  pair: IOnboardingResponse,
  opts?: { attempts?: number; delayMs?: number },
): Promise<string> {
  return await eventually<string>({
    check: async () => {
      const groups = await operatorController.listAllPendingAddressPairs();
      const match = groups.find((g) =>
        g.address_pairs.some(
          (p) =>
            p.public_chain_address.toLowerCase() === pair.public_chain_address.toLowerCase() &&
            p.private_chain_address.toLowerCase() === pair.private_chain_address.toLowerCase(),
        ),
      );
      return match?.user_id;
    },
    interval: opts?.delayMs ?? 1000,
    attempts: opts?.attempts ?? 30,
    message: `Waiting for pending pair ${shortHex(pair.public_chain_address)} → discoverable userId`,
    tolerateErrors: true,
  });
}

// Approves/rejects `pair`. Discovers the path `:id` via the admin pending list unless `opts.userId`
// is supplied (reuse for a second transition, where the pair is no longer in the pending list).
// Returns the userId used, so callers can chain further transitions on the same pair.
export async function updateOnboardingStatus(
  operatorController: IOperatorController,
  userOnboardingRes: IOnboardingResponse,
  newStatus: OnboardingStatus,
  opts?: { operatorApprovalAttempts?: number; operatorApprovalDelayMs?: number; userId?: string },
): Promise<string> {
  const attempts = opts?.operatorApprovalAttempts ?? 10;
  const delayMs = opts?.operatorApprovalDelayMs ?? 3000;

  const userId = opts?.userId ?? (await discoverUserId(operatorController, userOnboardingRes));

  const payload: IUpdateOnbStatusRequest = {
    public_address: userOnboardingRes.public_chain_address,
    private_address: userOnboardingRes.private_chain_address,
    status: newStatus,
  };

  LOGGER.info(`Setting address-pair status → ${newStatus} for userId ${shortHex(userId)}`);
  await retry(
    () => operatorController.approveAddressPair(userId, payload),
    {
      attempts,
      delayMs,
      retryIf: TransientBackendError.isTransient,
      onRetry: (err, i) => {
        LOGGER.error(
          `[RETRY ${i}/${attempts}] operator approval failed: ${err.message} ` +
          `(status=${err.status}, reason=${TransientBackendError.reason(err)})\n  payload: ${JSON.stringify(payload)}`,
        );
      },
    },
  );
  return userId;
}
