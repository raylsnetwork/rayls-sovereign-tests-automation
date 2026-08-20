/**
 * @title E2E: All Token Handlers — Owner Local Mint After PN Registration
 *
 * SCENARIO:
 *   A token issuer deploys a token on their PL and wants to mint tokens
 *   locally — no cross-chain transfers, no hub activation, no public-chain
 *   deployment. Under the current token-registry model a local `mint(...)`
 *   still requires the token to be **registered and AUTHORIZED on the PN
 *   registry** (privacyNodeStatus == AUTHORIZED); it does NOT require a
 *   resourceId (hub leg) or ENDPOINT_SENDER authorization (endpoint leg).
 *
 * TESTED HANDLERS:
 *   1. RaylsErc20Handler   (via TokenExample)
 *   2. RaylsErc721Handler  (via RaylsErc721Example)
 *   3. RaylsErc1155Handler (via RaylsErc1155Example)
 *   4. RaylsErc721DvpHandler  (via Erc721DvpExample)
 *   5. RaylsErc1155DvpHandler (via Erc1155DvpExample)
 *
 * ANALYSIS:
 *   Every handler `mint(...)` is declared `restricted whenPrivacyNodeActive`.
 *   `whenPrivacyNodeActive` → RaylsApp._requirePrivacyNodeActive reverts
 *   `RaylsApp__PrivacyNodeNotActive` unless the token is AUTHORIZED on the PN
 *   registry. It fires BEFORE `_submitTokenUpdate`, so the old `resourceId==0`
 *   no-op guard is never the reason a mint succeeds — an unregistered token's
 *   mint reverts on-chain regardless. `restricted` is satisfied by the deployer:
 *   each handler constructor grants the owner (msg.sender at deploy) the mint/burn
 *   selectors, and the wrapper deploys + mints as its own userWallet.
 *
 *   These tests therefore register + approve each token on the PN registry
 *   (`activateOnPn` → privacyNodeStatus AUTHORIZED) and then mint. We
 *   deliberately do NOT call `activateOnHub`/`activateOnPublicChain`, so:
 *     - resourceId stays bytes32(0)          (no hub activation)
 *     - the token stays NOT ENDPOINT_SENDER  (no endpoint authorization)
 *   proving PN registration alone is sufficient — and necessary — for local mint.
 */

import { ethers } from 'ethers';
import { expect } from 'chai';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../src/config/env-config';
import { submitTx } from '../../../src/utils/common';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { ERC20Wrapper } from '../../../src/entities/tokens/ERC20Wrapper';
import { ERC721Wrapper } from '../../../src/entities/tokens/ERC721Wrapper';
import { ERC1155Wrapper } from '../../../src/entities/tokens/ERC1155Wrapper';
import {
  TokenExample,
  TokenExample__factory,
  RaylsErc721Example,
  RaylsErc721Example__factory,
  RaylsErc1155Example,
  RaylsErc1155Example__factory,
  Erc721DvpExample,
  Erc721DvpExample__factory,
  Erc1155DvpExample,
  Erc1155DvpExample__factory,
  EndpointV1,
  EndpointV1__factory,
  RaylsAccessManagerV1__factory,
} from '../../../typechain-types';

