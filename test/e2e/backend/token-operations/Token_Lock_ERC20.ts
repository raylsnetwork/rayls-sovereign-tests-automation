/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
import { OperatorController, UserController } from '../../../../src/api';
import {
  BACKEND_OPS_URL,
  BACKEND_OPERATOR_AUTH_KEY,
  BACKEND_USER_AUTH_KEY,
  DEFAULT_TIMEOUT,
  LOGGER,
} from '../../../../src/config/env-config';
import { generateRandomHex } from '../../../../src/utils/generators';
import { eventually } from '../../../../src/utils/common';
import { shortHex } from '../../../../src/utils/formatters';
import { onboardUserAndUpdateStatus } from '../../../../src/flows/backend/user-onboarding';
import {
  teleportERC20,
  registerTokenAndUpdateStatus,
  submitTokenToPublicChain,
} from '../../../../src/flows/backend/token-operations';
import { ERC20Wrapper } from '../../../../src/entities/tokens/ERC20Wrapper';
import { ProductionErc20Token, ProductionErc20Token__factory } from '../../../../typechain-types';
import { OnboardingStatus } from '../../../../src/enums/OnboardingStatus';
import { TokenStatus } from '../../../../src/enums/TokenStatus';
import { parseUnits } from 'ethers';
import { expect } from 'chai';
import nodeAssert from 'node:assert';
import { BackendError } from '../../../../src/exceptions-and-errors/backend-error';
import { HttpStatusCode } from 'axios';
import {
  setupBackendTokenContext,
  setupTokenForUser,
  TokenForUserContext,
} from './setup-token-context';

