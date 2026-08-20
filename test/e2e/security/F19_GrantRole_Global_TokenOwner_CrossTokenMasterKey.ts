/**
 * @title E2E SECURITY: F19 — Global `TOKEN_OWNER` grant turns one call into a cross-token master key
 *
 * @description `RaylsAccessManagerV1.grantRole(TOKEN_OWNER=2, attacker, 0)` is
 *              accepted today. `TOKEN_OWNER` is declared per-contract in every
 *              self-registered token's bitmap (see
 *              `RaylsErc20Handler._registerAccessControl`), so a single GLOBAL
 *              grant passes `canCall` on EVERY such token. Admin (or any role
 *              admin) can issue the grant by mistake, producing an irreversible
 *              cross-token master key on the live network.
 *
 *              This E2E deploys two independent ProductionErc20Token instances on a
 *              single Privacy Node (they share the same PN AccessManager) and
 *              shows that ONE global grant lets an EOA mint supply on BOTH.
 *
 * EXPECTED BEHAVIOUR
 *   - Pre-fix: admin's `grantRole(TOKEN_OWNER, attacker, 0)` succeeds. Attacker
 *     mints REAL ERC20 supply on both tokens. Assertion `balances all zero`
 *     fails. The test FAILS with a detailed log trail showing the master key.
 *   - Post-fix: `grantRole(TOKEN_OWNER, ...)` reverts with
 *     `RaylsAccessManagerV1__TokenOwnerIsScopeOnly` (or the chosen equivalent).
 *     No grant lands, no mint succeeds, test PASSES.
 *
 * RESTORATION
 *   Pre-fix this test creates REAL supply on the live PN. The grant can be
 *   revoked in `after`, but the minted balances remain. Run
 *   `./start_dev.sh --clean 6` if you need a clean slate.
 */

import { ethers } from 'ethers';
import { expect } from 'chai';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { ERC20Wrapper } from '../../../src/entities/tokens/ERC20Wrapper';
import {
  RaylsAccessManagerV1,
  ProductionErc20Token,
  ProductionErc20Token__factory,
} from '../../../typechain-types';
import { createUserOperator } from '../../../src/utils/wallet-factory';

const ATTACKER_MINT_1 = ethers.parseUnits('1234', 18);
const ATTACKER_MINT_2 = ethers.parseUnits('5678', 18);
const TOKEN_OWNER_ROLE_ID = 2n;

