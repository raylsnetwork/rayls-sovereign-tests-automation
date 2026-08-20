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
import { teleportERC721 } from '../../../../src/flows/backend/token-operations';
import { ERC721Wrapper } from '../../../../src/entities/tokens/ERC721Wrapper';
import { ProductionErc721Token, ProductionErc721Token__factory } from '../../../../typechain-types';
import { expect } from 'chai';
import nodeAssert from 'node:assert';
import { BackendError } from '../../../../src/exceptions-and-errors/backend-error';
import { HttpStatusCode } from 'axios';
import {
  setupTokenForUser,
  TokenForUserContext,
} from './setup-token-context';

describe('ERC721 Token Locking @token-locking @decommissioned @hubless', function () {
  const userController = new UserController(BACKEND_OPS_URL, BACKEND_USER_AUTH_KEY);
  const operatorController = new OperatorController(BACKEND_OPS_URL, BACKEND_OPERATOR_AUTH_KEY);

  let ctx: TokenForUserContext<ERC721Wrapper<ProductionErc721Token>>;

  describe('ERC721 locking @token-lock-pos', function () {
    beforeEach('Deploy, onboard, register, fund user', async function () {
      this.timeout(DEFAULT_TIMEOUT);
      ctx = await setupTokenForUser({
        userController, operatorController,
        wrapper: (node) => new ERC721Wrapper<ProductionErc721Token>(node, ProductionErc721Token__factory),
        mint: { tokenId: 1n },
        transfer: { tokenId: 1n },
        title: this.currentTest?.fullTitle(),
      });
    });

    it('Should lock and send ERC721 token to public chain @smoke', async function () {
      await teleportERC721(userController, {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        tokenId: 1n,
      });

      await ctx.tokenModel.verifyTokenExistsInGovernance(
        ctx.privacyNodes.A,
        ctx.tokenAddressInPLA,
      );

      await ctx.tokenModel.verifyPublicBalance(
        1n,
        ctx.addressPair.public_chain_address,
      );
    }).timeout(80000);

    it('Should return valid tx_hash from lock response', async function () {
      const txHash = await teleportERC721(userController, {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        tokenId: 1n,
      });

      expect(txHash).to.be.a('string').that.is.not.empty;
      expect(txHash).to.match(/^0x[a-fA-F0-9]{64}$/);
    }).timeout(80000);
  });

  describe('ERC721 cross-operation scenarios @token-lock-cross', function () {
    it('Should lock immediately after token approval', async function () {
      ctx = await setupTokenForUser({
        userController, operatorController,
        wrapper: (node) => new ERC721Wrapper<ProductionErc721Token>(node, ProductionErc721Token__factory),
        mint: { tokenId: 1n },
        transfer: { tokenId: 1n },
        title: this.test?.fullTitle(),
      });

      await teleportERC721(userController, {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        tokenId: 1n,
      });

      await ctx.tokenModel.verifyPublicBalance(
        1n,
        ctx.addressPair.public_chain_address,
      );
    }).timeout(120000);
  });

  describe('ERC721 double-spend and balance integrity @token-lock-integrity', function () {
    beforeEach('Deploy, onboard, register, fund user', async function () {
      this.timeout(DEFAULT_TIMEOUT);
      ctx = await setupTokenForUser({
        userController, operatorController,
        wrapper: (node) => new ERC721Wrapper<ProductionErc721Token>(node, ProductionErc721Token__factory),
        mint: { tokenId: 1n },
        transfer: { tokenId: 1n },
        title: this.currentTest?.fullTitle(),
      });
    });

    it('Should revert second lock of same ERC721 tokenId', async function () {
      await teleportERC721(userController, {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        tokenId: 1n,
      });

      await ctx.tokenModel.verifyPublicBalance(
        1n,
        ctx.addressPair.public_chain_address,
      );

      // Second lock — same tokenId already locked. Direct API call: a negative
      // assertion expects a deterministic failure, so skip the retry-wrapped helper
      // and fail fast (the backend wraps the revert as 500, which would otherwise retry).
      await nodeAssert.rejects(
        userController.teleport(ctx.tokenAddressInPLA, {
          from: ctx.addressPair.private_chain_address,
          to: ctx.addressPair.public_chain_address,
          standard: ctx.tokenModel.standard,
          tokenId: '1',
        }),
        (e: any) => e instanceof BackendError && (
          e.status === HttpStatusCode.BadRequest || e.status === HttpStatusCode.InternalServerError
        ),
      );
    }).timeout(120000);

    it('Should leave zero private NFT balance after locking', async function () {
      await teleportERC721(userController, {
        pair: ctx.addressPair,
        token: ctx.tokenAddressInPLA,
        tokenId: 1n,
      });

      await ctx.tokenModel.verifyPublicBalance(
        1n,
        ctx.addressPair.public_chain_address,
      );

      // User should no longer hold the NFT on private chain
      const privateBalance = await ctx.tokenModel.getBalanceOf(
        ctx.addressPair.private_chain_address,
      );
      expect(privateBalance).to.equal(0n);
    }).timeout(80000);

  });
});