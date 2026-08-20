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
import { ITokenLockRequest, ITokenLockRequestERC20 } from '../../../../src/api/models/ITokensApiBodies';
import { IOnboardingResponse } from '../../../../src/api/models/IOnboardingApiBodies';
import { HttpStatusCode } from 'axios';
import { TokenStandards } from '../../../../src/enums/TokenStandards';
import { ERC20Wrapper } from '../../../../src/entities/tokens/ERC20Wrapper';
import { ProductionErc20Token, ProductionErc20Token__factory } from '../../../../typechain-types';
import { parseUnits } from 'ethers';
import {
  BackendTokenContext,
  setupBackendTokenContext,
} from './setup-token-context';

describe('ERC20 Token Teleport Negative @token-operations-negative @decommissioned @hubless', function () {
  const userController = new UserController(BACKEND_OPS_URL, BACKEND_USER_AUTH_KEY);
  const operatorController = new OperatorController(BACKEND_OPS_URL, BACKEND_OPERATOR_AUTH_KEY);
  const TRANSFER_AMOUNT = parseUnits('20', 18);

  let ctx: BackendTokenContext<ERC20Wrapper<ProductionErc20Token>>;

  beforeEach(`Deploy ERC20 token on privacy ledger node`, async function () {
    this.timeout(DEFAULT_TIMEOUT);
    ctx = await setupBackendTokenContext({
      wrapper: (node) => new ERC20Wrapper<ProductionErc20Token>(node, ProductionErc20Token__factory),
      // Deploy-only — negative scenarios provide their own balance/mint as needed.
      title: this.currentTest?.fullTitle(),
    });
  });

  describe('Token teleport request validation', function () {

    it('Should revert teleport with invalid standard', async function () {
      const teleportRequest = {
        amount: '1000',
        from: ctx.tokenAddressInPLA,
        standard: 99,
        to: ctx.tokenAddressInPLA,
      };
      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, teleportRequest as any),
        (e: any) => e instanceof BackendError && e.status === HttpStatusCode.BadRequest
          && /standard|invalid/i.test(e.message),
      );
    });

    it('Should revert ERC20 teleport without amount', async function () {
      const teleportRequest: ITokenLockRequest = {
        from: ctx.tokenAddressInPLA,
        standard: TokenStandards.ERC20,
        to: ctx.tokenAddressInPLA,
      };
      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, teleportRequest),
        (e: any) => e instanceof BackendError && e.status === HttpStatusCode.BadRequest
          && /amount|required/i.test(e.message),
      );
    });

    it('Should revert teleport with non-numeric amount', async function () {
      const teleportRequest: ITokenLockRequestERC20 = {
        amount: 'abc',
        from: ctx.tokenAddressInPLA,
        standard: TokenStandards.ERC20,
        to: ctx.tokenAddressInPLA,
      };
      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, teleportRequest),
        (e: any) => e instanceof BackendError && (
          [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
        ),
      );
    });

    it('Should revert teleport with empty from address', async function () {
      const teleportRequest: ITokenLockRequestERC20 = {
        amount: '1000',
        from: '',
        standard: TokenStandards.ERC20,
        to: ctx.tokenAddressInPLA,
      };
      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, teleportRequest),
        (e: any) => e instanceof BackendError && e.status === HttpStatusCode.BadRequest,
      );
    });

    it('Should revert teleport with zero address as token', async function () {
      const teleportRequest: ITokenLockRequestERC20 = {
        amount: '1000',
        from: ctx.tokenAddressInPLA,
        standard: TokenStandards.ERC20,
        to: ctx.tokenAddressInPLA,
      };
      await nodeAssert.rejects(
        // Zero-address token is the path param now (no contract code at that address).
        userController.teleport('0x0000000000000000000000000000000000000000', teleportRequest),
        // TODO: tighten to 400 once the EnsureCode preflight is observed.
        (e: any) => e instanceof BackendError && (
          [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
        ),
      );
    });

    it('Should revert teleport when from and to are the same address', async function () {
      const teleportRequest: ITokenLockRequestERC20 = {
        amount: '1000',
        from: ctx.tokenAddressInPLA,
        standard: TokenStandards.ERC20,
        to: ctx.tokenAddressInPLA,
      };
      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, teleportRequest),
        (e: any) => e instanceof BackendError && (
          [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
        ),
      );
    });
  });

  describe('ERC20 teleport negative scenarios', function () {
    let approvalUserId: string;
    let initialAddressPair: IOnboardingResponse;

    beforeEach('Onboard and approve user', async function () {
      this.timeout(DEFAULT_TIMEOUT);
      initialAddressPair = await onboardUserAndUpdateStatus(
        userController,
        operatorController,
        OnboardingStatus.APPROVED,
        { onUserId: (id) => { approvalUserId = id; } },
      );
      // No mint here: mint/transfer are gated by whenPrivacyNodeActive, so funding can only happen
      // AFTER the token is AUTHORIZED. Scenarios that need a funded user mint after registering
      // AUTHORIZED; scenarios that keep the token unregistered/unauthorized/pending don't fund
      // (the teleport reverts on the token/pair state regardless of balance).
    });

    ['', '0', '-10', TRANSFER_AMOUNT + 1n, '90000000000000000000000000'].forEach(invalidAmount => {
      it(`Should revert teleport with invalid amount = ${invalidAmount}`, async function () {
        await registerTokenAndUpdateStatus(userController, operatorController,
          ctx.tokenAddressInPLA,
          TokenStatus.AUTHORIZED,
        );

        // Fund the signer then move balance to the user — both mint and transfer require the token
        // AUTHORIZED (whenPrivacyNodeActive), so they run after the promote above.
        await ctx.tokenModel.mintAndAwait(undefined, {
          toAddress: ctx.signerAddress,
          amount: TRANSFER_AMOUNT,
        });
        await ctx.tokenModel.transfer(
          initialAddressPair.private_chain_address,
          { amount: TRANSFER_AMOUNT },
        );

        const teleportRequest: ITokenLockRequestERC20 = {
          amount: invalidAmount.toString(),
          from: initialAddressPair.private_chain_address,
          standard: ctx.tokenModel.standard,
          to: initialAddressPair.public_chain_address,
        };

        await nodeAssert.rejects(
          userController.teleport(ctx.tokenAddressInPLA, teleportRequest),
          // Invalid amount may be rejected at preflight (400) or as an on-chain revert (422).
          // TODO: tighten to the observed status.
          (e: any) => e instanceof BackendError &&
            [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status),
        );
      }).timeout(60000);
    });

    it(`Should revert teleport of unregistered ERC20 token`, async function () {
      const teleportRequest: ITokenLockRequestERC20 = {
        amount: TRANSFER_AMOUNT.toString(),
        from: initialAddressPair.private_chain_address,
        standard: ctx.tokenModel.standard,
        to: initialAddressPair.public_chain_address,
      };

      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, teleportRequest),
        // Preflight rejection for an unregistered token — documented ops-api contract is 4xx
        // (`inactive`/`exist`). `< 500` keeps a real 500 crash red instead of passing silently.
        (e: any) => e instanceof BackendError && e.status >= 400 && e.status < 500
          && /inactive|exist|regist|not found|lock|teleport/i.test(`${e.message} ${e.details?.hint ?? ''}`),
      );
    });

    it('Should revert teleport of an unauthorized token', async function () {
      // Fund while AUTHORIZED (mint/transfer are whenPrivacyNodeActive-gated), THEN downgrade to
      // UNAUTHORIZED — so the teleport is exercised against the rejected status with real balance. ops-api
      // balance-preflights a registered token (400 "insufficient balance: have 0") BEFORE the status gate,
      // so a zero-balance UNAUTHORIZED token would 400 on balance and never reach the status revert.
      await registerTokenAndUpdateStatus(userController, operatorController,
        ctx.tokenAddressInPLA,
        TokenStatus.AUTHORIZED,
      );
      await ctx.tokenModel.mintAndAwait(undefined, {
        toAddress: ctx.signerAddress,
        amount: TRANSFER_AMOUNT,
      });
      await ctx.tokenModel.transfer(
        initialAddressPair.private_chain_address,
        { amount: TRANSFER_AMOUNT },
      );
      await updateTokenStatus(operatorController, ctx.tokenAddressInPLA, TokenStatus.UNAUTHORIZED);
      await userController.pollUntilTokenStatusIsUpdated(ctx.tokenAddressInPLA, TokenStatus.UNAUTHORIZED);

      const teleportRequest: ITokenLockRequestERC20 = {
        amount: TRANSFER_AMOUNT.toString(),
        from: initialAddressPair.private_chain_address,
        standard: ctx.tokenModel.standard,
        to: initialAddressPair.public_chain_address,
      };

      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, teleportRequest),
        // Unauthorized token → on-chain revert surfaced as 500 (generic "unexpected error" body, real
        // reason only in the server log) or 422; preflight may 4xx. Substring enforced for non-500 only.
        (e: any) => e instanceof BackendError
          && [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
          && (e.status === HttpStatusCode.InternalServerError
            || /revert|inactive|unauthor/i.test(`${e.message} ${e.details?.hint ?? ''}`)),
      );
    });

    it('Should revert teleport of a pending token', async function () {
      await registerToken(userController,
        ctx.tokenAddressInPLA,
      );

      // No funding — funding is impossible for a pending token: mint/transfer are whenPrivacyNodeActive-
      // gated (need AUTHORIZED), and there is no set-status path back to WAITING_APPROVAL after AUTHORIZED
      // (set-status accepts only 2/3). So a pending ERC20 token can never hold a balance.
      const teleportRequest: ITokenLockRequestERC20 = {
        amount: TRANSFER_AMOUNT.toString(),
        from: initialAddressPair.private_chain_address,
        standard: ctx.tokenModel.standard,
        to: initialAddressPair.public_chain_address,
      };

      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, teleportRequest),
        // Since a pending token can never be funded, ops-api's balance preflight (400 "insufficient
        // balance: have 0") is the deterministic rejection — accept it alongside the on-chain status
        // revert (422) / generic 500. Substring enforced for non-500 only.
        (e: any) => e instanceof BackendError
          && [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
          && (e.status === HttpStatusCode.InternalServerError
            || /revert|inactive|pending|exist|insufficient|balance/i.test(`${e.message} ${e.details?.hint ?? ''}`)),
      );
    });

    [OnboardingStatus.REJECTED, OnboardingStatus.PENDING].forEach(status => {
      it(`Should revert teleport with address pairs status = ${status}`, async function () {
        await registerTokenAndUpdateStatus(userController, operatorController,
          ctx.tokenAddressInPLA,
          TokenStatus.AUTHORIZED,
        );

        // Fund the user (mint + transfer require the token AUTHORIZED) so the teleport reaches the
        // pair-not-approved revert rather than failing on a zero balance.
        await ctx.tokenModel.mintAndAwait(undefined, {
          toAddress: ctx.signerAddress,
          amount: TRANSFER_AMOUNT,
        });
        await ctx.tokenModel.transfer(
          initialAddressPair.private_chain_address,
          { amount: TRANSFER_AMOUNT },
        );

        // Second transition on the beforeEach-approved pair: it left the admin pending list at approval,
        // so reuse the cached userId (ops-api accepts reverting to PENDING as well as REJECTED).
        await updateOnboardingStatus(operatorController,
          initialAddressPair, status, { userId: approvalUserId });

        const teleportRequest: ITokenLockRequestERC20 = {
          amount: TRANSFER_AMOUNT.toString(),
          from: initialAddressPair.private_chain_address,
          standard: ctx.tokenModel.standard,
          to: initialAddressPair.public_chain_address,
        };

        await nodeAssert.rejects(
          userController.teleport(ctx.tokenAddressInPLA, teleportRequest),
          // Non-approved `from` (rejected or pending): custody check passes (is_active stays true) but
          // the on-chain teleport reverts since the pair isn't APPROVED → surfaced as 500 (generic body)
          // or 422 (preflight 400 tolerated).
          (e: any) => e instanceof BackendError &&
            [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status),
        );
      }).timeout(60000);
    });
  });
});
