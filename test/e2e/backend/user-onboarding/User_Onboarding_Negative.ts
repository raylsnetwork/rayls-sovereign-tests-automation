import {
  BACKEND_OPS_URL,
  BACKEND_OPERATOR_AUTH_KEY,
  BACKEND_USER_AUTH_KEY,
} from '../../../../src/config/env-config';
import {
  discoverUserId,
  onboardUser,
  onboardUserAndUpdateStatus,
  updateOnboardingStatus,
} from '../../../../src/flows/backend/user-onboarding';
import { OperatorController, UserController } from '../../../../src/api';
import { expect } from 'chai';
import { OnboardingStatus } from '../../../../src/enums/OnboardingStatus';
import { eventually } from '../../../../src/utils/common';
import nodeAssert from 'node:assert';
import { BackendError } from '../../../../src/exceptions-and-errors/backend-error';
import { HttpStatusCode } from 'axios';
import { IOnboardingResponse, IPendingUserAddressPairs, IUserAddressPair } from '../../../../src/api/models/IOnboardingApiBodies';

// A syntactically valid UUID for a user that does not exist — exercises handler/service validation
// without onboarding (the handler validates the body before the per-user on-chain write).
const NON_EXISTENT_USER_ID = '11111111-1111-4111-8111-111111111111';
const VALID_HEX_ADDRESS = '0x000000000000000000000000000000000000dEaD';

function samePair(p: IUserAddressPair, target: IOnboardingResponse): boolean {
  return (
    p.public_chain_address.toLowerCase() === target.public_chain_address.toLowerCase() &&
    p.private_chain_address.toLowerCase() === target.private_chain_address.toLowerCase()
  );
}

function findPair(pairs: IUserAddressPair[], target: IOnboardingResponse): IUserAddressPair | undefined {
  return pairs.find((p) => samePair(p, target));
}

function pendingHasPair(groups: IPendingUserAddressPairs[], target: IOnboardingResponse): boolean {
  return groups.some((g) => g.address_pairs.some((p) => samePair(p, target)));
}

