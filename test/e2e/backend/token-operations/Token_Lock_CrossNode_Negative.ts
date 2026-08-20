/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
import { OperatorController, UserController } from '../../../../src/api';
import {
  OPS_SERVICE_OPERATOR_AUTH_KEY,
  OPS_SERVICE_USER_AUTH_KEY,
  DEFAULT_TIMEOUT,
  GAS_LIMIT,
  OPS_SERVICE_URL,
} from '../../../../src/config/env-config';
import { randomSuffix } from '../../../../src/utils/generators';
import { onboardUserAndUpdateStatus } from '../../../../src/flows/backend/user-onboarding';
import { OnboardingStatus } from '../../../../src/enums/OnboardingStatus';
import {
  teleportERC20,
  teleportERC721,
  teleportERC1155,
  submitTokenToPublicChain,
} from '../../../../src/flows/backend/token-operations';
import { activateTokenOnHubViaBackend } from './setup-token-context';
import { initializePrivacyNodesAndPnh } from '../../../setup';
import { ERC20Wrapper } from '../../../../src/entities/tokens/ERC20Wrapper';
import { ERC721Wrapper } from '../../../../src/entities/tokens/ERC721Wrapper';
import { ERC1155Wrapper } from '../../../../src/entities/tokens/ERC1155Wrapper';
import {
  ProductionErc20Token, ProductionErc20Token__factory,
  ProductionErc721Token, ProductionErc721Token__factory,
  ProductionErc1155Token, ProductionErc1155Token__factory,
} from '../../../../typechain-types';
import {
  ITokenLockRequestERC20,
  ITokenLockRequestERC721,
  ITokenLockRequestERC1155,
} from '../../../../src/api/models/ITokensApiBodies';
import { parseUnits } from 'ethers';
import { eventually, submitTx } from '../../../../src/utils/common';
import nodeAssert from 'node:assert';
import { HttpStatusCode } from 'axios';
import { BackendError } from '../../../../src/exceptions-and-errors/backend-error';