describe('E2E SECURITY: F19 — Global TOKEN_OWNER grant is a cross-token master key', function () {
  this.timeout(DEFAULT_TIMEOUT);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let token1: ERC20Wrapper<ProductionErc20Token>;
  let token2: ERC20Wrapper<ProductionErc20Token>;
  let attacker: ethers.HDNodeWallet;
  let managerOnPN: RaylsAccessManagerV1;

  before(async function () {
    LOGGER.log('\n   ═══════════════════════════════════════════════════════════════');
    LOGGER.log('   F19: global TOKEN_OWNER grant → cross-token master key — E2E setup');
    LOGGER.log('   ═══════════════════════════════════════════════════════════════');

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    LOGGER.log(`   PN-A chainId         : ${privacyNodes.A.chainId}`);
    LOGGER.log(`   PNH chainId          : ${(await privateHub.provider.getNetwork()).chainId}`);

    // Two independent tokens on the SAME PN so they share the same AccessManager.
    // Each token calls `selfRegisterManagedContract` during construction, which
    // maps mint/burn to TOKEN_OWNER in its own bitmap.
    LOGGER.log('   Deploying token1 on PN-A and registering through PNH ...');
    token1 = new ERC20Wrapper<ProductionErc20Token>(privacyNodes.A, ProductionErc20Token__factory);
    token1.setFields('f19-t1');
    await token1.deploy();
    await token1.activateOnPn();
    await token1.activateOnHub(privateHub);
    LOGGER.log(`   token1.symbol        : ${token1.symbol}`);
    LOGGER.log(`   token1 addr on PN-A  : ${token1.address[privacyNodes.A.chainId]}`);

    LOGGER.log('   Deploying token2 on PN-A and registering through PNH ...');
    token2 = new ERC20Wrapper<ProductionErc20Token>(privacyNodes.A, ProductionErc20Token__factory);
    token2.setFields('f19-t2');
    await token2.deploy();
    await token2.activateOnPn();
    await token2.activateOnHub(privateHub);
    LOGGER.log(`   token2.symbol        : ${token2.symbol}`);
    LOGGER.log(`   token2 addr on PN-A  : ${token2.address[privacyNodes.A.chainId]}`);

    attacker = createUserOperator(privacyNodes.A.provider);
    // Fund for 2 tx.
    await (await privacyNodes.A.adminWallet.sendTransaction({
      to: attacker.address,
      value: ethers.parseEther('0.2'),
    })).wait();

    managerOnPN = await privacyNodes.A.getAccessManager();
    LOGGER.log(`   AccessManager (PN-A) : ${await managerOnPN.getAddress()}`);
    LOGGER.log(`   Attacker (no roles)  : ${attacker.address}`);
  });

  after(async function () {
    // Best-effort: revoke the attacker's TOKEN_OWNER grant if it landed so
    // subsequent tests are not polluted. Minted supply cannot be clawed back.
    try {
      const [hasRole] = await managerOnPN.hasRole(TOKEN_OWNER_ROLE_ID, attacker.address);
      if (hasRole) {
        LOGGER.log(`   Cleanup: revoking global TOKEN_OWNER from ${attacker.address}`);
        const tx = await managerOnPN.connect(privacyNodes.A.adminWallet).revokeRole(
          TOKEN_OWNER_ROLE_ID,
          attacker.address,
          { gasLimit: GAS_LIMIT }
        );
        await tx.wait();
      }
    } catch (e) {
      LOGGER.log(`   Cleanup failed: ${e}`);
    }
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  BASELINE  -  always pass
  // ════════════════════════════════════════════════════════════════════════════

  it('F19-E2E-baseline: attacker cannot mint on either token without any role', async function () {
    const mintSel = ProductionErc20Token__factory.createInterface().getFunction('mint')!.selector;
    const t1Addr = token1.address[privacyNodes.A.chainId];
    const t2Addr = token2.address[privacyNodes.A.chainId];

    const [a1] = await managerOnPN.canCall(attacker.address, t1Addr, mintSel);
    const [a2] = await managerOnPN.canCall(attacker.address, t2Addr, mintSel);
    LOGGER.log(`   canCall(attacker, token1, mint.sig).allowed = ${a1}`);
    LOGGER.log(`   canCall(attacker, token2, mint.sig).allowed = ${a2}`);
    expect(a1, 'baseline: canCall false for attacker on token1').to.equal(false);
    expect(a2, 'baseline: canCall false for attacker on token2').to.equal(false);
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  EXPLOIT  -  FAILS pre-fix, PASSES post-fix
  // ════════════════════════════════════════════════════════════════════════════

  it('F19-E2E-exploit: ONE global TOKEN_OWNER grant lets attacker mint on BOTH tokens', async function () {
    const t1Addr = token1.address[privacyNodes.A.chainId];
    const t2Addr = token2.address[privacyNodes.A.chainId];

    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 1: Baseline balances');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    const b1Before = await token1.getBalanceOf(attacker.address);
    const b2Before = await token2.getBalanceOf(attacker.address);
    const ts1Before = await (token1.contract as ProductionErc20Token).totalSupply();
    const ts2Before = await (token2.contract as ProductionErc20Token).totalSupply();
    LOGGER.log(`   token1  balance / totalSupply  : ${b1Before} / ${ts1Before}`);
    LOGGER.log(`   token2  balance / totalSupply  : ${b2Before} / ${ts2Before}`);

    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 2: Admin grants TOKEN_OWNER GLOBALLY to the attacker');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    let grantReverted = false;
    let grantRevertReason = '';
    let grantTxHash: string | null = null;
    try {
      const tx = await managerOnPN.connect(privacyNodes.A.adminWallet).grantRole(
        TOKEN_OWNER_ROLE_ID,
        attacker.address,
        0,
        { gasLimit: GAS_LIMIT }
      );
      const receipt = await tx.wait();
      grantTxHash = receipt!.hash;
      LOGGER.log(`   grantRole(TOKEN_OWNER, attacker, 0) SUCCEEDED tx=${grantTxHash}`);
    } catch (e: any) {
      grantReverted = true;
      grantRevertReason = e?.shortMessage || e?.message || String(e);
      LOGGER.log(`   grantRole reverted: ${grantRevertReason}`);
    }

    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 3: Attacker attempts to mint on BOTH tokens');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    const token1AsAttacker = ProductionErc20Token__factory.connect(t1Addr, attacker);
    const token2AsAttacker = ProductionErc20Token__factory.connect(t2Addr, attacker);

    let mint1Ok = false;
    let mint2Ok = false;
    try {
      const tx = await token1AsAttacker.mint(attacker.address, ATTACKER_MINT_1, { gasLimit: GAS_LIMIT });
      await tx.wait();
      mint1Ok = true;
      LOGGER.log(`   token1.mint SUCCEEDED — tx ${tx.hash}`);
    } catch (e: any) {
      LOGGER.log(`   token1.mint reverted: ${e?.shortMessage || e?.message}`);
    }
    try {
      const tx = await token2AsAttacker.mint(attacker.address, ATTACKER_MINT_2, { gasLimit: GAS_LIMIT });
      await tx.wait();
      mint2Ok = true;
      LOGGER.log(`   token2.mint SUCCEEDED — tx ${tx.hash}`);
    } catch (e: any) {
      LOGGER.log(`   token2.mint reverted: ${e?.shortMessage || e?.message}`);
    }

    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 4: Final state');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    const b1After = await token1.getBalanceOf(attacker.address);
    const b2After = await token2.getBalanceOf(attacker.address);
    const ts1After = await (token1.contract as ProductionErc20Token).totalSupply();
    const ts2After = await (token2.contract as ProductionErc20Token).totalSupply();
    LOGGER.log(`   token1  balance / totalSupply  : ${b1After} / ${ts1After}`);
    LOGGER.log(`   token2  balance / totalSupply  : ${b2After} / ${ts2After}`);

    if (mint1Ok || mint2Ok) {
      LOGGER.log('\n   ╔══════════════════════════════════════════════════════════╗');
      LOGGER.log('   ║   F19 EXPLOIT REPRODUCED — CROSS-TOKEN MASTER KEY         ║');
      LOGGER.log('   ╚══════════════════════════════════════════════════════════╝');
      LOGGER.log(`   Grantor                    : ${privacyNodes.A.adminWallet.address}`);
      LOGGER.log(`   Attacker (global TOKEN_OWNER): ${attacker.address}`);
      LOGGER.log(`   token1 (${t1Addr}) delta   : +${b1After - b1Before}`);
      LOGGER.log(`   token2 (${t2Addr}) delta   : +${b2After - b2Before}`);
      LOGGER.log(`   grantRole tx               : ${grantTxHash}`);
      LOGGER.log('   ───── ATTACK CHAIN ─────');
      LOGGER.log('   1. admin.grantRole(TOKEN_OWNER=2, attacker, 0)');
      LOGGER.log('      AccessManagerRoleConfigLib.grantRole rejects only PUBLIC (role 1);');
      LOGGER.log('      TOKEN_OWNER is accepted — write to globalGrants[attacker].');
      LOGGER.log('   2. attacker.mint on token1 / token2');
      LOGGER.log('      AccessManagerAuthLib._checkGlobalBitmap ORs TOKEN_OWNER into the');
      LOGGER.log('      selector bitmap for EVERY self-registered token.');
      LOGGER.log('      canCall returns (true, 0, false). `restricted` passes. Mint lands.');
      LOGGER.log('   ───── BLAST RADIUS ─────');
      LOGGER.log('   Every ERC20/721/1155 handler on this PN that self-registered with');
      LOGGER.log('   the owner-selector convention is now fully controllable by the attacker.');
    }

    // Assertion: attacker must not have gained balance on either token.
    expect(
      b1After - b1Before,
      'F19 EXPLOIT: attacker minted supply on token1 via global TOKEN_OWNER grant'
    ).to.equal(0n);
    expect(
      b2After - b2Before,
      'F19 EXPLOIT: attacker minted supply on token2 — cross-token master key confirmed'
    ).to.equal(0n);
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  POSTFIX POSITIVE CONTROL  -  always pass (pre- and post-fix)
  // ════════════════════════════════════════════════════════════════════════════

  it('F19-E2E-postfix: scoped grant (grantContractScopedRole) isolates authority per token', async function () {
    const t1Addr = token1.address[privacyNodes.A.chainId];
    const t2Addr = token2.address[privacyNodes.A.chainId];

    // Spin a fresh innocent wallet to keep state clean.
    const inn = createUserOperator(privacyNodes.A.provider);
    await (await privacyNodes.A.adminWallet.sendTransaction({
      to: inn.address,
      value: ethers.parseEther('0.1'),
    })).wait();

    // Grant scoped TOKEN_OWNER to token1 only.
    const tx = await managerOnPN.connect(privacyNodes.A.adminWallet).grantContractScopedRole(
      TOKEN_OWNER_ROLE_ID,
      inn.address,
      t1Addr,
      0,
      { gasLimit: GAS_LIMIT }
    );
    await tx.wait();

    const mintSel = ProductionErc20Token__factory.createInterface().getFunction('mint')!.selector;
    const [canT1] = await managerOnPN.canCall(inn.address, t1Addr, mintSel);
    const [canT2] = await managerOnPN.canCall(inn.address, t2Addr, mintSel);
    LOGGER.log(`   scoped grant canCall token1 = ${canT1}`);
    LOGGER.log(`   scoped grant canCall token2 = ${canT2}`);
    expect(canT1).to.equal(true);
    expect(canT2).to.equal(false);
  });
});
