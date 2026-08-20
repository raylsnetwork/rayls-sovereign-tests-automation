import { OperatorController, UserController } from '../../../../src/api';
import {
  BACKEND_OPS_URL,
  BACKEND_OPERATOR_AUTH_KEY,
  BACKEND_USER_AUTH_KEY,
  DEFAULT_TIMEOUT,
} from '../../../../src/config/env-config';
import {
  registerToken,
  registerTokenAndUpdateStatus,
} from '../../../../src/flows/backend/token-operations';
import nodeAssert from 'node:assert';
import { onboardUserAndUpdateStatus, updateOnboardingStatus } from '../../../../src/flows/backend/user-onboarding';
import { TokenStatus } from '../../../../src/enums/TokenStatus';
import { OnboardingStatus } from '../../../../src/enums/OnboardingStatus';
import { randomSuffix } from '../../../../src/utils/generators';
import { BackendError } from '../../../../src/exceptions-and-errors/backend-error';
import { ITokenLockRequest } from '../../../../src/api/models/ITokensApiBodies';
import { HttpStatusCode } from 'axios';
import { TokenStandards } from '../../../../src/enums/TokenStandards';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { ProductionEnygmaToken, ProductionEnygmaToken__factory } from '../../../../typechain-types';
import { initializePrivacyNodes } from '../../../setup';

describe('Enygma Token Lock Negative @token-operations-negative @hubless', function () {
  const userController = new UserController(BACKEND_OPS_URL, BACKEND_USER_AUTH_KEY);
  const operatorController = new OperatorController(BACKEND_OPS_URL, BACKEND_OPERATOR_AUTH_KEY);

  beforeEach('Deploy Enygma token on privacy ledger node', async function (this: Mocha.Context) {
    this.timeout(DEFAULT_TIMEOUT);
    // Enygma lock negatives — deploy + ops-api rejection only, never mints/teleports. No hub.
    const initializedNodes = await initializePrivacyNodes(1);
    this.privacyNodes = initializedNodes;

    const token = new EnygmaWrapper<ProductionEnygmaToken>(this.privacyNodes.A, ProductionEnygmaToken__factory);
    this.tokenModel = token.setFields(randomSuffix(this.currentTest?.fullTitle()));
    this.tokenInstance = await this.tokenModel.deploy();
    this.tokenAddressInPLA = await this.tokenInstance.getAddress();

    this.tokenModel.address[this.privacyNodes.A.chainId] = this.tokenAddressInPLA;
  });

  describe('Enygma lock request validation', function () {

    it('Should revert Enygma lock without amount', async function (this: Mocha.Context) {
      const lockRequest: ITokenLockRequest = {
        from: this.tokenAddressInPLA,
        standard: TokenStandards.ENYGMA,
        to: this.tokenAddressInPLA,
      };
      await nodeAssert.rejects(
        userController.teleport(this.tokenAddressInPLA, lockRequest),
        (e: any) => e instanceof BackendError && (
          [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
        )
      );
    });

    it('Should revert Enygma lock without tokenId', async function (this: Mocha.Context) {
      const lockRequest = {
        amount: '1000',
        from: this.tokenAddressInPLA,
        standard: TokenStandards.ENYGMA,
        to: this.tokenAddressInPLA,
      };
      await nodeAssert.rejects(
        userController.teleport(this.tokenAddressInPLA, lockRequest as any),
        (e: any) => e instanceof BackendError && (
          [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
        )
      );
    });

    it('Should revert Enygma lock with amount and tokenId', async function (this: Mocha.Context) {
      const lockRequest = {
        amount: '1000',
        tokenId: '1',
        from: this.tokenAddressInPLA,
        standard: TokenStandards.ENYGMA,
        to: this.tokenAddressInPLA,
      };
      await nodeAssert.rejects(
        userController.teleport(this.tokenAddressInPLA, lockRequest as any),
        (e: any) => e instanceof BackendError && (
          [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
        )
      );
    });
  });

  describe('Enygma locking negative scenarios', function () {

    beforeEach('Onboard and approve user', async function (this: Mocha.Context) {
      this.timeout(DEFAULT_TIMEOUT);
      this.InitialAddressPair = await onboardUserAndUpdateStatus(
        userController, operatorController,
        OnboardingStatus.APPROVED,
        { onUserId: (id) => { this.ApprovalUserId = id; } },
      );
    });

    it('Should revert locking unregistered Enygma token', async function (this: Mocha.Context) {
      const lockRequest = {
        amount: '1000',
        from: this.InitialAddressPair.private_chain_address,
        standard: this.tokenModel.standard,
        to: this.InitialAddressPair.public_chain_address,
      };

      await nodeAssert.rejects(
        userController.teleport(this.tokenAddressInPLA, lockRequest as any),
        (e: any) => e instanceof BackendError && (
          [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
        )
      );
    });

    it('Should revert locking a rejected Enygma token', async function (this: Mocha.Context) {
      await registerTokenAndUpdateStatus(userController, operatorController,
        this.tokenAddressInPLA,
        TokenStatus.UNAUTHORIZED
      );

      const lockRequest = {
        amount: '1000',
        from: this.InitialAddressPair.private_chain_address,
        standard: this.tokenModel.standard,
        to: this.InitialAddressPair.public_chain_address,
      };

      await nodeAssert.rejects(
        userController.teleport(this.tokenAddressInPLA, lockRequest as any),
        (e: any) => e instanceof BackendError && (
          [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
        )
      );
    });

    it('Should revert locking a pending Enygma token', async function (this: Mocha.Context) {
      await registerToken(userController,
        this.tokenAddressInPLA,
      );

      const lockRequest = {
        amount: '1000',
        from: this.InitialAddressPair.private_chain_address,
        standard: this.tokenModel.standard,
        to: this.InitialAddressPair.public_chain_address,
      };

      await nodeAssert.rejects(
        userController.teleport(this.tokenAddressInPLA, lockRequest as any),
        (e: any) => e instanceof BackendError && (
          [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
        )
      );
    });

    [OnboardingStatus.REJECTED, OnboardingStatus.PENDING].forEach(status => {
      it(`Should revert Enygma token lock with address pairs status = ${status}`, async function (this: Mocha.Context) {
        await registerTokenAndUpdateStatus(userController, operatorController,
          this.tokenAddressInPLA,
          TokenStatus.AUTHORIZED
        );

        // Second transition on the beforeEach-approved pair: it left the admin pending list at approval,
        // so reuse the cached userId (ops-api accepts reverting to PENDING as well as REJECTED).
        await updateOnboardingStatus(operatorController,
          this.InitialAddressPair, status, { userId: this.ApprovalUserId });

        const lockRequest = {
          amount: '1000',
          from: this.InitialAddressPair.private_chain_address,
          standard: this.tokenModel.standard,
          to: this.InitialAddressPair.public_chain_address,
        };

        await nodeAssert.rejects(
          userController.teleport(this.tokenAddressInPLA, lockRequest as any),
          (e: any) => e instanceof BackendError && (
            [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
          )
        );
      }).timeout(60000);
    });
  });
});
