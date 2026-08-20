/**
 * @title E2E SECURITY: Emergency Pause — Contract Pause Enforcement
 * @description Validates the emergency pause mechanism:
 *   1. Paused contracts block ALL restricted calls with ContractPaused error
 *   2. Pause is isolated per contract — other contracts remain operational
 *   3. Unpause restores full access
 *   4. AccessManager itself cannot be paused (self-pause prevention)
 *   5. Paused calls revert with ContractPaused (not Unauthorized)
 */

import { expect } from 'chai';
import { ethers } from 'hardhat';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import {
  RNUserGovernanceV1,
  TokenRegistryV1,
  RaylsAccessManagerV1,
  ProductionErc20Token,
  ProductionErc20Token__factory,
  AccessManagerRoleConfigLib__factory,
} from '../../../typechain-types';
import { ERC20Wrapper } from '../../../src/entities/tokens/ERC20Wrapper';
import { createUserOperator } from '../../../src/utils/wallet-factory';
import { submitTx } from '../../../src/utils/common';

describe('E2E Security: Emergency Pause @authorization-pause @serial', function () {
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
    token.setFields('pause-test');
    await token.deploy();
    await token.activateOnPn();
    await token.activateOnHub(privateHub);
  });

  // ============================================================
  // PN — Pause Behavior
  // ============================================================

  describe('PN — Token Registry Pause', function () {

    afterEach(async function () {
      const manager = await privacyNodes.A.getAccessManager();
      const managerAsAdmin = manager.connect(privacyNodes.A.adminWallet) as typeof manager;
      const registryAddr = await (await privacyNodes.A.getPnTokenRegistry()).getAddress();
      try {
        await submitTx(
          () => managerAsAdmin.setContractPaused(registryAddr, false),
          'Unpausing PNTokenRegistryV1 (PN A teardown)',
        );
      } catch { /* already unpaused or never paused */ }
    });

    it('should block updatePrivacyNodeStatus when the PN TokenRegistry is paused', async function () {
      const manager = await privacyNodes.A.getAccessManager();
      const managerAsAdmin = manager.connect(privacyNodes.A.adminWallet) as typeof manager;
      const registry = await privacyNodes.A.getPnTokenRegistry(privacyNodes.A.adminWallet);
      const registryAddr = await registry.getAddress();

      await submitTx(
        () => managerAsAdmin.setContractPaused(registryAddr, true),
        'Pausing PNTokenRegistryV1 (PN A, updatePrivacyNodeStatus-blocked test)',
      );
      LOGGER.info('Paused PNTokenRegistryV1');

      // Pause wins over the ADMIN bypass in canCall — even adminWallet is blocked.
      await expect(
        registry.updatePrivacyNodeStatus(token.address[privacyNodes.A.chainId], 2)
      ).to.be.revertedWithCustomError(registry, 'RaylsAccessManaged__ContractPaused');
    }).timeout(DEFAULT_TIMEOUT);

    it('should not affect RNUserGovernance when the PN TokenRegistry is paused', async function () {
      const manager = await privacyNodes.A.getAccessManager();
      const managerAsAdmin = manager.connect(privacyNodes.A.adminWallet) as typeof manager;
      const registryAddr = await (await privacyNodes.A.getPnTokenRegistry()).getAddress();

      await submitTx(
        () => managerAsAdmin.setContractPaused(registryAddr, true),
        'Pausing PNTokenRegistryV1 (PN A, isolation test)',
      );

      // User governance should still work — create a user with PRIVACY_NODE_OPERATOR
      const userGov = await privacyNodes.A.getContractAt<RNUserGovernanceV1>(
        'RNUserGovernanceV1', privacyNodes.A.raylsNodeUserGovernance,
        'RNUserGovernanceV1', privacyNodes.A.operatorWallet,
      );
      const userId = ethers.keccak256(ethers.randomBytes(32));
      const tx = await userGov.createUser(userId, { gasLimit: GAS_LIMIT });
      const receipt = await tx.wait();
      expect(receipt!.status).to.equal(1);
    }).timeout(DEFAULT_TIMEOUT);

    it('should restore access after unpause', async function () {
      const manager = await privacyNodes.A.getAccessManager();
      const managerAsAdmin = manager.connect(privacyNodes.A.adminWallet) as typeof manager;
      const registryAddr = await (await privacyNodes.A.getPnTokenRegistry()).getAddress();

      await submitTx(
        () => managerAsAdmin.setContractPaused(registryAddr, true),
        'Pausing PNTokenRegistryV1 (PN A, unpause-restore test)',
      );
      expect(await manager.isContractPaused(registryAddr)).to.be.true;

      await submitTx(
        () => managerAsAdmin.setContractPaused(registryAddr, false),
        'Unpausing PNTokenRegistryV1 (PN A, unpause-restore test)',
      );
      expect(await manager.isContractPaused(registryAddr)).to.be.false;
    }).timeout(DEFAULT_TIMEOUT);

    it('should revert when trying to pause the PN AccessManager itself', async function () {
      const manager = await privacyNodes.A.getAccessManager();
      const managerAsAdmin = manager.connect(privacyNodes.A.adminWallet) as typeof manager;
      const managerAddress = await manager.getAddress();
      const roleConfigLib = AccessManagerRoleConfigLib__factory.connect(managerAddress, privacyNodes.A.adminWallet);

      await expect(
        managerAsAdmin.setContractPaused(managerAddress, true)
      ).to.be.revertedWithCustomError(roleConfigLib, 'RaylsAccessManagerV1__CannotPauseSelf');
    }).timeout(DEFAULT_TIMEOUT);
  });

  // ============================================================
  // PNH — Pause Behavior
  // ============================================================

  describe('PNH — Token Registry Pause', function () {

    afterEach(async function () {
      const manager = await privateHub.getAccessManager();
      const managerAsAdmin = manager.connect(privateHub.adminWallet) as typeof manager;
      try {
        await submitTx(
          () => managerAsAdmin.setContractPaused(privateHub.tokenRegistryAddress, false),
          'Unpausing PNH TokenRegistryV1 (teardown)',
        );
      } catch { /* already unpaused or never paused */ }
    });

    it('should block PRIVATE_NETWORK_OPERATOR from updateStatus when TokenRegistry is paused', async function () {
      const manager = await privateHub.getAccessManager();
      const managerAsAdmin = manager.connect(privateHub.adminWallet) as typeof manager;

      await submitTx(
        () => managerAsAdmin.setContractPaused(privateHub.tokenRegistryAddress, true),
        'Pausing PNH TokenRegistryV1 (updateStatus-blocked test)',
      );
      LOGGER.info('Paused PNH TokenRegistryV1');

      const tokenRegistry = await privateHub.getContractAt<TokenRegistryV1>(
        'TokenRegistryV1', privateHub.tokenRegistryAddress,
        'TokenRegistryV1', privateHub.operatorWallet,
      );
      await expect(
        tokenRegistry.updateStatus(token.resourceId, 1)
      ).to.be.revertedWithCustomError(tokenRegistry, 'RaylsAccessManaged__ContractPaused');
    }).timeout(DEFAULT_TIMEOUT);

    it('should block COMPLIANCE_OFFICER from freezeToken when TokenRegistry is paused', async function () {
      const manager = await privateHub.getAccessManager();
      const managerAsAdmin = manager.connect(privateHub.adminWallet) as typeof manager;

      await submitTx(
        () => managerAsAdmin.setContractPaused(privateHub.tokenRegistryAddress, true),
        'Pausing PNH TokenRegistryV1 (freezeToken-blocked test)',
      );

      const tokenRegistry = await privateHub.getContractAt<TokenRegistryV1>(
        'TokenRegistryV1', privateHub.tokenRegistryAddress,
        'TokenRegistryV1', privateHub.complianceWallet,
      );
      await expect(
        tokenRegistry.freezeToken(token.resourceId, [privacyNodes.A.chainId])
      ).to.be.revertedWithCustomError(tokenRegistry, 'RaylsAccessManaged__ContractPaused');
    }).timeout(DEFAULT_TIMEOUT);

    it('should restore PNH access after unpause', async function () {
      const manager = await privateHub.getAccessManager();
      const managerAsAdmin = manager.connect(privateHub.adminWallet) as typeof manager;

      await submitTx(
        () => managerAsAdmin.setContractPaused(privateHub.tokenRegistryAddress, true),
        'Pausing PNH TokenRegistryV1 (unpause-restore test)',
      );
      expect(await manager.isContractPaused(privateHub.tokenRegistryAddress)).to.be.true;

      await submitTx(
        () => managerAsAdmin.setContractPaused(privateHub.tokenRegistryAddress, false),
        'Unpausing PNH TokenRegistryV1 (unpause-restore test)',
      );
      expect(await manager.isContractPaused(privateHub.tokenRegistryAddress)).to.be.false;
    }).timeout(DEFAULT_TIMEOUT);

    it('should revert when trying to pause the PNH AccessManager itself', async function () {
      const manager = await privateHub.getAccessManager();
      const managerAsAdmin = manager.connect(privateHub.adminWallet) as typeof manager;
      const managerAddress = await manager.getAddress();
      const roleConfigLib = AccessManagerRoleConfigLib__factory.connect(managerAddress, privateHub.adminWallet);

      await expect(
        managerAsAdmin.setContractPaused(managerAddress, true)
      ).to.be.revertedWithCustomError(roleConfigLib, 'RaylsAccessManagerV1__CannotPauseSelf');
    }).timeout(DEFAULT_TIMEOUT);
  });

  // ============================================================
  // Error Discrimination
  // ============================================================

  describe('Error Discrimination', function () {

    afterEach(async function () {
      const manager = await privacyNodes.A.getAccessManager();
      const managerAsAdmin = manager.connect(privacyNodes.A.adminWallet) as typeof manager;
      const registryAddr = await (await privacyNodes.A.getPnTokenRegistry()).getAddress();
      try {
        await submitTx(
          () => managerAsAdmin.setContractPaused(registryAddr, false),
          'Unpausing PNTokenRegistryV1 (PN A error-disc teardown)',
        );
      } catch { /* already unpaused */ }
    });

    it('should revert with ContractPaused when contract is paused (not Unauthorized)', async function () {
      const manager = await privacyNodes.A.getAccessManager();
      const managerAsAdmin = manager.connect(privacyNodes.A.adminWallet) as typeof manager;
      const registry = await privacyNodes.A.getPnTokenRegistry(privacyNodes.A.adminWallet);
      const registryAddr = await registry.getAddress();

      await submitTx(
        () => managerAsAdmin.setContractPaused(registryAddr, true),
        'Pausing PNTokenRegistryV1 (PN A, error-discrimination test)',
      );

      // Paused → should get ContractPaused, NOT Unauthorized (pause wins over ADMIN bypass)
      await expect(
        registry.updatePrivacyNodeStatus(token.address[privacyNodes.A.chainId], 2)
      ).to.be.revertedWithCustomError(registry, 'RaylsAccessManaged__ContractPaused');
    }).timeout(DEFAULT_TIMEOUT);

    it('should revert with Unauthorized when role is missing (not ContractPaused)', async function () {
      const userWallet = createUserOperator(privacyNodes.A.provider);
      const registry = await privacyNodes.A.getPnTokenRegistry(userWallet);

      // Not paused, no role → should get Unauthorized, NOT ContractPaused
      await expect(
        registry.updatePrivacyNodeStatus(token.address[privacyNodes.A.chainId], 2)
      ).to.be.revertedWithCustomError(registry, 'RaylsAccessManaged__Unauthorized');
    }).timeout(DEFAULT_TIMEOUT);
  });
});