describe('Cross-node teleport lock negative @token-locking-cross-node-negative @decommissioned', function () {
  // Cross-node test: requires both nodes' ops-services configured. Fail-fast at
  // describe-load with a clear message instead of axios ECONNREFUSED later.
  if (!OPS_SERVICE_URL['A'] || !OPS_SERVICE_URL['B']) {
    throw new Error('Cross-node test requires OPS_SERVICE_A_URL and OPS_SERVICE_B_URL to be set.');
  }
  const userControllerA = new UserController(OPS_SERVICE_URL['A'], OPS_SERVICE_USER_AUTH_KEY['A']);
  const operatorControllerA = new OperatorController(OPS_SERVICE_URL['A'], OPS_SERVICE_OPERATOR_AUTH_KEY['A']);
  const userControllerB = new UserController(OPS_SERVICE_URL['B'], OPS_SERVICE_USER_AUTH_KEY['B']);
  const operatorControllerB = new OperatorController(OPS_SERVICE_URL['B'], OPS_SERVICE_OPERATOR_AUTH_KEY['B']);

  // ── ERC20 ──────────────────────────────────────────────────────────────

  describe('ERC20: Revert lock on A after full teleport to B', function () {
    const MINT_AMOUNT = parseUnits('100', 18);

    before('Deploy ERC20 on A, teleport all to B', async function (this: Mocha.Context) {
      // The full cross-node setup (deploy → activate → mint → teleport A→B → resolve+wait on B)
      // exceeds the 80s global mocha timeout; match the it-block budget instead.
      this.timeout(DEFAULT_TIMEOUT);
      const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
      this.privacyNodes = initializedNodes;
      this.privateHub = initializedPNH;

      const token = new ERC20Wrapper<ProductionErc20Token>(this.privacyNodes.A, ProductionErc20Token__factory);
      this.tokenModel = token.setFields(randomSuffix('cn-neg-erc20'));
      this.tokenInstance = await this.tokenModel.deploy();
      this.userOperator = this.tokenModel.userWallet;
      this.signerAddress = await this.userOperator.getAddress();

      this.tokenAddressOnA = await this.tokenInstance.getAddress();
      this.tokenModel.address[this.privacyNodes.A.chainId] = this.tokenAddressOnA;

      await this.privacyNodes.A.grantEndpointSender([this.tokenAddressOnA]);
      // Hub-activate the issuer via the ops-api hybrid: PN lifecycle (register → approve → submitToHub)
      // through ops-api, then contract-side hub completion. Equivalent to activateOnPn() + activateOnHub().
      await activateTokenOnHubViaBackend({
        userController: userControllerA, operatorController: operatorControllerA,
        tokenModel: this.tokenModel, tokenAddress: this.tokenAddressOnA, privateHub: this.privateHub,
      });

      // Mint only AFTER the token is AUTHORIZED on the PN — mint is gated by
      // whenPrivacyNodeActive (RaylsApp._requirePrivacyNodeActive reverts otherwise).
      await this.tokenModel.mintAndAwait(this.privateHub, {
        toAddress: this.signerAddress,
        amount: MINT_AMOUNT,
        tokenId: 0n,
      });

      // Get actual balance (may include leftovers from previous runs)
      const actualBalance = await this.tokenModel.getBalanceOf(this.signerAddress);
      this.TELEPORT_AMOUNT = actualBalance;

      await submitTx(
        () => this.tokenModel.contract.teleport(
          this.signerAddress,
          actualBalance,
          this.privacyNodes.B.chainId,
          { gasLimit: GAS_LIMIT }
        ),
        `Teleporting ERC20 from A to B`
      );

      const tokenOnB = await this.tokenModel.forNode(this.privacyNodes.B, true);
      this.tokenOnB = tokenOnB;
      this.tokenAddressOnB = tokenOnB.address[this.privacyNodes.B.chainId];

      await eventually<boolean>({
        check: async () => {
          const balance = await tokenOnB.getBalanceOf(this.signerAddress);
          return balance === actualBalance;
        },
        message: 'Waiting for teleported balance on B',
      });
    });

    it('Should revert locking ERC20 on node A after full teleport to B', async function (this: Mocha.Context) {

      const addressPair = await onboardUserAndUpdateStatus(
        userControllerA, operatorControllerA,
        OnboardingStatus.APPROVED
      );

      // No ops-api register here — the token is already registered + AUTHORIZED on A (the before hook
      // ran the ops-api PN lifecycle via activateTokenOnHubViaBackend). Re-registering would revert 422.

      const lockRequest: ITokenLockRequestERC20 = {
        amount: MINT_AMOUNT.toString(),
        from: addressPair.private_chain_address,
        standard: this.tokenModel.standard,
        to: addressPair.public_chain_address,
      };

      await nodeAssert.rejects(
        userControllerA.teleport(this.tokenAddressOnA, lockRequest),
        // No balance / already locked on an active token → on-chain revert surfaced as 422 or 500,
        // or a 400 preflight. A 500 body is a generic "unexpected error" (real reason only in the
        // server log), so the substring is enforced for 4xx only.
        (e: any) => e instanceof BackendError
          && [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
          && (e.status === HttpStatusCode.InternalServerError
            || /revert|balance|insufficient|exist|lock|teleport|own/i.test(`${e.message} ${e.details?.hint ?? ''}`))
      );
    }).timeout(DEFAULT_TIMEOUT);

    it('Should revert second ERC20 lock on B after full amount already locked', async function (this: Mocha.Context) {

      const addressPair = await onboardUserAndUpdateStatus(
        userControllerB, operatorControllerB,
        OnboardingStatus.APPROVED
      );

      // B's mirror is auto-registered + AUTHORIZED by the hub activateToken callback (from the A→B
      // teleport), so no ops-api register here. Propagate it to the public chain so the first (happy-path)
      // lock below can land — teleportToPublicChain requires publicChainStatus == DEPLOYED.
      await submitTokenToPublicChain(operatorControllerB, this.tokenAddressOnB);

      await this.tokenOnB.transfer(
        addressPair.private_chain_address,
        { amount: this.TELEPORT_AMOUNT },
      );

      await teleportERC20(userControllerB, {
        pair: addressPair,
        token: this.tokenAddressOnB,
        amount: this.TELEPORT_AMOUNT,
      });

      // Second lock should revert — no balance left
      await nodeAssert.rejects(
        userControllerB.teleport(this.tokenAddressOnB, {
          from: addressPair.private_chain_address,
          to: addressPair.public_chain_address,
          standard: this.tokenOnB.standard,
          amount: this.TELEPORT_AMOUNT.toString(),
        }),
        // No balance / already locked on an active token → on-chain revert surfaced as 422 or 500,
        // or a 400 preflight. A 500 body is a generic "unexpected error" (real reason only in the
        // server log), so the substring is enforced for 4xx only.
        (e: any) => e instanceof BackendError
          && [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
          && (e.status === HttpStatusCode.InternalServerError
            || /revert|balance|insufficient|exist|lock|teleport|own/i.test(`${e.message} ${e.details?.hint ?? ''}`))
      );
    }).timeout(DEFAULT_TIMEOUT);

    it('Should revert teleporting ERC20 back to A after locked on B', async function (this: Mocha.Context) {
      // Balance on B is zero after lock — teleport should revert
      await nodeAssert.rejects(
        submitTx(
          () => this.tokenOnB.contract.teleport(
            this.signerAddress,
            this.TELEPORT_AMOUNT,
            this.privacyNodes.A.chainId,
            { gasLimit: GAS_LIMIT }
          ),
          `Teleporting ERC20 B→A (should revert)`
        ),
        (e: any) => e.message.includes('revert') || e.code === 'CALL_EXCEPTION'
      );
    }).timeout(DEFAULT_TIMEOUT);
  });

  // ── ERC721 ─────────────────────────────────────────────────────────────

  describe('ERC721: Revert lock on A after teleport to B', function () {

    before('Deploy ERC721 on A, teleport to B', async function (this: Mocha.Context) {
      // The full cross-node setup (deploy → activate → mint → teleport A→B → resolve+wait on B)
      // exceeds the 80s global mocha timeout; match the it-block budget instead.
      this.timeout(DEFAULT_TIMEOUT);
      const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
      this.privacyNodes = initializedNodes;
      this.privateHub = initializedPNH;

      const token = new ERC721Wrapper<ProductionErc721Token>(this.privacyNodes.A, ProductionErc721Token__factory);
      this.tokenModel = token.setFields(randomSuffix('cn-neg-721'));
      this.tokenInstance = await this.tokenModel.deploy();
      this.userOperator = this.tokenModel.userWallet;
      this.signerAddress = await this.userOperator.getAddress();

      this.tokenAddressOnA = await this.tokenInstance.getAddress();
      this.tokenModel.address[this.privacyNodes.A.chainId] = this.tokenAddressOnA;

      await this.privacyNodes.A.grantEndpointSender([this.tokenAddressOnA]);
      // Hub-activate the issuer via the ops-api hybrid: PN lifecycle (register → approve → submitToHub)
      // through ops-api, then contract-side hub completion. Equivalent to activateOnPn() + activateOnHub().
      await activateTokenOnHubViaBackend({
        userController: userControllerA, operatorController: operatorControllerA,
        tokenModel: this.tokenModel, tokenAddress: this.tokenAddressOnA, privateHub: this.privateHub,
      });

      // Mint only AFTER the token is AUTHORIZED on the PN — mint is gated by
      // whenPrivacyNodeActive (RaylsApp._requirePrivacyNodeActive reverts otherwise).
      await this.tokenModel.mintAndAwait(this.privateHub, {
        toAddress: this.signerAddress,
        amount: 1n,
        tokenId: 1n,
      });

      await submitTx(
        () => this.tokenModel.contract.teleport(
          this.signerAddress,
          1n,
          this.privacyNodes.B.chainId,
          { gasLimit: GAS_LIMIT }
        ),
        `Teleporting ERC721 from A to B`
      );

      const tokenOnB = await this.tokenModel.forNode(this.privacyNodes.B, true);
      this.tokenOnB = tokenOnB;
      this.tokenAddressOnB = tokenOnB.address[this.privacyNodes.B.chainId];

      await eventually<boolean>({
        check: async () => {
          const balance = await tokenOnB.getBalanceOf(this.signerAddress);
          return balance === 1n;
        },
        message: 'Waiting for teleported NFT on B',
      });
    });

    it('Should revert locking ERC721 on node A after teleport to B', async function (this: Mocha.Context) {

      const addressPair = await onboardUserAndUpdateStatus(
        userControllerA, operatorControllerA,
        OnboardingStatus.APPROVED
      );

      // No ops-api register here — the token is already registered + AUTHORIZED on A (the before hook
      // ran the ops-api PN lifecycle via activateTokenOnHubViaBackend). Re-registering would revert 422.

      const lockRequest: ITokenLockRequestERC721 = {
        tokenId: '1',
        from: addressPair.private_chain_address,
        standard: this.tokenModel.standard,
        to: addressPair.public_chain_address,
      };

      await nodeAssert.rejects(
        userControllerA.teleport(this.tokenAddressOnA, lockRequest),
        // Confirmed: after teleport to B the caller no longer owns the NFT on A, so the on-chain
        // lock reverts (`ownerOf` execution reverted) and ops-api surfaces it as a 500.
        // The 500 body is a generic "unexpected error" — the real reason lives only in the server
        // log — so status is the only deterministic signal here; no substring match possible.
        (e: any) => e instanceof BackendError && e.status === HttpStatusCode.InternalServerError
      );
    }).timeout(DEFAULT_TIMEOUT);

    it('Should revert second ERC721 lock on B after already locked', async function (this: Mocha.Context) {

      const addressPair = await onboardUserAndUpdateStatus(
        userControllerB, operatorControllerB,
        OnboardingStatus.APPROVED
      );

      // B's mirror is auto-registered + AUTHORIZED by the hub activateToken callback (from the A→B
      // teleport), so no ops-api register here. Propagate it to the public chain so the first (happy-path)
      // lock below can land — teleportToPublicChain requires publicChainStatus == DEPLOYED.
      await submitTokenToPublicChain(operatorControllerB, this.tokenAddressOnB);

      await this.tokenOnB.transfer(
        addressPair.private_chain_address,
        { tokenId: 1n },
      );

      await teleportERC721(userControllerB, {
        pair: addressPair,
        token: this.tokenAddressOnB,
        tokenId: 1n,
      });

      // Second lock should revert — NFT already locked
      await nodeAssert.rejects(
        userControllerB.teleport(this.tokenAddressOnB, {
          from: addressPair.private_chain_address,
          to: addressPair.public_chain_address,
          standard: this.tokenOnB.standard,
          tokenId: '1',
        }),
        // No balance / already locked on an active token → on-chain revert surfaced as 422 or 500,
        // or a 400 preflight. A 500 body is a generic "unexpected error" (real reason only in the
        // server log), so the substring is enforced for 4xx only.
        (e: any) => e instanceof BackendError
          && [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
          && (e.status === HttpStatusCode.InternalServerError
            || /revert|balance|insufficient|exist|lock|teleport|own/i.test(`${e.message} ${e.details?.hint ?? ''}`))
      );
    }).timeout(DEFAULT_TIMEOUT);

    it('Should revert teleporting ERC721 back to A after locked on B', async function (this: Mocha.Context) {
      await nodeAssert.rejects(
        submitTx(
          () => this.tokenOnB.contract.teleport(
            this.signerAddress,
            1n,
            this.privacyNodes.A.chainId,
            { gasLimit: GAS_LIMIT }
          ),
          `Teleporting ERC721 B→A (should revert)`
        ),
        (e: any) => e.message.includes('revert') || e.code === 'CALL_EXCEPTION'
      );
    }).timeout(DEFAULT_TIMEOUT);
  });

  // ── ERC1155 ────────────────────────────────────────────────────────────

  describe('ERC1155: Revert lock on A after teleport to B', function () {
    const MINT_AMOUNT = parseUnits('50', 18);

    before('Deploy ERC1155 on A, teleport all to B', async function (this: Mocha.Context) {
      // The full cross-node setup (deploy → activate → mint → teleport A→B → resolve+wait on B)
      // exceeds the 80s global mocha timeout; match the it-block budget instead.
      this.timeout(DEFAULT_TIMEOUT);
      const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
      this.privacyNodes = initializedNodes;
      this.privateHub = initializedPNH;

      const token = new ERC1155Wrapper<ProductionErc1155Token>(this.privacyNodes.A, ProductionErc1155Token__factory);
      this.tokenModel = token.setFields(randomSuffix('cn-neg-1155'));
      this.tokenInstance = await this.tokenModel.deploy();
      this.userOperator = this.tokenModel.userWallet;
      this.signerAddress = await this.userOperator.getAddress();

      this.tokenAddressOnA = await this.tokenInstance.getAddress();
      this.tokenModel.address[this.privacyNodes.A.chainId] = this.tokenAddressOnA;

      await this.privacyNodes.A.grantEndpointSender([this.tokenAddressOnA]);
      // Hub-activate the issuer via the ops-api hybrid: PN lifecycle (register → approve → submitToHub)
      // through ops-api, then contract-side hub completion. Equivalent to activateOnPn() + activateOnHub().
      await activateTokenOnHubViaBackend({
        userController: userControllerA, operatorController: operatorControllerA,
        tokenModel: this.tokenModel, tokenAddress: this.tokenAddressOnA, privateHub: this.privateHub,
      });

      // Mint only AFTER the token is AUTHORIZED on the PN — mint is gated by
      // whenPrivacyNodeActive (RaylsApp._requirePrivacyNodeActive reverts otherwise).
      await this.tokenModel.mintAndAwait(this.privateHub, {
        toAddress: this.signerAddress,
        amount: MINT_AMOUNT,
        tokenId: 1n,
      });

      // Get actual balance (may include leftovers from previous runs)
      const actualBalance = await this.tokenModel.getBalanceOf(this.signerAddress, 1n);
      this.TELEPORT_AMOUNT = actualBalance;

      await submitTx(
        () => this.tokenModel.contract.teleport(
          this.signerAddress,
          1n,
          actualBalance,
          this.privacyNodes.B.chainId,
          this.tokenModel.data(),
          { gasLimit: GAS_LIMIT }
        ),
        `Teleporting ERC1155 from A to B`
      );

      const tokenOnB = await this.tokenModel.forNode(this.privacyNodes.B, true);
      this.tokenOnB = tokenOnB;
      this.tokenAddressOnB = tokenOnB.address[this.privacyNodes.B.chainId];

      await eventually<boolean>({
        check: async () => {
          const balance = await tokenOnB.getBalanceOf(this.signerAddress, 1n);
          return balance === actualBalance;
        },
        message: 'Waiting for teleported ERC1155 on B',
      });
    });

    it('Should revert locking ERC1155 on node A after teleport to B', async function (this: Mocha.Context) {

      const addressPair = await onboardUserAndUpdateStatus(
        userControllerA, operatorControllerA,
        OnboardingStatus.APPROVED
      );

      // No ops-api register here — the token is already registered + AUTHORIZED on A (the before hook
      // ran the ops-api PN lifecycle via activateTokenOnHubViaBackend). Re-registering would revert 422.

      const lockRequest: ITokenLockRequestERC1155 = {
        amount: MINT_AMOUNT.toString(),
        tokenId: '1',
        from: addressPair.private_chain_address,
        standard: this.tokenModel.standard,
        to: addressPair.public_chain_address,
      };

      await nodeAssert.rejects(
        userControllerA.teleport(this.tokenAddressOnA, lockRequest),
        // No balance / already locked on an active token → on-chain revert surfaced as 422 or 500,
        // or a 400 preflight. A 500 body is a generic "unexpected error" (real reason only in the
        // server log), so the substring is enforced for 4xx only.
        (e: any) => e instanceof BackendError
          && [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
          && (e.status === HttpStatusCode.InternalServerError
            || /revert|balance|insufficient|exist|lock|teleport|own/i.test(`${e.message} ${e.details?.hint ?? ''}`))
      );
    }).timeout(DEFAULT_TIMEOUT);

    it('Should revert second ERC1155 lock on B after full amount already locked', async function (this: Mocha.Context) {

      const addressPair = await onboardUserAndUpdateStatus(
        userControllerB, operatorControllerB,
        OnboardingStatus.APPROVED
      );

      // B's mirror is auto-registered + AUTHORIZED by the hub activateToken callback (from the A→B
      // teleport), so no ops-api register here. Propagate it to the public chain so the first (happy-path)
      // lock below can land — teleportToPublicChain requires publicChainStatus == DEPLOYED.
      await submitTokenToPublicChain(operatorControllerB, this.tokenAddressOnB);

      await this.tokenOnB.transfer(
        addressPair.private_chain_address,
        { tokenId: 1n, amount: this.TELEPORT_AMOUNT },
      );

      await teleportERC1155(userControllerB, {
        pair: addressPair,
        token: this.tokenAddressOnB,
        tokenId: 1n,
        amount: this.TELEPORT_AMOUNT,
      });

      // Second lock should revert — no balance left
      await nodeAssert.rejects(
        userControllerB.teleport(this.tokenAddressOnB, {
          from: addressPair.private_chain_address,
          to: addressPair.public_chain_address,
          standard: this.tokenOnB.standard,
          tokenId: '1',
          amount: this.TELEPORT_AMOUNT.toString(),
        }),
        // No balance / already locked on an active token → on-chain revert surfaced as 422 or 500,
        // or a 400 preflight. A 500 body is a generic "unexpected error" (real reason only in the
        // server log), so the substring is enforced for 4xx only.
        (e: any) => e instanceof BackendError
          && [HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.InternalServerError].includes(e.status)
          && (e.status === HttpStatusCode.InternalServerError
            || /revert|balance|insufficient|exist|lock|teleport|own/i.test(`${e.message} ${e.details?.hint ?? ''}`))
      );
    }).timeout(DEFAULT_TIMEOUT);

    it('Should revert teleporting ERC1155 back to A after locked on B', async function (this: Mocha.Context) {
      await nodeAssert.rejects(
        submitTx(
          () => this.tokenOnB.contract.teleport(
            this.signerAddress,
            1n,
            this.TELEPORT_AMOUNT,
            this.privacyNodes.A.chainId,
            this.tokenOnB.data(),
            { gasLimit: GAS_LIMIT }
          ),
          `Teleporting ERC1155 B→A (should revert)`
        ),
        (e: any) => e.message.includes('revert') || e.code === 'CALL_EXCEPTION'
      );
    }).timeout(DEFAULT_TIMEOUT);
  });
});