describe('ERC20 Token Locking @token-locking @decommissioned @hubless', function () {
  const userController = new UserController(BACKEND_OPS_URL, BACKEND_USER_AUTH_KEY);
  const operatorController = new OperatorController(BACKEND_OPS_URL, BACKEND_OPERATOR_AUTH_KEY);
  const MINT_AMOUNT = parseUnits('20', 18);

  let ctx: TokenForUserContext<ERC20Wrapper<ProductionErc20Token>>;

  describe('ERC20 locking @token-lock-pos', function () {
    beforeEach('Deploy, onboard, register, fund user', async function () {
      this.timeout(DEFAULT_TIMEOUT);
      ctx = await setupTokenForUser({
        userController, operatorController,
        wrapper: (node) => new ERC20Wrapper<ProductionErc20Token>(node, ProductionErc20Token__factory),
        mint: { amount: MINT_AMOUNT },
        transfer: { amount: MINT_AMOUNT },
        title: this.currentTest?.fullTitle(),
      });
      // ERC20 needs the CTS-deployed public counterpart available before locks land.
      await ctx.tokenModel.getPublicAddress();
    });

    it('Should lock and send ERC20 token amount to public chain @smoke', async function () {
      await teleportERC20(userController, {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        amount: MINT_AMOUNT,
      });

      await ctx.tokenModel.verifyTokenExistsInGovernance(
        ctx.privacyNodes.A,
        ctx.tokenAddressInPLA,
      );

      await ctx.tokenModel.verifyPublicBalance(
        MINT_AMOUNT,
        ctx.addressPair.public_chain_address,
      );
    }).timeout(80000);

    it('Should lock partial ERC20 balance and verify remainder', async function () {
      const halfAmount = MINT_AMOUNT / 2n;

      await teleportERC20(userController, {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        amount: halfAmount,
      });

      await ctx.tokenModel.verifyPublicBalance(
        halfAmount,
        ctx.addressPair.public_chain_address,
      );

      // Verify remainder stays on private chain
      const privateBalance = await ctx.tokenModel.getBalanceOf(
        ctx.addressPair.private_chain_address,
      );
      expect(privateBalance).to.be.eq(halfAmount);
    }).timeout(80000);

    it('Should lock ERC20 tokens sequentially in two transactions', async function () {
      const halfAmount = MINT_AMOUNT / 2n;

      const lockParams = {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        amount: halfAmount,
      };

      await teleportERC20(userController, lockParams);

      // Wait for first lock to propagate to public chain before second lock
      await ctx.tokenModel.verifyPublicBalance(
        halfAmount,
        ctx.addressPair.public_chain_address,
      );

      await teleportERC20(userController, lockParams);

      // polling instead of verifyPublicBalance — the latter returns on first
      // truthy value (10e18 from 1st lock) instead of waiting for cumulative 20e18.
      const expectedTotal = MINT_AMOUNT;
      const publicAddr = ctx.addressPair.public_chain_address;
      const reached = await eventually<boolean>({
        check: async () => {
          const bal = await ctx.tokenModel.publicContract.balanceOf(publicAddr);
          LOGGER.info(`[SEQ LOCK] public balance: ${bal}, expected: ${expectedTotal}`);
          return bal === expectedTotal;
        },
        interval: 3000,
        attempts: 60,
        message: `Waiting for public balance for ${shortHex(publicAddr)} → ${expectedTotal} (sequential locks)`,
      });
      expect(reached, `Public balance did not reach ${expectedTotal}`).to.be.true;
    }).timeout(180000);

    it('Should return valid tx_hash from lock response', async function () {
      const txHash = await teleportERC20(userController, {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        amount: MINT_AMOUNT,
      });

      expect(txHash).to.be.a('string').that.is.not.empty;
      expect(txHash).to.match(/^0x[a-fA-F0-9]{64}$/);
    }).timeout(80000);
  });

  describe('ERC20 cross-operation scenarios @token-lock-cross', function () {

    it('Should lock immediately after token approval without checking token existence in governance', async function () {
      ctx = await setupTokenForUser({
        userController, operatorController,
        wrapper: (node) => new ERC20Wrapper<ProductionErc20Token>(node, ProductionErc20Token__factory),
        mint: { amount: MINT_AMOUNT },
        transfer: { amount: MINT_AMOUNT },
        title: this.test?.fullTitle(),
      });
      await ctx.tokenModel.getPublicAddress();

      // Lock immediately — no extra delay after approval
      await teleportERC20(userController, {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        amount: MINT_AMOUNT,
      });

      await ctx.tokenModel.verifyPublicBalance(
        MINT_AMOUNT,
        ctx.addressPair.public_chain_address,
      );
    }).timeout(120000);

    it('Should lock from two different address pairs independently', async function () {
      // Multi-pair: doesn't fit the single-user helper. Use setupBackendTokenContext
      // for deploy+mint, then register once and onboard+transfer+lock per pair.
      const baseCtx = await setupBackendTokenContext<ERC20Wrapper<ProductionErc20Token>>({
        wrapper: (node) => new ERC20Wrapper<ProductionErc20Token>(node, ProductionErc20Token__factory),
        title: this.test?.fullTitle(),
      });

      const halfAmount = MINT_AMOUNT / 2n;
      const lockOpts = { attempts: 10, delayMs: 5000 };

      // Workaround: the custody mock upserts wallets by sequential _id ("1","2"),
      // so each new onboarding overwrites the previous pair in mongo. Onboarding
      // and locking must complete per-pair before the next pair is onboarded.
      await registerTokenAndUpdateStatus(userController, operatorController,
        baseCtx.tokenAddressInPLA,
        TokenStatus.AUTHORIZED,
      );
      await submitTokenToPublicChain(operatorController, baseCtx.tokenAddressInPLA);
      // Fund the signer AFTER the token is AUTHORIZED (mint is gated by whenPrivacyNodeActive); the
      // per-pair transfers below draw from this balance.
      await baseCtx.tokenModel.mintAndAwait(undefined, {
        toAddress: baseCtx.signerAddress,
        amount: MINT_AMOUNT,
      });
      await baseCtx.tokenModel.getPublicAddress();

      const lockForPair = async () => {
        const pair = await onboardUserAndUpdateStatus(
          userController, operatorController, OnboardingStatus.APPROVED,
        );
        await baseCtx.tokenModel.transfer(pair.private_chain_address, { amount: halfAmount });
        await teleportERC20(userController, { pair, token: baseCtx.tokenAddressInPLA, amount: halfAmount }, lockOpts);
        return pair;
      };

      const pair1 = await lockForPair();
      const pair2 = await lockForPair();

      await baseCtx.tokenModel.verifyPublicBalance(halfAmount, pair1.public_chain_address);
      await baseCtx.tokenModel.verifyPublicBalance(halfAmount, pair2.public_chain_address);
    }).timeout(180000);
  });

  describe('ERC20 double-spend and balance integrity @token-lock-integrity', function () {
    beforeEach('Deploy, onboard, register, fund user', async function () {
      this.timeout(DEFAULT_TIMEOUT);
      ctx = await setupTokenForUser({
        userController, operatorController,
        wrapper: (node) => new ERC20Wrapper<ProductionErc20Token>(node, ProductionErc20Token__factory),
        mint: { amount: MINT_AMOUNT },
        transfer: { amount: MINT_AMOUNT },
        title: this.currentTest?.fullTitle(),
      });
      await ctx.tokenModel.getPublicAddress();
    });

    it('Should leave zero private balance after locking full amount', async function () {
      await teleportERC20(userController, {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        amount: MINT_AMOUNT,
      });

      await ctx.tokenModel.verifyPublicBalance(
        MINT_AMOUNT,
        ctx.addressPair.public_chain_address,
      );

      const privateBalance = await ctx.tokenModel.getBalanceOf(
        ctx.addressPair.private_chain_address,
      );
      expect(privateBalance).to.equal(0n);
    }).timeout(80000);

    it('Should revert second lock after full amount already locked', async function () {
      await teleportERC20(userController, {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        amount: MINT_AMOUNT,
      });

      // Second lock — no balance left. Direct API call: fail fast (failure expected).
      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, {
          from: ctx.addressPair.private_chain_address,
          to: ctx.addressPair.public_chain_address,
          standard: ctx.tokenModel.standard,
          amount: MINT_AMOUNT.toString(),
        }),
        (e: any) => e instanceof BackendError && (
          e.status === HttpStatusCode.BadRequest || e.status === HttpStatusCode.InternalServerError
        ),
      );
    }).timeout(120000);

    it('Should revert locking more than remaining balance after partial lock', async function () {
      const halfAmount = MINT_AMOUNT / 2n;

      await teleportERC20(userController, {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        amount: halfAmount,
      });

      // Try to lock the full amount again — only half remains. Direct API: fail fast.
      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, {
          from: ctx.addressPair.private_chain_address,
          to: ctx.addressPair.public_chain_address,
          standard: ctx.tokenModel.standard,
          amount: MINT_AMOUNT.toString(),
        }),
        (e: any) => e instanceof BackendError && (
          e.status === HttpStatusCode.BadRequest || e.status === HttpStatusCode.InternalServerError
        ),
      );

      // Original partial lock balance should still be correct
      await ctx.tokenModel.verifyPublicBalance(
        halfAmount,
        ctx.addressPair.public_chain_address,
      );

      const privateBalance = await ctx.tokenModel.getBalanceOf(
        ctx.addressPair.private_chain_address,
      );
      expect(privateBalance).to.equal(halfAmount);
    }).timeout(120000);
  });
});