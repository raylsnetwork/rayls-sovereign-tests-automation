/**
 * @title E2E: Enygma Owner Local Mint After PN Registration
 *
 * SCENARIO:
 *   A token issuer deploys an Enygma token on their PL and wants to mint tokens
 *   locally — no cross-chain transfers, no hub activation, no public-chain deploy.
 *   Under the current token-registry model a local `mint(...)` requires the token
 *   to be registered and AUTHORIZED on the PN registry (privacyNodeStatus ==
 *   AUTHORIZED); it does NOT require a resourceId (hub leg) or ENDPOINT_SENDER
 *   authorization (endpoint leg).
 *
 * ANALYSIS:
 *   `RaylsEnygmaHandler.mint` is `restricted whenPrivacyNodeActive`. `whenPrivacyNodeActive`
 *   → RaylsApp._requirePrivacyNodeActive reverts `RaylsApp__PrivacyNodeNotActive` unless the
 *   token is AUTHORIZED on the PN registry — that is why a raw-deployed token's mint reverts.
 *   The old "EnygmaPLEvents `onlyAuthorized` blocker" no longer applies: the cross-chain event
 *   call is now guarded — `if (resourceId != bytes32(0)) IEnygmaPNEvents(...).mint(...)`. With
 *   resourceId == 0 that branch is skipped, so a purely local mint never touches the endpoint
 *   authorization path. `restricted` is satisfied by the deployer, who holds TOKEN_OWNER scoped
 *   to the token (constructor grant).
 *
 *   This test therefore registers + approves the token on the PN registry
 *   (`activateOnPn` → privacyNodeStatus AUTHORIZED) and then mints. It deliberately does
 *   NOT activate the hub/public legs, so resourceId stays bytes32(0) and the token stays NOT
 *   ENDPOINT_SENDER — proving PN registration alone is sufficient (and necessary) for local mint.
 */

import { ethers } from 'ethers';
import { expect } from 'chai';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../src/config/env-config';
import { submitTx } from '../../../src/utils/common';
import { initializePrivacyNodes, PrivacyNodeMap } from '../../setup';
import { EnygmaWrapper } from '../../../src/entities/tokens/EnygmaWrapper';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
  EndpointV1,
  EndpointV1__factory,
  RaylsAccessManagerV1__factory,
} from '../../../typechain-types';

const MINT_AMOUNT = ethers.parseUnits('1000', 18);

describe('E2E: Enygma Owner Local Mint After PN Registration @hubless', function () {
  this.timeout(DEFAULT_TIMEOUT);

  let privacyNodes: PrivacyNodeMap;

  before(async function () {
    privacyNodes = await initializePrivacyNodes(1);
  });

  it('owner should be able to mint tokens locally on an Enygma token after PN registration', async function () {
    const endpointAddress = privacyNodes.A.endpointAddress;

    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   ENYGMA OWNER LOCAL MINT — AFTER PN REGISTRATION');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    // ─── Step 1: Constructor-deploy ProductionEnygmaToken (NOT via ContractFactory) ───
    LOGGER.log('\n   STEP 1: Constructor-deploy ProductionEnygmaToken on PN-A');
    const wrapper = new EnygmaWrapper<ProductionEnygmaToken>(privacyNodes.A, ProductionEnygmaToken__factory);
    wrapper.setFields('local-enygma');
    await wrapper.deploy();
    const token = wrapper.contract as ProductionEnygmaToken;
    const tokenAddress = wrapper.address[privacyNodes.A.chainId];
    const signer = wrapper.userWallet; // deployer = TOKEN_OWNER = mint recipient
    LOGGER.log(`   Endpoint address: ${endpointAddress}`);
    LOGGER.log(`   Deployer/Owner:   ${signer.address}`);
    LOGGER.log(`   Token deployed at: ${tokenAddress}`);

    // Verify deployer holds TOKEN_OWNER scoped to this token (constructor grant).
    const endpoint = EndpointV1__factory.connect(endpointAddress, signer) as unknown as EndpointV1;
    const managerAddr = await endpoint.authority();
    const manager = RaylsAccessManagerV1__factory.connect(managerAddr, signer);

    const TOKEN_OWNER = await manager.TOKEN_OWNER();
    const [isOwner] = await manager.hasContractScopedRole(TOKEN_OWNER, signer.address, tokenAddress);
    expect(isOwner).to.equal(true, 'Deployer should have TOKEN_OWNER on this token');
    LOGGER.log(`   Deployer has TOKEN_OWNER: ${isOwner}`);

    // ─── Step 2: Verify token is NOT ENDPOINT_SENDER authorized (no factory / hub leg) ───
    LOGGER.log('\n   STEP 2: Verify token is NOT authorized on endpoint');
    const roleId = await manager.getRoleIdByName('ENDPOINT_SENDER');
    const [isAuthorized] = await manager.hasRole(roleId, tokenAddress);
    LOGGER.log(`   Token authorized on endpoint: ${isAuthorized}`);
    expect(isAuthorized).to.equal(false, 'Token should NOT be ENDPOINT_SENDER authorized (constructor-deployed)');

    // ─── Step 3: Verify no hub activation (resourceId zero) ───
    LOGGER.log('\n   STEP 3: Verify no hub activation');
    const resourceId = await token.resourceId();
    LOGGER.log(`   resourceId: ${resourceId}`);
    expect(resourceId).to.equal(ethers.ZeroHash, 'resourceId should be zero (no hub activation)');

    // ─── Step 4: Register + approve on the PN registry (precondition for whenPrivacyNodeActive) ───
    LOGGER.log('\n   STEP 4: Register + approve on PN registry → privacyNodeStatus AUTHORIZED');
    await wrapper.activateOnPn();

    // ─── Step 5: Owner mints locally ───
    LOGGER.log('\n   STEP 5: Owner calls mint() for local use');
    LOGGER.log(`   mint(${signer.address}, ${ethers.formatUnits(MINT_AMOUNT, 18)})`);
    await submitTx(
      () => token.mint(signer.address, MINT_AMOUNT, { gasLimit: GAS_LIMIT }),
      `Enygma local mint ${ethers.formatUnits(MINT_AMOUNT, 18)} to owner`,
    );

    // ─── Step 6: Verify tokens were minted ───
    LOGGER.log('\n   STEP 6: Verify balance after mint');
    const balance = await token.balanceOf(signer.address);
    const totalSupply = await token.totalSupply();
    LOGGER.log(`   Balance:      ${ethers.formatUnits(balance, 18)}`);
    LOGGER.log(`   Total supply: ${ethers.formatUnits(totalSupply, 18)}`);

    expect(balance).to.equal(MINT_AMOUNT, 'Owner balance should equal minted amount');
    expect(totalSupply).to.equal(MINT_AMOUNT, 'Total supply should equal minted amount');

    LOGGER.log('\n   ✓ Local mint succeeded after PN registration (no hub/public activation)');
    LOGGER.log('═══════════════════════════════════════════════════════════════\n');
  });
});
