/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
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
import { BackendError } from '../../../../src/exceptions-and-errors/backend-error';
import { ITokenLockRequest, ITokenLockRequestERC721 } from '../../../../src/api/models/ITokensApiBodies';
import { IOnboardingResponse } from '../../../../src/api/models/IOnboardingApiBodies';
import { HttpStatusCode } from 'axios';
import { TokenStandards } from '../../../../src/enums/TokenStandards';
import { ERC721Wrapper } from '../../../../src/entities/tokens/ERC721Wrapper';
import {
  ProductionErc721Token, ProductionErc721Token__factory,
} from '../../../../typechain-types';
import {
  BackendTokenContext,
  setupBackendTokenContext,
} from './setup-token-context';

describe('ERC721 Token Locking Negative @token-operations-negative @decommissioned @hubless', function () {
  const userController = new UserController(BACKEND_OPS_URL, BACKEND_USER_AUTH_KEY);
  const operatorController = new OperatorController(BACKEND_OPS_URL, BACKEND_OPERATOR_AUTH_KEY);

  let ctx: BackendTokenContext<ERC721Wrapper<ProductionErc721Token>>;

  beforeEach('Deploy ERC721 token on privacy ledger node', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    ctx = await setupBackendTokenContext({
      wrapper: (node) => new ERC721Wrapper<ProductionErc721Token>(node, ProductionErc721Token__factory),
      // Deploy-only. Mint is gated by whenPrivacyNodeActive, so scenarios that need a minted token
      // mint after registering AUTHORIZED (see "not owned by user").
      title: this.currentTest?.fullTitle(),
    });
  });

  describe('ERC721 lock request validation', function () {

    it('Should revert ERC721 lock without tokenId', async function () {
      const lockRequest: ITokenLockRequest = {
        from: ctx.tokenAddressInPLA,
        standard: TokenStandards.ERC721,
        to: ctx.tokenAddressInPLA,
      };
      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, lockRequest),
        (e: any) => e instanceof BackendError && e.status === HttpStatusCode.BadRequest
          && /tokenId|required/i.test(e.message),
      );
    });

    it('Should revert lock with non-numeric tokenId', async function () {
      const lockRequest: ITokenLockRequestERC721 = {
        tokenId: 'xyz',
        from: ctx.tokenAddressInPLA,
        standard: TokenStandards.ERC721,
        to: ctx.tokenAddressInPLA,
      };
      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, lockRequest),
        (e: any) => e instanceof BackendError && (
          [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
        ),
      );
    });
  });

  describe('ERC721 locking negative scenarios', function () {
    let approvalUserId: string;
    let initialAddressPair: IOnboardingResponse;

    beforeEach('Onboard and approve user', async function () {
      this.timeout(DEFAULT_TIMEOUT);
      initialAddressPair = await onboardUserAndUpdateStatus(
        userController, operatorController,
        OnboardingStatus.APPROVED,
        { onUserId: (id) => { approvalUserId = id; } },
      );
    });

    it('Should revert locking unregistered ERC721 token', async function () {
      const lockRequest: ITokenLockRequestERC721 = {
        tokenId: '1',
        from: initialAddressPair.private_chain_address,
        standard: ctx.tokenModel.standard,
        to: initialAddressPair.public_chain_address,
      };

      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, lockRequest),
        // Preflight rejection for an unregistered token — documented ops-api contract is 4xx
        // (`inactive`/`exist`). `< 500` keeps a real 500 crash red instead of passing silently.
        (e: any) => e instanceof BackendError && e.status >= 400 && e.status < 500
          && /inactive|exist|regist|not found|lock|teleport/i.test(`${e.message} ${e.details?.hint ?? ''}`),
      );
    });

    it('Should revert locking a rejected ERC721 token', async function () {
      await registerTokenAndUpdateStatus(userController, operatorController,
        ctx.tokenAddressInPLA,
        TokenStatus.UNAUTHORIZED,
      );

      const lockRequest: ITokenLockRequestERC721 = {
        tokenId: '1',
        from: initialAddressPair.private_chain_address,
        standard: ctx.tokenModel.standard,
        to: initialAddressPair.public_chain_address,
      };

      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, lockRequest),
        (e: any) => e instanceof BackendError && (
          [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
        ),
      );
    });

    it('Should revert locking a pending ERC721 token', async function () {
      await registerToken(userController,
        ctx.tokenAddressInPLA,
      );

      const lockRequest: ITokenLockRequestERC721 = {
        tokenId: '1',
        from: initialAddressPair.private_chain_address,
        standard: ctx.tokenModel.standard,
        to: initialAddressPair.public_chain_address,
      };

      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, lockRequest),
        (e: any) => e instanceof BackendError && (
          [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
        ),
      );
    });

    [OnboardingStatus.REJECTED, OnboardingStatus.PENDING].forEach(status => {
      it(`Should revert ERC721 token lock with address pairs status = ${status}`, async function () {
        await registerTokenAndUpdateStatus(userController, operatorController,
          ctx.tokenAddressInPLA,
          TokenStatus.AUTHORIZED,
        );

        // Second transition on the beforeEach-approved pair: it left the admin pending list at approval,
        // so reuse the cached userId (ops-api accepts reverting to PENDING as well as REJECTED).
        await updateOnboardingStatus(operatorController,
          initialAddressPair, status, { userId: approvalUserId });

        const lockRequest: ITokenLockRequestERC721 = {
          tokenId: '1',
          from: initialAddressPair.private_chain_address,
          standard: ctx.tokenModel.standard,
          to: initialAddressPair.public_chain_address,
        };

        await nodeAssert.rejects(
          userController.teleport(ctx.tokenAddressInPLA, lockRequest),
          (e: any) => e instanceof BackendError && (
            [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
          ),
        );
      }).timeout(60000);
    });

    it('Should revert locking ERC721 token not owned by user', async function () {
      await registerTokenAndUpdateStatus(userController, operatorController,
        ctx.tokenAddressInPLA,
        TokenStatus.AUTHORIZED,
      );

      // Mint tokenId 1 to the signer (NOT the user) — mint is gated by whenPrivacyNodeActive, so it
      // runs after the promote. Never transferred to the user's private_chain_address, so the user's
      // lock attempt reverts (not the owner).
      await ctx.tokenModel.mintAndAwait(undefined, {
        toAddress: ctx.signerAddress,
        tokenId: 1n,
      });

      const lockRequest: ITokenLockRequestERC721 = {
        tokenId: '1',
        from: initialAddressPair.private_chain_address,
        standard: ctx.tokenModel.standard,
        to: initialAddressPair.public_chain_address,
      };

      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, lockRequest),
        (e: any) => e instanceof BackendError && (
          [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
        ),
      );
    }).timeout(60000);

    it('Should revert locking ERC721 with non-existent tokenId', async function () {
      await registerTokenAndUpdateStatus(userController, operatorController,
        ctx.tokenAddressInPLA,
        TokenStatus.AUTHORIZED,
      );

      // tokenId=999 was never minted
      const lockRequest: ITokenLockRequestERC721 = {
        tokenId: '999',
        from: initialAddressPair.private_chain_address,
        standard: ctx.tokenModel.standard,
        to: initialAddressPair.public_chain_address,
      };

      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, lockRequest),
        (e: any) => e instanceof BackendError && (
          [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
        ),
      );
    }).timeout(60000);

    ['0', '-1', ''].forEach(invalidTokenId => {
      it(`Should revert locking ERC721 with invalid tokenId = "${invalidTokenId}"`, async function () {
        await registerTokenAndUpdateStatus(userController, operatorController,
          ctx.tokenAddressInPLA,
          TokenStatus.AUTHORIZED,
        );

        const lockRequest: ITokenLockRequestERC721 = {
          tokenId: invalidTokenId,
          from: initialAddressPair.private_chain_address,
          standard: ctx.tokenModel.standard,
          to: initialAddressPair.public_chain_address,
        };

        await nodeAssert.rejects(
          userController.teleport(ctx.tokenAddressInPLA, lockRequest),
          (e: any) => e instanceof BackendError && (
            [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
          ),
        );
      }).timeout(60000);
    });
  });
});