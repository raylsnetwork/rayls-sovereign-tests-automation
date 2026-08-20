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
import { parseUnits } from 'ethers';
import { eventually, submitTx } from '../../../../src/utils/common';
import { assert } from 'chai';
import nodeAssert from 'node:assert';

describe('Cross-node teleport then backend lock @token-locking-cross-node @decommissioned', function () {
  // Cross-node test: requires both nodes' ops-services configured. Fail-fast at
  // describe-load with a clear message instead of axios ECONNREFUSED later.
  if (!OPS_SERVICE_URL['A'] || !OPS_SERVICE_URL['B']) {
    throw new Error('Cross-node test requires OPS_SERVICE_A_URL and OPS_SERVICE_B_URL to be set.');
  }
  const userControllerA = new UserController(OPS_SERVICE_URL['A'], OPS_SERVICE_USER_AUTH_KEY['A']);
  const operatorControllerA = new OperatorController(OPS_SERVICE_URL['A'], OPS_SERVICE_OPERATOR_AUTH_KEY['A']);
  const userControllerB = new UserController(OPS_SERVICE_URL['B'], OPS_SERVICE_USER_AUTH_KEY['B']);
  const operatorControllerB = new OperatorController(OPS_SERVICE_URL['B'], OPS_SERVICE_OPERATOR_AUTH_KEY['B']);

  describe('ERC20: Teleport A→B then lock from B to public', function () {
    const MINT_AMOUNT = parseUnits('100', 18);

    before('Deploy ERC20 on A, teleport all to B', async function (this: Mocha.Context) {
      // The full cross-node setup (deploy → activate → mint → teleport A→B → resolve+wait on B)
      // exceeds the 80s global mocha timeout; match the it-block budget instead.
      this.timeout(DEFAULT_TIMEOUT);
      const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
      this.privacyNodes = initializedNodes;
      this.privateHub = initializedPNH;

      const token = new ERC20Wrapper<ProductionErc20Token>(this.privacyNodes.A, ProductionErc20Token__factory);
      this.tokenModel = token.setFields(randomSuffix('cross-erc20'));
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

      // Teleport full balance from A to B
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

    it('Should have zero ERC20 balance on A and full balance on B after teleport', async function (this: Mocha.Context) {
      const balanceOnA = await this.tokenModel.getBalanceOf(this.signerAddress);
      assert.equal(balanceOnA, 0n, 'Balance on A should be zero after full teleport');

      const balanceOnB = await this.tokenOnB.getBalanceOf(this.signerAddress);
      assert.equal(balanceOnB, this.TELEPORT_AMOUNT, 'Full amount should be on B');
    });

    it('Should lock teleported ERC20 from node B to public chain', async function (this: Mocha.Context) {

      const addressPair = await onboardUserAndUpdateStatus(
        userControllerB, operatorControllerB,
        OnboardingStatus.APPROVED
      );

      // B's mirror is auto-registered + AUTHORIZED by the hub activateToken callback (from the A→B
      // teleport), so no ops-api register here. Propagate the B-side token to the public chain before
      // locking B→public.
      await submitTokenToPublicChain(operatorControllerB, this.tokenAddressOnB);

      await this.tokenOnB.transfer(
        addressPair.private_chain_address,
        { amount: MINT_AMOUNT },
      );

      await teleportERC20(userControllerB, {
        pair: addressPair,
        token: this.tokenAddressOnB,
        amount: MINT_AMOUNT,
      });

      await this.tokenOnB.verifyPublicBalance(
        MINT_AMOUNT,
        addressPair.public_chain_address,
      );
    }).timeout(DEFAULT_TIMEOUT);
  });

  describe('ERC721: Teleport A→B then lock from B to public', function () {

    before('Deploy ERC721 on A, teleport to B', async function (this: Mocha.Context) {
      // The full cross-node setup (deploy → activate → mint → teleport A→B → resolve+wait on B)
      // exceeds the 80s global mocha timeout; match the it-block budget instead.
      this.timeout(DEFAULT_TIMEOUT);
      const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
      this.privacyNodes = initializedNodes;
      this.privateHub = initializedPNH;

      const token = new ERC721Wrapper<ProductionErc721Token>(this.privacyNodes.A, ProductionErc721Token__factory);
      this.tokenModel = token.setFields(randomSuffix('cross-erc721'));
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

    it('Should have zero ERC721 balance on A after teleport', async function (this: Mocha.Context) {
      // ownerOf reverts for non-existent/teleported tokenId on Rayls ERC721
      await nodeAssert.rejects(
        this.tokenModel.contract.ownerOf(1n),
        'tokenId 1 should no longer exist on node A after teleport'
      );
    });

    it('Should lock teleported ERC721 from node B to public chain', async function (this: Mocha.Context) {

      const addressPair = await onboardUserAndUpdateStatus(
        userControllerB, operatorControllerB,
        OnboardingStatus.APPROVED
      );

      // B's mirror is auto-registered + AUTHORIZED by the hub activateToken callback (from the A→B
      // teleport), so no ops-api register here. Propagate the B-side token to the public chain before
      // locking B→public.
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

      await this.tokenOnB.verifyPublicBalance(
        1n,
        addressPair.public_chain_address,
      );
    }).timeout(DEFAULT_TIMEOUT);
  });

  describe('ERC1155: Teleport A→B then lock from B to public', function () {
    const MINT_AMOUNT = parseUnits('50', 18);

    before('Deploy ERC1155 on A, teleport all to B', async function (this: Mocha.Context) {
      // The full cross-node setup (deploy → activate → mint → teleport A→B → resolve+wait on B)
      // exceeds the 80s global mocha timeout; match the it-block budget instead.
      this.timeout(DEFAULT_TIMEOUT);
      const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
      this.privacyNodes = initializedNodes;
      this.privateHub = initializedPNH;

      const token = new ERC1155Wrapper<ProductionErc1155Token>(this.privacyNodes.A, ProductionErc1155Token__factory);
      this.tokenModel = token.setFields(randomSuffix('cross-erc1155'));
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
        message: 'Waiting for teleported ERC1155 balance on B',
      });
    });

    it('Should have zero ERC1155 balance on A after teleport', async function (this: Mocha.Context) {
      const balanceOnA = await this.tokenModel.getBalanceOf(this.signerAddress, 1n);
      assert.equal(balanceOnA, 0n, 'ERC1155 balance on A should be zero after full teleport');
    });

    it('Should lock teleported ERC1155 from node B to public chain', async function (this: Mocha.Context) {

      const addressPair = await onboardUserAndUpdateStatus(
        userControllerB, operatorControllerB,
        OnboardingStatus.APPROVED
      );

      // B's mirror is auto-registered + AUTHORIZED by the hub activateToken callback (from the A→B
      // teleport), so no ops-api register here. Propagate the B-side token to the public chain before
      // locking B→public.
      await submitTokenToPublicChain(operatorControllerB, this.tokenAddressOnB);

      await this.tokenOnB.transfer(
        addressPair.private_chain_address,
        { tokenId: 1n, amount: MINT_AMOUNT },
      );

      await teleportERC1155(userControllerB, {
        pair: addressPair,
        token: this.tokenAddressOnB,
        tokenId: 1n,
        amount: MINT_AMOUNT,
      });

      await this.tokenOnB.verifyPublicBalance(
        MINT_AMOUNT,
        addressPair.public_chain_address,
        1n
      );
    }).timeout(DEFAULT_TIMEOUT);
  });
});
