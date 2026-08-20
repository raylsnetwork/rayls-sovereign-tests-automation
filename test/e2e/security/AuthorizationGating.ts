/**
 * @title E2E SECURITY: Authorization Gating — Business Role Enforcement
 * @description Validates that restricted functions reject unauthorized callers.
 *              Each test creates a FRESH wallet to avoid nonce contention with the
 *              shared singleton wallets used across the e2e suite.
 *
 * ROLE HIERARCHY (PN):
 *   ADMIN → can do anything
 *   PRIVACY_NODE_OPERATOR → user governance (createUser, approveUser, rejectUser, removeUser)
 *   BANK_EMPLOYEE → tokenization + user ops (addToken, addAddressPair)
 *
 * ROLE HIERARCHY (PNH):
 *   ADMIN → can do anything
 *   PRIVATE_NETWORK_OPERATOR → token status, lock time, participant mgmt
 *   COMPLIANCE_OFFICER → freezeToken, unfreezeToken
 */

import { expect } from 'chai';
import { ethers } from 'hardhat';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import {
  RNUserGovernanceV1,
  TokenRegistryV1,
  TeleportV1,
  ParticipantStorageV1,
  ProductionErc20Token,
  ProductionErc20Token__factory,
} from '../../../typechain-types';
import { ERC20Wrapper } from '../../../src/entities/tokens/ERC20Wrapper';
import { createUserOperator } from '../../../src/utils/wallet-factory';
import { notRoleAdminErr } from '../../../src/exceptions-and-errors/contract-errors';
import { submitTx } from '../../../src/utils/common';


