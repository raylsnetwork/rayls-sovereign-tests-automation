import { OperatorController, UserController } from '../../../../src/api';
import {
  BACKEND_OPS_URL,
  BACKEND_OPERATOR_AUTH_KEY,
  BACKEND_USER_AUTH_KEY,
} from '../../../../src/config/env-config';

import {
  registerToken,
  registerTokenAndUpdateStatus,
  updateTokenStatus,
} from '../../../../src/flows/backend/token-operations';
import nodeAssert from 'node:assert';
import { expect } from 'chai';
import { TokenStatus } from '../../../../src/enums/TokenStatus';
import { randomSuffix } from '../../../../src/utils/generators';
import { BackendError } from '../../../../src/exceptions-and-errors/backend-error';
import { HttpStatusCode } from 'axios';
import { ERC20Wrapper } from '../../../../src/entities/tokens/ERC20Wrapper';
import { ProductionErc20Token, ProductionErc20Token__factory } from '../../../../typechain-types';
import { initializePrivacyNodes } from '../../../setup';

describe('Token Registration Negative @token-operations-negative @hubless', function () {
  const userController = new UserController(BACKEND_OPS_URL, BACKEND_USER_AUTH_KEY);
  const operatorController = new OperatorController(BACKEND_OPS_URL, BACKEND_OPERATOR_AUTH_KEY);

  beforeEach(`Deploy ERC20 token on privacy ledger node`, async function (this: Mocha.Context) {
    // Ops-api registration negatives — PN-local, no hub. PN-only init + node role grants.
    const initializedNodes = await initializePrivacyNodes(1);
    this.privacyNodes = initializedNodes;

    const token = new ERC20Wrapper<ProductionErc20Token>(this.privacyNodes.A, ProductionErc20Token__factory);
    const unique = token.setFields(randomSuffix(this.currentTest?.fullTitle()));
    const deployed = await unique.deploy();
    this.tokenAddressInPLA = await deployed.getAddress();
    this.tokenInstance = deployed;
    this.tokenModel = unique;

    this.tokenModel.address[this.privacyNodes.A.chainId] = this.tokenAddressInPLA;
  });

  describe(`Token negative scenarios`, function () {

    it(`Should reject registering a token at an address with no contract code (EOA)`, async function (this: Mocha.Context) {
      // 0x000…0 is a valid hex address (passes the hex check) but has no deployed code → EnsureCode fails.
      // ops-api surfaces this as a non-revert error; status class is 400/500 (confirm empirically).
      await nodeAssert.rejects(
        userController.registerToken('0x0000000000000000000000000000000000000000'),
        (e: any) =>
          e instanceof BackendError &&
          (e.status === HttpStatusCode.BadRequest || e.status === HttpStatusCode.InternalServerError),
      );
    });

    it(`Should reject setting status to UNDEFINED (0) for a registered token @pending`, async function (this: Mocha.Context) {
      await registerToken(userController, this.tokenAddressInPLA);

      await nodeAssert.rejects(
        operatorController.updateTokenStatus(this.tokenAddressInPLA, { status: TokenStatus.UNDEFINED }),
        (e: any) =>
          e instanceof BackendError &&
          e.status === HttpStatusCode.BadRequest &&
          /status|undefined|inactive|invalid/i.test(e.message),
      );
    });

    it(`Should revert (422) setting status of an unregistered token`, async function (this: Mocha.Context) {
      // AUTHORIZED (2) passes body validation, so the failure surfaces from the on-chain revert (422),
      // not the 400 that an unaccepted status value (0/1/4) would produce before reaching the contract.
      await nodeAssert.rejects(
        operatorController.updateTokenStatus(this.tokenAddressInPLA, { status: TokenStatus.AUTHORIZED }),
        (e: any) =>
          e instanceof BackendError &&
          e.status === HttpStatusCode.UnprocessableEntity &&
          /revert/i.test(`${e.message} ${e.details?.hint ?? ''}`),
      );
    });

    it(`Should revert (422) duplicate ERC20 token registration`, async function (this: Mocha.Context) {
      await registerToken(userController, this.tokenAddressInPLA);

      await nodeAssert.rejects(
        userController.registerToken(this.tokenAddressInPLA),
        (e: any) =>
          e instanceof BackendError &&
          e.status === HttpStatusCode.UnprocessableEntity &&
          /revert/i.test(`${e.message} ${e.details?.hint ?? ''}`),
      );
    });

    it('Should reject registering token with invalid address format', async function (this: Mocha.Context) {
      await nodeAssert.rejects(
        userController.registerToken('not-a-hex-address'),
        (e: any) =>
          e instanceof BackendError &&
          e.status === HttpStatusCode.BadRequest &&
          /address|hex/i.test(e.message),
      );
    });

    it('Should reject setting an AUTHORIZED token back to UNDEFINED (0)', async function (this: Mocha.Context) {
      await registerTokenAndUpdateStatus(userController, operatorController,
        this.tokenAddressInPLA,
        TokenStatus.AUTHORIZED
      );

      await nodeAssert.rejects(
        operatorController.updateTokenStatus(this.tokenAddressInPLA, { status: TokenStatus.UNDEFINED }),
        (e: any) =>
          e instanceof BackendError &&
          e.status === HttpStatusCode.BadRequest &&
          /status|undefined|inactive|invalid/i.test(e.message),
      );
    });

    it('Should promote a WAITING_APPROVAL token to AUTHORIZED', async function (this: Mocha.Context) {
      await registerToken(userController, this.tokenAddressInPLA);

      await updateTokenStatus(operatorController, this.tokenAddressInPLA, TokenStatus.AUTHORIZED);

      const updatedToken = await userController.pollUntilTokenStatusIsUpdated(
        this.tokenAddressInPLA,
        TokenStatus.AUTHORIZED,
      );
      expect(updatedToken.status).to.equal(TokenStatus.AUTHORIZED);
    });

    it('Should list a freshly registered token in the pending registry', async function (this: Mocha.Context) {
      await registerToken(userController, this.tokenAddressInPLA);

      const pendingTokens = await userController.listRegistryPending();
      const match = pendingTokens.find((t) => t.address.toLowerCase() === this.tokenAddressInPLA.toLowerCase());
      expect(match, 'registered token should be in the pending registry').to.not.be.undefined;
      expect(match!.status).to.be.equal(TokenStatus.WAITING_APPROVAL);
    });

    it('Should clear token from pending registry after promotion to AUTHORIZED', async function (this: Mocha.Context) {
      await registerTokenAndUpdateStatus(userController, operatorController,
        this.tokenAddressInPLA,
        TokenStatus.AUTHORIZED
      );

      const pendingTokens = await userController.listRegistryPending();
      const match = pendingTokens.find((t) => t.address.toLowerCase() === this.tokenAddressInPLA.toLowerCase());
      expect(match, 'promoted token must not remain pending').to.be.undefined;
    });

    it('Should clear token from pending registry after unauthorize', async function (this: Mocha.Context) {
      await registerTokenAndUpdateStatus(userController, operatorController,
        this.tokenAddressInPLA,
        TokenStatus.UNAUTHORIZED
      );

      const pendingTokens = await userController.listRegistryPending();
      const match = pendingTokens.find((t) => t.address.toLowerCase() === this.tokenAddressInPLA.toLowerCase());
      expect(match, 'unauthorized token must not remain pending').to.be.undefined;
    });
  });
});
