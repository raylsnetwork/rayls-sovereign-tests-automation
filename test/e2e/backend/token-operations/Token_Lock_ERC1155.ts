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
import { eventually } from '../../../../src/utils/common';
import { shortHex } from '../../../../src/utils/formatters';
import { teleportERC1155 } from '../../../../src/flows/backend/token-operations';
import { ERC1155Wrapper } from '../../../../src/entities/tokens/ERC1155Wrapper';
import { ProductionErc1155Token, ProductionErc1155Token__factory } from '../../../../typechain-types';
import { parseUnits } from 'ethers';
import { expect } from 'chai';
import nodeAssert from 'node:assert';
import { BackendError } from '../../../../src/exceptions-and-errors/backend-error';
import { HttpStatusCode } from 'axios';
import {
  setupTokenForUser,
  TokenForUserContext,
} from './setup-token-context';

describe('ERC1155 Token Locking @token-locking @decommissioned @hubless', function () {
  const userController = new UserController(BACKEND_OPS_URL, BACKEND_USER_AUTH_KEY);
  const operatorController = new OperatorController(BACKEND_OPS_URL, BACKEND_OPERATOR_AUTH_KEY);
  const MINT_AMOUNT = parseUnits('20', 18);

  let ctx: TokenForUserContext<ERC1155Wrapper<ProductionErc1155Token>>;

  describe('ERC1155 locking @token-lock-pos', function () {
    beforeEach('Deploy, onboard, register, fund user', async function () {
      this.timeout(DEFAULT_TIMEOUT);
      ctx = await setupTokenForUser({
        userController, operatorController,
        wrapper: (node) => new ERC1155Wrapper<ProductionErc1155Token>(node, ProductionErc1155Token__factory),
        mint: { amount: MINT_AMOUNT, tokenId: 1n },
        transfer: { tokenId: 1n, amount: MINT_AMOUNT },
        title: this.currentTest?.fullTitle(),
      });
    });

    it('Should lock and send ERC1155 token amount to public chain @smoke', async function () {
      await teleportERC1155(userController, {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        tokenId: 1n,
        amount: MINT_AMOUNT,
      });

      await ctx.tokenModel.verifyTokenExistsInGovernance(
        ctx.privacyNodes.A,
        ctx.tokenAddressInPLA,
      );

      await ctx.tokenModel.verifyPublicBalance(
        MINT_AMOUNT,
        ctx.addressPair.public_chain_address,
        1n,
      );
    }).timeout(80000);

    it('Should lock partial ERC1155 balance and verify remainder', async function () {
      const halfAmount = MINT_AMOUNT / 2n;

      await teleportERC1155(userController, {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        tokenId: 1n,
        amount: halfAmount,
      });

      await ctx.tokenModel.verifyPublicBalance(
        halfAmount,
        ctx.addressPair.public_chain_address,
        1n,
      );

      const privateBalance = await ctx.tokenModel.getBalanceOf(
        ctx.addressPair.private_chain_address,
        1n,
      );
      expect(privateBalance).to.be.eq(halfAmount);
    }).timeout(80000);

    it('Should lock ERC1155 tokens sequentially in two transactions', async function () {
      const halfAmount = MINT_AMOUNT / 2n;

      const lockParams = {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        tokenId: 1n,
        amount: halfAmount,
      };

      await teleportERC1155(userController, lockParams);

      await ctx.tokenModel.verifyPublicBalance(
        halfAmount,
        ctx.addressPair.public_chain_address,
        1n,
      );

      await teleportERC1155(userController, lockParams);

      const expectedTotal = MINT_AMOUNT;
      const publicAddr = ctx.addressPair.public_chain_address;
      const reached = await eventually<boolean>({
        check: async () => {
          const bal = await ctx.tokenModel.publicContract.balanceOf(publicAddr, 1n);
          LOGGER.info(`[SEQ LOCK] public balance: ${bal}, expected: ${expectedTotal}`);
          return bal === expectedTotal;
        },
        interval: 3000,
        attempts: 60,
        message: `Waiting for public #1 balance for ${shortHex(publicAddr)} → ${expectedTotal} (sequential locks)`,
      });
      expect(reached, `Public balance did not reach ${expectedTotal}`).to.be.true;
    }).timeout(180000);

    it('Should return valid tx_hash from lock response', async function () {
      const txHash = await teleportERC1155(userController, {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        tokenId: 1n,
        amount: MINT_AMOUNT,
      });

      expect(txHash).to.be.a('string').that.is.not.empty;
      expect(txHash).to.match(/^0x[a-fA-F0-9]{64}$/);
    }).timeout(80000);
  });

  describe('ERC1155 cross-operation scenarios @token-lock-cross', function () {

    it('Should lock immediately after token approval', async function () {
      ctx = await setupTokenForUser({
        userController, operatorController,
        wrapper: (node) => new ERC1155Wrapper<ProductionErc1155Token>(node, ProductionErc1155Token__factory),
        mint: { amount: MINT_AMOUNT, tokenId: 1n },
        transfer: { tokenId: 1n, amount: MINT_AMOUNT },
        title: this.test?.fullTitle(),
      });

      await teleportERC1155(userController, {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        tokenId: 1n,
        amount: MINT_AMOUNT,
      });

      await ctx.tokenModel.verifyPublicBalance(
        MINT_AMOUNT,
        ctx.addressPair.public_chain_address,
        1n,
      );
    }).timeout(120000);
  });

  describe('ERC1155 double-spend and balance integrity @token-lock-integrity', function () {
    beforeEach('Deploy, onboard, register, fund user', async function () {
      this.timeout(DEFAULT_TIMEOUT);
      ctx = await setupTokenForUser({
        userController, operatorController,
        wrapper: (node) => new ERC1155Wrapper<ProductionErc1155Token>(node, ProductionErc1155Token__factory),
        mint: { amount: MINT_AMOUNT, tokenId: 1n },
        transfer: { tokenId: 1n, amount: MINT_AMOUNT },
        title: this.currentTest?.fullTitle(),
      });
    });

    it('Should leave zero private balance after locking full ERC1155 amount', async function () {
      await teleportERC1155(userController, {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        tokenId: 1n,
        amount: MINT_AMOUNT,
      });

      await ctx.tokenModel.verifyPublicBalance(
        MINT_AMOUNT,
        ctx.addressPair.public_chain_address,
        1n,
      );

      const privateBalance = await ctx.tokenModel.getBalanceOf(
        ctx.addressPair.private_chain_address,
        1n,
      );
      expect(privateBalance).to.equal(0n);
    }).timeout(80000);

    it('Should revert second lock after full ERC1155 amount already locked', async function () {
      await teleportERC1155(userController, {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        tokenId: 1n,
        amount: MINT_AMOUNT,
      });

      // Second lock — no balance left. Direct API call: fail fast (failure expected).
      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, {
          from: ctx.addressPair.private_chain_address,
          to: ctx.addressPair.public_chain_address,
          standard: ctx.tokenModel.standard,
          tokenId: '1',
          amount: MINT_AMOUNT.toString(),
        }),
        (e: any) => e instanceof BackendError && (
          e.status === HttpStatusCode.BadRequest || e.status === HttpStatusCode.InternalServerError
        ),
      );
    }).timeout(120000);

    it('Should revert locking more than remaining ERC1155 balance after partial lock', async function () {
      const halfAmount = MINT_AMOUNT / 2n;

      await teleportERC1155(userController, {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        tokenId: 1n,
        amount: halfAmount,
      });

      // Try to lock the full amount — only half remains. Direct API: fail fast.
      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, {
          from: ctx.addressPair.private_chain_address,
          to: ctx.addressPair.public_chain_address,
          standard: ctx.tokenModel.standard,
          tokenId: '1',
          amount: MINT_AMOUNT.toString(),
        }),
        (e: any) => e instanceof BackendError && (
          e.status === HttpStatusCode.BadRequest || e.status === HttpStatusCode.InternalServerError
        ),
      );

      // Original partial lock should still be correct
      await ctx.tokenModel.verifyPublicBalance(
        halfAmount,
        ctx.addressPair.public_chain_address,
        1n,
      );

      const privateBalance = await ctx.tokenModel.getBalanceOf(
        ctx.addressPair.private_chain_address,
        1n,
      );
      expect(privateBalance).to.equal(halfAmount);
    }).timeout(120000);

  });
});