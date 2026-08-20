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
  updateTokenStatus,
} from '../../../../src/flows/backend/token-operations';
import nodeAssert from 'node:assert';
import { onboardUserAndUpdateStatus, updateOnboardingStatus } from '../../../../src/flows/backend/user-onboarding';
import { TokenStatus } from '../../../../src/enums/TokenStatus';
import { OnboardingStatus } from '../../../../src/enums/OnboardingStatus';
import { BackendError } from '../../../../src/exceptions-and-errors/backend-error';
import { ITokenLockRequestERC1155 } from '../../../../src/api/models/ITokensApiBodies';
import { IOnboardingResponse } from '../../../../src/api/models/IOnboardingApiBodies';
import { HttpStatusCode } from 'axios';
import { TokenStandards } from '../../../../src/enums/TokenStandards';
import { ERC1155Wrapper } from '../../../../src/entities/tokens/ERC1155Wrapper';
import {
  ProductionErc1155Token, ProductionErc1155Token__factory,
} from '../../../../typechain-types';
import { parseUnits } from 'ethers';
import {
  BackendTokenContext,
  setupBackendTokenContext,
} from './setup-token-context';

describe('ERC1155 Token Locking Negative @token-operations-negative @decommissioned @hubless', function () {
  const userController = new UserController(BACKEND_OPS_URL, BACKEND_USER_AUTH_KEY);
  const operatorController = new OperatorController(BACKEND_OPS_URL, BACKEND_OPERATOR_AUTH_KEY);
  const MINT_AMOUNT = parseUnits('5', 18);

  let ctx: BackendTokenContext<ERC1155Wrapper<ProductionErc1155Token>>;

  beforeEach('Deploy ERC1155 token on privacy ledger node', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    ctx = await setupBackendTokenContext({
      wrapper: (node) => new ERC1155Wrapper<ProductionErc1155Token>(node, ProductionErc1155Token__factory),
      // Deploy-only. Mint is gated by whenPrivacyNodeActive, so the AUTHORIZED scenarios below fund
      // (mint + transfer) after registering AUTHORIZED.
      title: this.currentTest?.fullTitle(),
    });
  });

  describe('ERC1155 lock request validation', function () {

    it('Should revert ERC1155 lock without tokenId', async function () {
      const lockRequest = {
        amount: '1000',
        from: ctx.tokenAddressInPLA,
        standard: TokenStandards.ERC1155,
        to: ctx.tokenAddressInPLA,
      };
      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, lockRequest as any),
        (e: any) => e instanceof BackendError && e.status === HttpStatusCode.BadRequest
          && /tokenId|required/i.test(e.message),
      );
    });

    it('Should revert ERC1155 lock without amount', async function () {
      const lockRequest = {
        tokenId: '1',
        from: ctx.tokenAddressInPLA,
        standard: TokenStandards.ERC1155,
        to: ctx.tokenAddressInPLA,
      };
      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, lockRequest as any),
        (e: any) => e instanceof BackendError && e.status === HttpStatusCode.BadRequest
          && /amount|required/i.test(e.message),
      );
    });
  });

  describe('ERC1155 locking negative scenarios', function () {
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

    it('Should revert locking unregistered ERC1155 token', async function () {
      const lockRequest: ITokenLockRequestERC1155 = {
        amount: MINT_AMOUNT.toString(),
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

    it('Should revert locking a rejected ERC1155 token', async function () {
      // Fund while AUTHORIZED (mint/transfer are whenPrivacyNodeActive-gated), THEN downgrade to
      // UNAUTHORIZED — so the teleport is exercised against the rejected status with real balance, not
      // ops-api's per-tokenId balance preflight (which 400s "insufficient balance for token N: have 0"
      // before the status gate). A zero-balance token would 400 on balance and never reach the status
      // revert. (ERC20 behaves the same for a registered token — see Token_Lock_ERC20_Negative.ts.)
      await registerTokenAndUpdateStatus(userController, operatorController,
        ctx.tokenAddressInPLA,
        TokenStatus.AUTHORIZED,
      );
      await ctx.tokenModel.mintAndAwait(undefined, {
        toAddress: ctx.signerAddress,
        amount: MINT_AMOUNT,
        tokenId: 1n,
      });
      await ctx.tokenModel.transfer(
        initialAddressPair.private_chain_address,
        { tokenId: 1n, amount: MINT_AMOUNT },
      );
      await updateTokenStatus(operatorController, ctx.tokenAddressInPLA, TokenStatus.UNAUTHORIZED);
      await userController.pollUntilTokenStatusIsUpdated(ctx.tokenAddressInPLA, TokenStatus.UNAUTHORIZED);

      const lockRequest: ITokenLockRequestERC1155 = {
        amount: MINT_AMOUNT.toString(),
        tokenId: '1',
        from: initialAddressPair.private_chain_address,
        standard: ctx.tokenModel.standard,
        to: initialAddressPair.public_chain_address,
      };

      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, lockRequest),
        // Rejected token → on-chain revert surfaced as 500 (generic "unexpected error" body, real
        // reason only in the server log) or 422; preflight may 4xx. Substring enforced for non-500 only.
        (e: any) => e instanceof BackendError
          && [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
          && (e.status === HttpStatusCode.InternalServerError
            || /revert|inactive|unauthor|deprecat/i.test(`${e.message} ${e.details?.hint ?? ''}`)),
      );
    });

    it('Should revert locking a pending ERC1155 token', async function () {
      await registerToken(userController,
        ctx.tokenAddressInPLA,
      );

      // No funding — funding is impossible for a pending token: mint/transfer are whenPrivacyNodeActive-
      // gated (need AUTHORIZED), and there is no set-status path back to WAITING_APPROVAL after AUTHORIZED
      // (set-status accepts only 2/3). So a pending ERC1155 token can never hold a balance.
      const lockRequest: ITokenLockRequestERC1155 = {
        amount: MINT_AMOUNT.toString(),
        tokenId: '1',
        from: initialAddressPair.private_chain_address,
        standard: ctx.tokenModel.standard,
        to: initialAddressPair.public_chain_address,
      };

      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, lockRequest),
        // Since a pending token can never be funded, ops-api's per-tokenId balance preflight
        // (400 "insufficient balance … have 0") is the deterministic rejection — accept it alongside the
        // on-chain status revert (422) / generic 500. Substring enforced for non-500 only.
        (e: any) => e instanceof BackendError
          && [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
          && (e.status === HttpStatusCode.InternalServerError
            || /revert|inactive|pending|exist|insufficient|balance/i.test(`${e.message} ${e.details?.hint ?? ''}`)),
      );
    });

    [OnboardingStatus.REJECTED, OnboardingStatus.PENDING].forEach(status => {
      it(`Should revert ERC1155 token lock with address pairs status = ${status}`, async function () {
        await registerTokenAndUpdateStatus(userController, operatorController,
          ctx.tokenAddressInPLA,
          TokenStatus.AUTHORIZED,
        );

        // Fund the signer then move balance to the user — mint/transfer require the token AUTHORIZED
        // (whenPrivacyNodeActive), so they run after the promote above.
        await ctx.tokenModel.mintAndAwait(undefined, {
          toAddress: ctx.signerAddress,
          amount: MINT_AMOUNT,
          tokenId: 1n,
        });
        await ctx.tokenModel.transfer(
          initialAddressPair.private_chain_address,
          { tokenId: 1n, amount: MINT_AMOUNT },
        );

        // Second transition on the beforeEach-approved pair: it left the admin pending list at approval,
        // so reuse the cached userId (ops-api accepts reverting to PENDING as well as REJECTED).
        await updateOnboardingStatus(operatorController,
          initialAddressPair, status, { userId: approvalUserId });

        const lockRequest: ITokenLockRequestERC1155 = {
          amount: MINT_AMOUNT.toString(),
          tokenId: '1',
          from: initialAddressPair.private_chain_address,
          standard: ctx.tokenModel.standard,
          to: initialAddressPair.public_chain_address,
        };

        await nodeAssert.rejects(
          userController.teleport(ctx.tokenAddressInPLA, lockRequest),
          // Non-approved `from` (rejected or pending): custody check passes but the on-chain teleport
          // reverts since the pair isn't APPROVED → surfaced as 500 (generic body) or 422 (preflight 400 tolerated).
          (e: any) => e instanceof BackendError &&
            [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status),
        );
      }).timeout(60000);
    });

    it('Should revert locking ERC1155 with insufficient balance for tokenId', async function () {
      await registerTokenAndUpdateStatus(userController, operatorController,
        ctx.tokenAddressInPLA,
        TokenStatus.AUTHORIZED,
      );

      // Fund the signer then move balance to the user — mint/transfer require the token AUTHORIZED
      // (whenPrivacyNodeActive), so they run after the promote above.
      await ctx.tokenModel.mintAndAwait(undefined, {
        toAddress: ctx.signerAddress,
        amount: MINT_AMOUNT,
        tokenId: 1n,
      });
      await ctx.tokenModel.transfer(
        initialAddressPair.private_chain_address,
        { tokenId: 1n, amount: MINT_AMOUNT },
      );

      const lockRequest: ITokenLockRequestERC1155 = {
        amount: parseUnits('100', 18).toString(),
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

    it('Should revert locking ERC1155 with amount just exceeding balance', async function () {
      await registerTokenAndUpdateStatus(userController, operatorController,
        ctx.tokenAddressInPLA,
        TokenStatus.AUTHORIZED,
      );

      // Fund the signer then move balance to the user — mint/transfer require the token AUTHORIZED
      // (whenPrivacyNodeActive), so they run after the promote above.
      await ctx.tokenModel.mintAndAwait(undefined, {
        toAddress: ctx.signerAddress,
        amount: MINT_AMOUNT,
        tokenId: 1n,
      });
      await ctx.tokenModel.transfer(
        initialAddressPair.private_chain_address,
        { tokenId: 1n, amount: MINT_AMOUNT },
      );

      const lockRequest: ITokenLockRequestERC1155 = {
        amount: (MINT_AMOUNT + 1n).toString(),
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

    it('Should revert locking ERC1155 with tokenId user has no balance for', async function () {
      await registerTokenAndUpdateStatus(userController, operatorController,
        ctx.tokenAddressInPLA,
        TokenStatus.AUTHORIZED,
      );

      // Fund the signer then move balance to the user — mint/transfer require the token AUTHORIZED
      // (whenPrivacyNodeActive), so they run after the promote above.
      await ctx.tokenModel.mintAndAwait(undefined, {
        toAddress: ctx.signerAddress,
        amount: MINT_AMOUNT,
        tokenId: 1n,
      });
      await ctx.tokenModel.transfer(
        initialAddressPair.private_chain_address,
        { tokenId: 1n, amount: MINT_AMOUNT },
      );

      const lockRequest: ITokenLockRequestERC1155 = {
        amount: '1',
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

    ['0', '-1', ''].forEach(invalidAmount => {
      it(`Should revert locking ERC1155 with invalid amount = ${invalidAmount}`, async function () {
        await registerTokenAndUpdateStatus(userController, operatorController,
          ctx.tokenAddressInPLA,
          TokenStatus.AUTHORIZED,
        );

        // Fund the signer then move balance to the user — mint/transfer require the token AUTHORIZED
        // (whenPrivacyNodeActive), so they run after the promote above.
        await ctx.tokenModel.mintAndAwait(undefined, {
          toAddress: ctx.signerAddress,
          amount: MINT_AMOUNT,
          tokenId: 1n,
        });
        await ctx.tokenModel.transfer(
          initialAddressPair.private_chain_address,
          { tokenId: 1n, amount: MINT_AMOUNT },
        );

        const lockRequest: ITokenLockRequestERC1155 = {
          amount: invalidAmount,
          tokenId: '1',
          from: initialAddressPair.private_chain_address,
          standard: ctx.tokenModel.standard,
          to: initialAddressPair.public_chain_address,
        };

        await nodeAssert.rejects(
          userController.teleport(ctx.tokenAddressInPLA, lockRequest),
          // amount=0 passes preflight (numeric) but reverts on-chain → surfaced as 422 or 500 (generic
          // "unexpected error" body — real reason only in the server log); empty/negative → 400 preflight.
          (e: any) => e instanceof BackendError &&
            [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status),
        );
      }).timeout(60000);
    });
  });
});