describe('E2E: All Token Handlers — Owner Local Mint After PN Registration', function () {
  this.timeout(DEFAULT_TIMEOUT);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  before(async function () {
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(1);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;
  });

  /**
   * Assert the token is NOT endpoint-authorized (no ENDPOINT_SENDER role) and carries no resourceId.
   * These stay true after `activateOnPn` — that step only flips privacyNodeStatus.
   */
  async function expectNotHubOrEndpointAuthorized(
    signer: ethers.Signer,
    endpointAddress: string,
    tokenAddress: string,
    resourceId: string,
  ): Promise<void> {
    const endpoint = EndpointV1__factory.connect(endpointAddress, signer) as unknown as EndpointV1;
    const managerAddr = await endpoint.authority();
    const manager = RaylsAccessManagerV1__factory.connect(managerAddr, signer);
    const roleId = await manager.getRoleIdByName('ENDPOINT_SENDER');
    const [isAuthorized] = await manager.hasRole(roleId, tokenAddress);
    expect(isAuthorized).to.equal(false, 'Token should NOT be ENDPOINT_SENDER authorized');
    expect(resourceId).to.equal(ethers.ZeroHash, 'resourceId should be zero (no hub activation)');
    LOGGER.log(`   Authorized on endpoint: ${isAuthorized} | resourceId: ${resourceId}`);
  }

  // ═══════════════════════════════════════════════════════════════
  //  ERC20
  // ═══════════════════════════════════════════════════════════════
  it('ERC20: owner should be able to mint locally after PN registration', async function () {
    LOGGER.log('\n── ERC20 Handler ──');

    const wrapper = new ERC20Wrapper<TokenExample>(privacyNodes.A, TokenExample__factory);
    wrapper.setFields('local-erc20');
    await wrapper.deploy();
    const token = wrapper.contract as TokenExample;
    const tokenAddress = wrapper.address[privacyNodes.A.chainId];
    const signer = wrapper.userWallet; // deployer = owner = constructor-premint recipient
    LOGGER.log(`   Deployed at: ${tokenAddress}`);

    await expectNotHubOrEndpointAuthorized(signer, privacyNodes.A.endpointAddress, tokenAddress, await token.resourceId());

    // PN registration is the precondition for `whenPrivacyNodeActive`.
    await wrapper.activateOnPn();

    // Constructor mints 2M to the deployer. Mint 500 more via the handler's restricted mint().
    const mintAmount = ethers.parseUnits('500', 18);
    LOGGER.log(`   Calling mint(${signer.address}, 500)...`);
    await submitTx(
      () => token.mint(signer.address, mintAmount, { gasLimit: GAS_LIMIT }),
      `ERC20 local mint 500 to owner`,
    );

    const balance = await token.balanceOf(signer.address);
    const expectedTotal = ethers.parseUnits('2000500', 18); // 2,000,000 ctor premint + 500
    expect(balance).to.equal(expectedTotal, 'Balance should include constructor + handler mint');
    LOGGER.log('   ✓ ERC20 local mint succeeded\n');
  });

  // ═══════════════════════════════════════════════════════════════
  //  ERC721
  // ═══════════════════════════════════════════════════════════════
  it('ERC721: owner should be able to mint locally after PN registration', async function () {
    LOGGER.log('\n── ERC721 Handler ──');

    const wrapper = new ERC721Wrapper<RaylsErc721Example>(privacyNodes.A, RaylsErc721Example__factory);
    wrapper.setFields('local-erc721');
    await wrapper.deploy();
    const token = wrapper.contract as RaylsErc721Example;
    const tokenAddress = wrapper.address[privacyNodes.A.chainId];
    const signer = wrapper.userWallet;
    LOGGER.log(`   Deployed at: ${tokenAddress}`);

    await expectNotHubOrEndpointAuthorized(signer, privacyNodes.A.endpointAddress, tokenAddress, await token.resourceId());

    await wrapper.activateOnPn();

    // Constructor mints tokenIds 0, 100, 150 to the deployer. Mint a fresh one via handler mint().
    const tokenId = 999;
    LOGGER.log(`   Calling mint(${signer.address}, ${tokenId})...`);
    await submitTx(
      () => token.mint(signer.address, tokenId, { gasLimit: GAS_LIMIT }),
      `ERC721 local mint #${tokenId} to owner`,
    );

    const ownerOfToken = await token.ownerOf(tokenId);
    expect(ownerOfToken).to.equal(signer.address, 'Signer should own the minted token');
    LOGGER.log('   ✓ ERC721 local mint succeeded\n');
  });

  // ═══════════════════════════════════════════════════════════════
  //  ERC1155
  // ═══════════════════════════════════════════════════════════════
  it('ERC1155: owner should be able to mint locally after PN registration', async function () {
    LOGGER.log('\n── ERC1155 Handler ──');

    const wrapper = new ERC1155Wrapper<RaylsErc1155Example>(privacyNodes.A, RaylsErc1155Example__factory);
    wrapper.setFields('local-erc1155');
    await wrapper.deploy();
    const token = wrapper.contract as RaylsErc1155Example;
    const tokenAddress = wrapper.address[privacyNodes.A.chainId];
    const signer = wrapper.userWallet;
    LOGGER.log(`   Deployed at: ${tokenAddress}`);

    await expectNotHubOrEndpointAuthorized(signer, privacyNodes.A.endpointAddress, tokenAddress, await token.resourceId());

    await wrapper.activateOnPn();

    // Mint tokenId=5, amount=200 via handler mint().
    const tokenId = 5;
    const mintAmount = 200;
    LOGGER.log(`   Calling mint(${signer.address}, id=${tokenId}, amount=${mintAmount})...`);
    await submitTx(
      () => token.mint(signer.address, tokenId, mintAmount, '0x', { gasLimit: GAS_LIMIT }),
      `ERC1155 local mint id=${tokenId} amount=${mintAmount} to owner`,
    );

    const balance = await token.balanceOf(signer.address, tokenId);
    expect(balance).to.equal(mintAmount, 'Balance should equal minted amount');
    LOGGER.log('   ✓ ERC1155 local mint succeeded\n');
  });

  // ═══════════════════════════════════════════════════════════════
  //  ERC721 DVP
  // ═══════════════════════════════════════════════════════════════
  it('ERC721Dvp: owner should be able to mint locally after PN registration', async function () {
    LOGGER.log('\n── ERC721 DVP Handler ──');

    const wrapper = new ERC721Wrapper<Erc721DvpExample>(privacyNodes.A, Erc721DvpExample__factory);
    wrapper.setFields('local-dvp721');
    await wrapper.deploy();
    const token = wrapper.contract as Erc721DvpExample;
    const tokenAddress = wrapper.address[privacyNodes.A.chainId];
    const signer = wrapper.userWallet;
    LOGGER.log(`   Deployed at: ${tokenAddress}`);

    await expectNotHubOrEndpointAuthorized(signer, privacyNodes.A.endpointAddress, tokenAddress, await token.resourceId());

    // activateOnPn only (NOT activateOnHub) — keep resourceId zero so the DvP mint's
    // `if (resourceId != 0)` cross-call branch is skipped and this stays a pure local mint.
    await wrapper.activateOnPn();

    // Mint tokenId=1 with empty extraData via handler mint().
    const tokenId = 1;
    LOGGER.log(`   Calling mint(${signer.address}, ${tokenId}, [])...`);
    await submitTx(
      () => token.mint(signer.address, tokenId, [], { gasLimit: GAS_LIMIT }),
      `ERC721Dvp local mint #${tokenId} to owner`,
    );

    const ownerOfToken = await token.ownerOf(tokenId);
    expect(ownerOfToken).to.equal(signer.address, 'Signer should own the minted token');
    LOGGER.log('   ✓ ERC721Dvp local mint succeeded\n');
  });

  // ═══════════════════════════════════════════════════════════════
  //  ERC1155 DVP
  // ═══════════════════════════════════════════════════════════════
  it('ERC1155Dvp: owner should be able to mint locally after PN registration', async function () {
    LOGGER.log('\n── ERC1155 DVP Handler ──');

    const wrapper = new ERC1155Wrapper<Erc1155DvpExample>(privacyNodes.A, Erc1155DvpExample__factory);
    wrapper.setFields('local-dvp1155');
    await wrapper.deploy();
    const token = wrapper.contract as Erc1155DvpExample;
    const tokenAddress = wrapper.address[privacyNodes.A.chainId];
    const signer = wrapper.userWallet;
    LOGGER.log(`   Deployed at: ${tokenAddress}`);

    await expectNotHubOrEndpointAuthorized(signer, privacyNodes.A.endpointAddress, tokenAddress, await token.resourceId());

    await wrapper.activateOnPn();

    // Mint tokenId=10, amount=50 with empty extraData + empty extras via handler mint().
    const tokenId = 10;
    const mintAmount = 50;
    LOGGER.log(`   Calling mint(${signer.address}, id=${tokenId}, amount=${mintAmount}, ...)...`);
    await submitTx(
      () => token.mint(signer.address, tokenId, mintAmount, '0x', [], { gasLimit: GAS_LIMIT }),
      `ERC1155Dvp local mint id=${tokenId} amount=${mintAmount} to owner`,
    );

    const balance = await token.balanceOf(signer.address, tokenId);
    expect(balance).to.equal(mintAmount, 'Balance should equal minted amount');
    LOGGER.log('   ✓ ERC1155Dvp local mint succeeded\n');
  });
});