describe('E2E Security: Authorization Gating @authorization-gating', function () {
  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let token: ERC20Wrapper<ProductionErc20Token>;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    // Deploy and register a token for testing
    token = new ERC20Wrapper<ProductionErc20Token>(privacyNodes.A, ProductionErc20Token__factory);
    token.setFields('auth-gate');
    await token.deploy();
    await token.activateOnPn();
    await token.activateOnHub(privateHub);
  });

  // ============================================================
  // PN — Token Governance Gating
  // ============================================================

  describe('PN — Token Registry (PNTokenRegistryV1)', function () {

    it('user cannot call registerToken (no TOKEN_CREATOR)', async function () {
      const userWallet = createUserOperator(privacyNodes.A.provider);
      const registry = await privacyNodes.A.getPnTokenRegistry(userWallet);
      await expect(registry.registerToken(ethers.Wallet.createRandom().address)).to.be.revertedWithCustomError(registry, 'RaylsAccessManaged__Unauthorized');
    }).timeout(DEFAULT_TIMEOUT);

    it('user cannot call updatePrivacyNodeStatus (no PN_TOKEN_REGISTRY_ADMIN)', async function () {
      const userWallet = createUserOperator(privacyNodes.A.provider);
      const registry = await privacyNodes.A.getPnTokenRegistry(userWallet);
      await expect(registry.updatePrivacyNodeStatus(token.address[privacyNodes.A.chainId], 2)).to.be.revertedWithCustomError(registry, 'RaylsAccessManaged__Unauthorized');
    }).timeout(DEFAULT_TIMEOUT);

    it('bankEmployee cannot call updatePrivacyNodeStatus (BANK_EMPLOYEE lacks PN_TOKEN_REGISTRY_ADMIN)', async function () {
      const bankEmployeeWallet = createUserOperator(privacyNodes.A.provider);
      const manager = await privacyNodes.A.getAccessManager();
      const roleId = await manager.getRoleIdByName('BANK_EMPLOYEE');
      await submitTx(
        () => (manager.connect(privacyNodes.A.operatorWallet) as typeof manager)
          .grantRole(roleId, bankEmployeeWallet.address, 0),
        'Granting BANK_EMPLOYEE to bank-employee wallet (PN A, registry updatePrivacyNodeStatus gate)',
      );

      const registry = await privacyNodes.A.getPnTokenRegistry(bankEmployeeWallet);
      await expect(registry.updatePrivacyNodeStatus(token.address[privacyNodes.A.chainId], 2)).to.be.revertedWithCustomError(registry, 'RaylsAccessManaged__Unauthorized');
    }).timeout(DEFAULT_TIMEOUT);
  });

  // ============================================================
  // PN — User Governance Gating
  // ============================================================

  describe('PN — User Governance (RNUserGovernanceV1)', function () {

    it('user cannot call createUser (no PRIVACY_NODE_OPERATOR)', async function () {
      const userWallet = createUserOperator(privacyNodes.A.provider);
      const userGov = await privacyNodes.A.getContractAt<RNUserGovernanceV1>(
        'RNUserGovernanceV1', privacyNodes.A.raylsNodeUserGovernance,
        'RNUserGovernanceV1', userWallet,
      );
      const userId = ethers.keccak256(ethers.randomBytes(32));
      await expect(userGov.createUser(userId)).to.be.revertedWithCustomError(userGov, 'RaylsAccessManaged__Unauthorized');
    }).timeout(DEFAULT_TIMEOUT);

    it('bankEmployee cannot call createUser (PRIVACY_NODE_OPERATOR-only)', async function () {
      const bankEmployeeWallet = createUserOperator(privacyNodes.A.provider);
      const manager = await privacyNodes.A.getAccessManager();
      const roleId = await manager.getRoleIdByName('BANK_EMPLOYEE');
      await submitTx(
        () => (manager.connect(privacyNodes.A.operatorWallet) as typeof manager)
          .grantRole(roleId, bankEmployeeWallet.address, 0),
        'Granting BANK_EMPLOYEE to bank-employee wallet (PN A, user-gov createUser gate)',
      );

      const userGov = await privacyNodes.A.getContractAt<RNUserGovernanceV1>(
        'RNUserGovernanceV1', privacyNodes.A.raylsNodeUserGovernance,
        'RNUserGovernanceV1', bankEmployeeWallet,
      );
      const userId = ethers.keccak256(ethers.randomBytes(32));
      await expect(userGov.createUser(userId)).to.be.revertedWithCustomError(userGov, 'RaylsAccessManaged__Unauthorized');
    }).timeout(DEFAULT_TIMEOUT);

    it('user cannot call addAddressPair (no BANK_EMPLOYEE)', async function () {
      const userWallet = createUserOperator(privacyNodes.A.provider);
      const userGov = await privacyNodes.A.getContractAt<RNUserGovernanceV1>(
        'RNUserGovernanceV1', privacyNodes.A.raylsNodeUserGovernance,
        'RNUserGovernanceV1', userWallet,
      );
      const userId = ethers.keccak256(ethers.randomBytes(32));
      await expect(userGov.addAddressPair(userId, ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address)).to.be.revertedWithCustomError(userGov, 'RaylsAccessManaged__Unauthorized');
    }).timeout(DEFAULT_TIMEOUT);

    it('bankEmployee cannot call setAddressPairApprovalStatus (PRIVACY_NODE_OPERATOR-only)', async function () {
      const bankEmployeeWallet = createUserOperator(privacyNodes.A.provider);
      const manager = await privacyNodes.A.getAccessManager();
      const roleId = await manager.getRoleIdByName('BANK_EMPLOYEE');
      await submitTx(
        () => (manager.connect(privacyNodes.A.operatorWallet) as typeof manager)
          .grantRole(roleId, bankEmployeeWallet.address, 0),
        'Granting BANK_EMPLOYEE to bank-employee wallet (PN A, user-gov setAddressPairApprovalStatus gate)',
      );

      const userGov = await privacyNodes.A.getContractAt<RNUserGovernanceV1>(
        'RNUserGovernanceV1', privacyNodes.A.raylsNodeUserGovernance,
        'RNUserGovernanceV1', bankEmployeeWallet,
      );
      const userId = ethers.keccak256(ethers.randomBytes(32));
      await expect(userGov.setAddressPairApprovalStatus(userId, ethers.Wallet.createRandom().address, ethers.Wallet.createRandom().address, 1)).to.be.revertedWithCustomError(userGov, 'RaylsAccessManaged__Unauthorized');
    }).timeout(DEFAULT_TIMEOUT);
  });

  // ============================================================
  // PNH — Token Registry Gating
  // ============================================================

  describe('PNH — Token Registry (TokenRegistryV1)', function () {

    it('user cannot call updateStatus (no PRIVATE_NETWORK_OPERATOR)', async function () {
      const userWallet = createUserOperator(privateHub.provider);
      const registry = await privateHub.getContractAt<TokenRegistryV1>(
        'TokenRegistryV1', privateHub.tokenRegistryAddress,
        'TokenRegistryV1', userWallet,
      );
      await expect(registry.updateStatus(token.resourceId, 1)).to.be.revertedWithCustomError(registry, 'RaylsAccessManaged__Unauthorized');
    }).timeout(DEFAULT_TIMEOUT);

    it('user cannot call freezeToken (no COMPLIANCE_OFFICER)', async function () {
      const userWallet = createUserOperator(privateHub.provider);
      const registry = await privateHub.getContractAt<TokenRegistryV1>(
        'TokenRegistryV1', privateHub.tokenRegistryAddress,
        'TokenRegistryV1', userWallet,
      );
      await expect(registry.freezeToken(token.resourceId, [privacyNodes.A.chainId])).to.be.revertedWithCustomError(registry, 'RaylsAccessManaged__Unauthorized');
    }).timeout(DEFAULT_TIMEOUT);

    it('networkOperator cannot call freezeToken (PRIVATE_NETWORK_OPERATOR lacks COMPLIANCE_OFFICER)', async function () {
      const operatorWallet = createUserOperator(privateHub.provider);
      const manager = await privateHub.getAccessManager();
      const roleId = await manager.getRoleIdByName('PRIVATE_NETWORK_OPERATOR');
      await submitTx(
        () => (manager.connect(privateHub.adminWallet) as typeof manager)
          .grantRole(roleId, operatorWallet.address, 0),
        'Granting PRIVATE_NETWORK_OPERATOR to operator (PNH, freezeToken gate)',
      );

      const registry = await privateHub.getContractAt<TokenRegistryV1>(
        'TokenRegistryV1', privateHub.tokenRegistryAddress,
        'TokenRegistryV1', operatorWallet,
      );
      await expect(registry.freezeToken(token.resourceId, [privacyNodes.A.chainId])).to.be.revertedWithCustomError(registry, 'RaylsAccessManaged__Unauthorized');
    }).timeout(DEFAULT_TIMEOUT);

    it('complianceOfficer cannot call updateStatus (COMPLIANCE_OFFICER lacks PRIVATE_NETWORK_OPERATOR)', async function () {
      const complianceWallet = createUserOperator(privateHub.provider);
      const manager = await privateHub.getAccessManager();
      // Grant PRIVATE_NETWORK_OPERATOR to a temp wallet so it can grant COMPLIANCE_OFFICER
      const tempOperator = createUserOperator(privateHub.provider);
      const networkOpRoleId = await manager.getRoleIdByName('PRIVATE_NETWORK_OPERATOR');
      await submitTx(
        () => (manager.connect(privateHub.adminWallet) as typeof manager)
          .grantRole(networkOpRoleId, tempOperator.address, 0),
        'Granting PRIVATE_NETWORK_OPERATOR to temp operator (PNH, updateStatus gate)',
      );
      const complianceRoleId = await manager.getRoleIdByName('COMPLIANCE_OFFICER');
      await submitTx(
        () => (manager.connect(tempOperator) as typeof manager)
          .grantRole(complianceRoleId, complianceWallet.address, 0),
        'Granting COMPLIANCE_OFFICER to compliance wallet via temp operator (PNH, updateStatus gate)',
      );

      const registry = await privateHub.getContractAt<TokenRegistryV1>(
        'TokenRegistryV1', privateHub.tokenRegistryAddress,
        'TokenRegistryV1', complianceWallet,
      );
      await expect(registry.updateStatus(token.resourceId, 1)).to.be.revertedWithCustomError(registry, 'RaylsAccessManaged__Unauthorized');
    }).timeout(DEFAULT_TIMEOUT);
  });

  // ============================================================
  // PNH — Teleport Gating
  // ============================================================

  describe('PNH — Teleport (TeleportV1)', function () {

    /** @deprecated Decommissioning Teleport (vanilla, atomic). */
    it('user cannot call executeAtomicMessageBatch (no RELAYER) @decommissioned', async function () {
      const userWallet = createUserOperator(privateHub.provider);
      const teleport = await privateHub.getContractAt<TeleportV1>(
        'TeleportV1', privateHub.teleportAddress,
        'TeleportV1', userWallet,
      );
      await expect(teleport.executeAtomicMessageBatch(['ag-victim'], '')).to.be.revertedWithCustomError(teleport, 'RaylsAccessManaged__Unauthorized');
    }).timeout(DEFAULT_TIMEOUT);
  });

  // ============================================================
  // PNH — Participant Storage Gating
  // ============================================================

  describe('PNH — Participant Storage (ParticipantStorageV1)', function () {

    it('user cannot call updateStatus (no PRIVATE_NETWORK_OPERATOR)', async function () {
      const userWallet = createUserOperator(privateHub.provider);
      const ps = await privateHub.getContractAt<ParticipantStorageV1>(
        'ParticipantStorageV1', privateHub.participantStorageAddress,
        'ParticipantStorageV1', userWallet,
      );
      await expect(ps.updateStatus(privacyNodes.A.chainId, 1)).to.be.revertedWithCustomError(ps, 'RaylsAccessManaged__Unauthorized');
    }).timeout(DEFAULT_TIMEOUT);
  });

  // ============================================================
  // Token operations — PUBLIC paths should work
  // ============================================================

  describe('Token operations — PUBLIC paths', function () {

    it('user can receive and transfer tokens (basic ops are PUBLIC)', async function () {
      const userWallet = createUserOperator(privacyNodes.A.provider);
      const mintAmount = BigInt(1000);
      const transferAmount = BigInt(100);

      // Mint to fresh userWallet
      await submitTx(
        () => token.contract.mint(userWallet.address, mintAmount),
        'Minting to userWallet',
      );

      // Connect token with fresh userWallet and transfer
      const tokenAsUser = token.contract.connect(userWallet) as typeof token.contract;
      const recipient = ethers.Wallet.createRandom().address;

      await submitTx(
        () => tokenAsUser.transfer(recipient, transferAmount),
        'Transferring tokens user -> recipient (PN A, PUBLIC path)',
      );

      const recipientBalance = await token.contract.balanceOf(recipient);
      expect(recipientBalance).to.equal(transferAmount);
    }).timeout(DEFAULT_TIMEOUT);
  });

  // ============================================================
  // Role Hierarchy — admin-of grants
  // ============================================================

  describe('Role Hierarchy — admin-of grants', function () {

    it('operator can grant BANK_EMPLOYEE (PRIVACY_NODE_OPERATOR is admin-of BANK_EMPLOYEE)', async function () {
      const operatorWallet = createUserOperator(privacyNodes.A.provider);
      const manager = await privacyNodes.A.getAccessManager();
      const operatorRoleId = await manager.getRoleIdByName('PRIVACY_NODE_OPERATOR');
      await submitTx(
        () => (manager.connect(privacyNodes.A.adminWallet) as typeof manager)
          .grantRole(operatorRoleId, operatorWallet.address, 0),
        'Granting PRIVACY_NODE_OPERATOR to operator (PN A, admin-of BANK_EMPLOYEE)',
      );

      const bankEmployeeRoleId = await manager.getRoleIdByName('BANK_EMPLOYEE');
      const newEmployee = ethers.Wallet.createRandom().address;

      const managerAsOperator = manager.connect(operatorWallet) as typeof manager;
      await submitTx(
        () => managerAsOperator.grantRole(bankEmployeeRoleId, newEmployee, 0),
        'Granting BANK_EMPLOYEE via operator (PN A, admin-of positive path)',
      );

      const [hasRole] = await manager.hasRole(bankEmployeeRoleId, newEmployee);
      expect(hasRole).to.be.true;
    }).timeout(DEFAULT_TIMEOUT);

    it('operator cannot grant PRIVACY_NODE_OPERATOR (PRIVACY_NODE_OPERATOR admin is ADMIN)', async function () {
      const operatorWallet = createUserOperator(privacyNodes.A.provider);
      const manager = await privacyNodes.A.getAccessManager();
      const operatorRoleId = await manager.getRoleIdByName('PRIVACY_NODE_OPERATOR');
      await submitTx(
        () => (manager.connect(privacyNodes.A.adminWallet) as typeof manager)
          .grantRole(operatorRoleId, operatorWallet.address, 0),
        'Granting PRIVACY_NODE_OPERATOR to operator (PN A, cannot-escalate gate)',
      );

      const newOperator = ethers.Wallet.createRandom().address;
      const managerAsOperator = manager.connect(operatorWallet) as typeof manager;
      await expect(managerAsOperator.grantRole(operatorRoleId, newOperator, 0))
        .to.be.revertedWithCustomError(notRoleAdminErr(await manager.getAddress(), privacyNodes.A.provider), 'RaylsAccessManagerV1__NotRoleAdmin');
    }).timeout(DEFAULT_TIMEOUT);

    it('PNH networkOperator can grant COMPLIANCE_OFFICER (PRIVATE_NETWORK_OPERATOR is admin-of COMPLIANCE_OFFICER)', async function () {
      const operatorWallet = createUserOperator(privateHub.provider);
      const manager = await privateHub.getAccessManager();
      const networkOperatorRoleId = await manager.getRoleIdByName('PRIVATE_NETWORK_OPERATOR');
      await submitTx(
        () => (manager.connect(privateHub.adminWallet) as typeof manager)
          .grantRole(networkOperatorRoleId, operatorWallet.address, 0),
        'Granting PRIVATE_NETWORK_OPERATOR to operator (PNH, admin-of COMPLIANCE_OFFICER)',
      );

      const complianceRoleId = await manager.getRoleIdByName('COMPLIANCE_OFFICER');
      const newOfficer = ethers.Wallet.createRandom().address;

      const managerAsOperator = manager.connect(operatorWallet) as typeof manager;
      await submitTx(
        () => managerAsOperator.grantRole(complianceRoleId, newOfficer, 0),
        'Granting COMPLIANCE_OFFICER via network operator (PNH, admin-of positive path)',
      );

      const [hasRole] = await manager.hasRole(complianceRoleId, newOfficer);
      expect(hasRole).to.be.true;
    }).timeout(DEFAULT_TIMEOUT);

    it('PNH networkOperator cannot grant PRIVATE_NETWORK_OPERATOR (admin is ADMIN)', async function () {
      const operatorWallet = createUserOperator(privateHub.provider);
      const manager = await privateHub.getAccessManager();
      const networkOperatorRoleId = await manager.getRoleIdByName('PRIVATE_NETWORK_OPERATOR');
      await submitTx(
        () => (manager.connect(privateHub.adminWallet) as typeof manager)
          .grantRole(networkOperatorRoleId, operatorWallet.address, 0),
        'Granting PRIVATE_NETWORK_OPERATOR to operator (PNH, cannot-escalate gate)',
      );

      const newOperator = ethers.Wallet.createRandom().address;
      const managerAsOperator = manager.connect(operatorWallet) as typeof manager;
      await expect(managerAsOperator.grantRole(networkOperatorRoleId, newOperator, 0))
        .to.be.revertedWithCustomError(notRoleAdminErr(await manager.getAddress(), privateHub.provider), 'RaylsAccessManagerV1__NotRoleAdmin');
    }).timeout(DEFAULT_TIMEOUT);
  });
});