describe('User Onboarding Negative @backend-negative @hubless', function () {
  const userController = new UserController(BACKEND_OPS_URL, BACKEND_USER_AUTH_KEY);
  const operatorController = new OperatorController(BACKEND_OPS_URL, BACKEND_OPERATOR_AUTH_KEY);

  describe('Approve/reject payload validation', function () {
    // Body is validated at the handler before any on-chain write, so these need no onboarding.

    it('Should reject status update for a non-existent user', async function () {
      await nodeAssert.rejects(
        operatorController.approveAddressPair(NON_EXISTENT_USER_ID, {
          public_address: VALID_HEX_ADDRESS,
          private_address: VALID_HEX_ADDRESS,
          status: OnboardingStatus.APPROVED,
        }),
        (e: any) => e instanceof BackendError && e.status === HttpStatusCode.NotFound,
      );
    });

    it('Should reject an out-of-range status value', async function () {
      await nodeAssert.rejects(
        operatorController.approveAddressPair(NON_EXISTENT_USER_ID, {
          public_address: VALID_HEX_ADDRESS,
          private_address: VALID_HEX_ADDRESS,
          status: 99,
        }),
        (e: any) =>
          e instanceof BackendError && e.status === HttpStatusCode.BadRequest && /status/i.test(e.message),
      );
    });

    it('Should reject an empty private address', async function () {
      await nodeAssert.rejects(
        operatorController.approveAddressPair(NON_EXISTENT_USER_ID, {
          public_address: VALID_HEX_ADDRESS,
          private_address: '',
          status: OnboardingStatus.APPROVED,
        }),
        (e: any) =>
          e instanceof BackendError && e.status === HttpStatusCode.BadRequest && /address/i.test(e.message),
      );
    });

    it('Should reject an empty public address', async function () {
      await nodeAssert.rejects(
        operatorController.approveAddressPair(NON_EXISTENT_USER_ID, {
          public_address: '',
          private_address: VALID_HEX_ADDRESS,
          status: OnboardingStatus.APPROVED,
        }),
        (e: any) =>
          e instanceof BackendError && e.status === HttpStatusCode.BadRequest && /address/i.test(e.message),
      );
    });

    it('Should revert (422) approving a pair whose address is not mapped to the user', async function (this: Mocha.Context) {
      const pair = await onboardUser(userController);
      const userId = await discoverUserId(operatorController, pair);

      // Valid hex, but not the pair's private address → passes body validation, reverts on-chain.
      await nodeAssert.rejects(
        operatorController.approveAddressPair(userId, {
          public_address: pair.public_chain_address,
          private_address: VALID_HEX_ADDRESS,
          status: OnboardingStatus.APPROVED,
        }),
        (e: any) =>
          e instanceof BackendError &&
          e.status === HttpStatusCode.UnprocessableEntity &&
          /revert/i.test(`${e.message} ${e.details?.hint ?? ''}`),
      );
    });
  });

  describe('Address-pair listing (pair-relative)', function () {
    it('Should not return a rejected pair via listMyAddressPairs', async function (this: Mocha.Context) {
      const pair = await onboardUserAndUpdateStatus(userController, operatorController, OnboardingStatus.REJECTED);

      const pairs = await userController.listMyAddressPairs();
      expect(findPair(pairs, pair), 'rejected pair must not be listed').to.be.undefined;
    });

    it('Should return a pending pair via listMyAddressPairs(PENDING)', async function (this: Mocha.Context) {
      const pair = await onboardUser(userController);

      const pending = await userController.listMyAddressPairs(OnboardingStatus.PENDING);
      expect(findPair(pending, pair), 'pending pair should be listed').to.not.be.undefined;
    });
  });

  describe('Operator pending discovery (pair-relative)', function () {
    it('Should list a freshly-onboarded pair in admin discovery', async function (this: Mocha.Context) {
      const pair = await onboardUser(userController);

      // Besu's eth_call(latest) can briefly trail tx-receipt visibility — poll until readable.
      await eventually<boolean>({
        check: async () => pendingHasPair(await operatorController.listAllPendingAddressPairs(), pair),
        interval: 1000,
        attempts: 30,
        message: `Waiting for admin discovery to surface pending pair ${pair.public_chain_address}`,
      });
    });

    it('Should clear a pair from admin discovery after approval', async function (this: Mocha.Context) {
      const pair = await onboardUser(userController);
      await updateOnboardingStatus(operatorController, pair, OnboardingStatus.APPROVED);

      await eventually<boolean>({
        check: async () => !pendingHasPair(await operatorController.listAllPendingAddressPairs(), pair),
        interval: 1000,
        attempts: 30,
        message: `Waiting for admin discovery to clear approved pair ${pair.public_chain_address}`,
      });
    });

    it('Should clear a pair from admin discovery after rejection', async function (this: Mocha.Context) {
      const pair = await onboardUserAndUpdateStatus(userController, operatorController, OnboardingStatus.REJECTED);

      await eventually<boolean>({
        check: async () => !pendingHasPair(await operatorController.listAllPendingAddressPairs(), pair),
        interval: 1000,
        attempts: 30,
        message: `Waiting for admin discovery to clear rejected pair ${pair.public_chain_address}`,
      });
    });
  });

  describe('Status transitions', function () {
    it('Should allow re-approving a rejected pair (REJECTED → APPROVED)', async function (this: Mocha.Context) {
      const pair = await onboardUser(userController);
      // Cache the userId from the pending-state discovery; reuse it after the pair leaves PENDING.
      const userId = await updateOnboardingStatus(operatorController, pair, OnboardingStatus.REJECTED);

      await updateOnboardingStatus(operatorController, pair, OnboardingStatus.APPROVED, {
        userId,
        operatorApprovalAttempts: 1,
        operatorApprovalDelayMs: 1000,
      });

      const pairs = await userController.listMyAddressPairs();
      expect(findPair(pairs, pair)?.status, 're-approved pair should be APPROVED').to.be.equal(
        OnboardingStatus.APPROVED,
      );
    });

    it('Should allow reverting an approved pair back to pending (APPROVED → PENDING)', async function (this: Mocha.Context) {
      const pair = await onboardUser(userController);
      // Cache the userId from the pending-state discovery; reuse it after the pair leaves PENDING.
      const userId = await updateOnboardingStatus(operatorController, pair, OnboardingStatus.APPROVED);

      await updateOnboardingStatus(operatorController, pair, OnboardingStatus.PENDING, {
        userId,
        operatorApprovalAttempts: 1,
        operatorApprovalDelayMs: 1000,
      });

      await eventually<boolean>({
        check: async () =>
          findPair(await userController.listMyAddressPairs(OnboardingStatus.PENDING), pair) !== undefined,
        interval: 1000,
        attempts: 30,
        message: `Waiting for reverted pair ${pair.public_chain_address} → PENDING`,
      });
    });
  });

  describe('Auth', function () {
    it('Should reject an operator-only route called with a user JWT (403)', async function () {
      const userAsOperator = new OperatorController(BACKEND_OPS_URL, BACKEND_USER_AUTH_KEY);

      await nodeAssert.rejects(
        userAsOperator.listAllPendingAddressPairs(),
        (e: any) => e instanceof BackendError && e.status === HttpStatusCode.Forbidden,
      );
    });
  });
});
