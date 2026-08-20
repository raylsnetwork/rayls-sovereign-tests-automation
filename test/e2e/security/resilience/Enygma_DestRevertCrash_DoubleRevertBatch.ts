/**
 * @title E2E SECURITY: Destination Relayer Crash During Revert → crossTransferRevertBatch idempotency (#68)
 *
 * Regression-proof test for issue #68 (crossTransferRevertBatch idempotency). Complements the
 * SOURCE-revert test (Enygma_RevertCrash_DoubleRevertMint.ts, crossRevertMint / #70). It exercises
 * the DESTINATION-mint-failure revert path under a clean crash → NATS redelivery, and proves the
 * on-chain idempotency guard absorbs the redelivery so the sender is re-credited EXACTLY ONCE.
 *
 * GUARD UNDER TEST (version/3.0.1, added by PR #247 / issue #75):
 *   RaylsEnygmaHandler.crossTransferRevertBatch (:470-516) — `referenceIdsStatus[_referenceId] ==
 *   REVERTED → return` (:479). The referenceId is content-derived on PL-A (computeEnygmaReferenceId,
 *   :624) and carried verbatim through the relayer (never regenerated), so a redelivered revert
 *   reuses the SAME referenceId and the second crossTransferRevertBatch is a silent no-op.
 *
 * TOKEN CHOICE (deliberate): ProductionEnygmaToken — its runtime codehash is seeded as a template
 *   by the deploy-time seeder (seed-standard-templates.ts, RAYLS_ENYGMA_KEY), so the origin re-credit
 *   re-mint clears the programmability gate (templateRegistryReplica.check). The example token
 *   (EnygmaTokenExample) is factory-registered but NOT programmability-seeded, so it would revert the
 *   re-credit with ProgramData__UnapprovedTemplate and exercise the codehash gate instead of this
 *   idempotency guard — not what this test targets.
 *
 * DETERMINISM (lessons baked in):
 *   - Wait for the setup transfer to FULLY settle on PL-B (dest mint complete) BEFORE arming
 *     fail_mint — otherwise fail_mint-unlimited spuriously reverts the in-flight setup transfer
 *     (a second, distinct referenceId) and pollutes the count.
 *   - linearCrossTransfer has NO referenceId param; its 4th arg is `_callableResourceId`. Pass
 *     bytes32(0) (no callable). The contract generates the referenceId.
 *   - Send the sender's FULL balance so there is no Enygma "change" output (single transaction).
 *   - Assert the crash ACTUALLY fired (waitForCrash).
 *   - Count re-credits via ON-CHAIN `Transfer(address(0) → alice)` events on the PL-A token
 *     (definitive), not via balance inference.
 *
 * FI (relayer-B, port 6661):
 *   fail_mint          = enygma.handler.Receiver.HandleEnygmaCrossTransfer.fail_mint      (error, unlimited)
 *   after_revert_batch = enygma.handler.Receiver.HandleEnygmaCrossTransfer.after_revert_batch (crash, one-shot)
 *
 * EXPECTED: exactly one re-credit (guard holds). It would surface two re-credits if the
 * guard were removed.
 */

import { ethers } from 'ethers';
import { expect } from 'chai';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { createRandomWallet, eventually, never, submitTx } from '../../../../src/utils/common';
import { compose } from '../../../../src/utils/docker-compose';
import { FaultInjector, FaultSession, FAULT_POINTS } from '../../../../src/utils/fault-injector';
import {
  EndpointV1,
  EnygmaV1,
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
} from '../../../../typechain-types';

const TRANSFER_AMOUNT = ethers.parseUnits('5000', 18);
const INITIAL_MINT = TRANSFER_AMOUNT * 2n;
const POST_RESTART_GRACE_MS = 60_000;

function fmt(amount: bigint): string {
  return ethers.formatUnits(amount, 18);
}

describe('E2E SECURITY: Destination Relayer Crash During Revert → crossTransferRevertBatch idempotency (#68)', function () {
  this.timeout(DEFAULT_TIMEOUT * 10);

  let raylsNodes: PrivacyNodeMap;
  let commitChain: PrivateHub;

  let enygma: EnygmaWrapper<ProductionEnygmaToken>;
  let tokenOnA: ProductionEnygmaToken;
  let tokenOnB: ProductionEnygmaToken;
  let enygmaCC: EnygmaV1;

  let alice: ethers.HDNodeWallet;
  let faultB: FaultInjector;
  let sessionB: FaultSession;

  before(async function () {
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    raylsNodes = initializedNodes;
    commitChain = initializedPNH;

    faultB = FaultInjector.forRelayer('B', '127.0.0.1'); // destination relayer, port 6661
    expect(await faultB.isAlive()).to.equal(true, 'FI must be reachable on relayer-B (6661).');
    sessionB = await faultB.newSession();

    alice = createRandomWallet(raylsNodes.A.provider);
    await (await raylsNodes.A.adminWallet.sendTransaction({
      to: alice.address, value: ethers.parseEther('5.0'),
    })).wait();

    enygma = new EnygmaWrapper<ProductionEnygmaToken>(raylsNodes.A, ProductionEnygmaToken__factory);
    await enygma.deployViaFactory();
    await enygma.activateOnPn();
    await enygma.activateOnHub(commitChain);
    enygmaCC = commitChain.getPNHContract<EnygmaV1>(enygma.symbol);

    tokenOnA = raylsNodes.A.getContract<ProductionEnygmaToken>(enygma.symbol);
    await submitTx(
      () => tokenOnA.mint(alice.address, INITIAL_MINT, { gasLimit: GAS_LIMIT }),
      `Mint ${fmt(INITIAL_MINT)} to alice on PL-A`,
    );
    await eventually({
      check: async () => (await tokenOnA.balanceOf(alice.address)) === INITIAL_MINT,
      message: 'Waiting for alice mint balance',
    });

    // Gate on CC mint finalization before transferring. A mint lands as a PENDING entry on the commit
    // chain and is only spendable once a later finalization tallies it (async; driven by the relayer's
    // finalization reconciler). Transferring before that proves against a zero finalized balance →
    // EnygmaV1.transferBatch reverts with "Invalid public signal for balance", which the relayer treats
    // as NON-RETRYABLE → the cross-transfer is dropped (sender re-credited) and PL-B never mints, hanging
    // this setup. getTotalSupply() advances only on mint finalization, so it is the precise "mint is
    // spendable" signal (same gate as Enygma_CrashRecovery_CcLedgerDoubleApply.ts).
    await eventually({
      check: async () => (await enygmaCC.getTotalSupply()) === INITIAL_MINT,
      message: 'Waiting for CC mint finalization (getTotalSupply == INITIAL_MINT) before transfer',
    });

    // First (clean) cross-transfer establishes the token on PL-B BEFORE any fault is armed.
    const tokenOnAAsAlice = tokenOnA.connect(alice) as ProductionEnygmaToken;
    await submitTx(
      () => tokenOnAAsAlice.linearCrossTransfer(
        raylsNodes.B.userWallet.address, TRANSFER_AMOUNT, raylsNodes.B.chainId,
        [], { gasLimit: 5_000_000 }, // plain transfer (no programmability) — issue/225 linearCrossTransfer signature
      ),
      `Cross-transfer ${fmt(TRANSFER_AMOUNT)} PL-A -> PL-B (setup)`,
    );
    await eventually({
      check: async () => {
        const endpoint = raylsNodes.B.getContract<EndpointV1>('EndpointV1');
        const addr = await endpoint.getAddressByResourceId(enygma.resourceId);
        if (addr === ethers.ZeroAddress) return false;
        enygma.address[raylsNodes.B.chainId] = addr;
        await raylsNodes.B.getContractAt(ProductionEnygmaToken__factory.name, addr, enygma.symbol);
        return true;
      },
      message: 'Waiting for token deployment on PL-B',
    });
    tokenOnB = raylsNodes.B.getContract<ProductionEnygmaToken>(enygma.symbol);

    // CRITICAL for determinism: wait for the setup transfer to FULLY settle on BOTH sides
    // (PL-A debited AND PL-B minted) so no setup-related message is still in flight when we
    // arm fail_mint — otherwise fail_mint would spuriously revert the setup transfer too.
    await eventually({
      check: async () => (await tokenOnB.balanceOf(raylsNodes.B.userWallet.address)) === TRANSFER_AMOUNT,
      message: 'Waiting for setup transfer to mint on PL-B',
    });
    await eventually({
      check: async () => (await tokenOnA.balanceOf(alice.address)) === INITIAL_MINT - TRANSFER_AMOUNT,
      message: 'Waiting for setup transfer to debit on PL-A',
    });
    // Small settle buffer so any trailing setup acks are done before we arm faults.
    await new Promise(r => setTimeout(r, 5_000));
    LOGGER.log('   Setup complete (setup transfer fully settled on PL-A and PL-B)\n');
  });

  after(async function () {
    // relayer-B's process may be crashed AND fail_mint is persisted (unlimited), so always do a
    // clean restart, wait for FI, then clear our session (restored under the same id) to remove it.
    try {
      compose.restart('relayer-b');
      await faultB.waitUntilAlive(180_000);
      if (sessionB) await sessionB.clear();
    } catch { /* best-effort cleanup */ }
  });

  it('destination relayer crash during revert: sender is re-credited exactly once (guard holds)', async function () {
    const balanceBefore = await tokenOnA.balanceOf(alice.address); // == TRANSFER_AMOUNT (full balance)
    const supplyBefore = await tokenOnA.totalSupply();
    const ccSupplyBefore = await enygmaCC.getTotalSupply();
    expect(balanceBefore).to.equal(TRANSFER_AMOUNT, 'precondition: alice holds exactly the transfer amount (no change output)');
    LOGGER.log(`   PL-A alice balance before: ${fmt(balanceBefore)}; supply: ${fmt(supplyBefore)}`);

    // 1. Arm: force dest mint failure (unlimited → redelivery also takes the revert path so the
    //    guard is actually exercised) + crash once after the revert batch is mined.
    LOGGER.log('\n   1. Arming fail_mint(error, unlimited) + after_revert_batch(crash, one-shot) on relayer-B');
    await sessionB.arm({ point: FAULT_POINTS.FAIL_MINT, action: 'error', message: 'forced dest-mint failure (#68 test)', one_shot: false, max_count: 0 });
    await sessionB.arm({ point: FAULT_POINTS.AFTER_REVERT_BATCH, action: 'crash', one_shot: true });

    // 2. Full-balance cross-transfer (no change output → single transaction → single referenceId).
    LOGGER.log(`\n   2. Submitting cross-transfer ${fmt(TRANSFER_AMOUNT)} PL-A -> PL-B (dest mint will fail → revert)`);
    const plABlockBefore = await raylsNodes.A.provider.getBlockNumber();
    const tokenOnAAsAlice = tokenOnA.connect(alice) as ProductionEnygmaToken;
    await submitTx(
      () => tokenOnAAsAlice.linearCrossTransfer(
        raylsNodes.B.userWallet.address, TRANSFER_AMOUNT, raylsNodes.B.chainId,
        [], { gasLimit: 5_000_000 }, // plain transfer (no programmability) — issue/225 linearCrossTransfer signature
      ),
      'Cross-transfer PL-A -> PL-B (test transfer; dest mint fails)',
    );

    // 3. The crash MUST fire (after the first crossTransferRevertBatch is mined on PL-B).
    LOGGER.log('\n   3. Waiting for relayer-B to crash at after_revert_batch...');
    await faultB.waitForCrash(180_000);
    LOGGER.log('      Relayer-B down — crash fired after first crossTransferRevertBatch was mined');

    // 4. Restart relayer-B → propagate first revert to PL-A + NATS redelivery → second revert (guarded no-op).
    LOGGER.log('\n   4. Restarting relayer-B (propagate first revert + redelivery → guarded second revert)');
    compose.restart('relayer-b');
    await faultB.waitUntilAlive(180_000);

    // 5. Wait for the re-credit to land on PL-A.
    LOGGER.log('\n   5. Waiting for re-credit on PL-A (alice back to balanceBefore)...');
    await eventually({
      check: async () => (await tokenOnA.balanceOf(alice.address)) >= balanceBefore,
      message: 'Waiting for crossTransferRevertBatch re-credit on PL-A',
    });

    // 6. FAIL_MINT is still armed, so NATS redelivery keeps re-entering the revert path. Assert as a
    //    temporal invariant that NO second re-credit ever mints during the window — fails fast on a
    //    guard breakage instead of passively sleeping (CLAUDE.md: `never` for "must NOT happen").
    LOGGER.log(`\n   6. Asserting no second re-credit for ${POST_RESTART_GRACE_MS / 1000}s during the redelivery window...`);
    await never({
      check: async () => (await tokenOnA.queryFilter(
        tokenOnA.filters.Transfer(ethers.ZeroAddress, alice.address),
        plABlockBefore + 1,
        await raylsNodes.A.provider.getBlockNumber(),
      )).length > 1,
      message: 'Asserting no double re-credit on PL-A during the redelivery grace window',
      interval: 2_000,
      attempts: POST_RESTART_GRACE_MS / 2_000,
      tolerateErrors: true, // a transient PL-A RPC blip in the check means "not observed", never a false violation
    });
    await sessionB.clearPoint(FAULT_POINTS.FAIL_MINT); // resume normal relayer-B operation

    // 7. DEFINITIVE on-chain assertion: count Transfer(address(0) → alice) re-credit mints on PL-A.
    LOGGER.log('\n   7. Counting on-chain re-credit mints Transfer(0 → alice) on PL-A');
    const plABlockAfter = await raylsNodes.A.provider.getBlockNumber();
    const reCredits = await tokenOnA.queryFilter(
      tokenOnA.filters.Transfer(ethers.ZeroAddress, alice.address),
      plABlockBefore + 1,
      plABlockAfter,
    );
    const finalBalance = await tokenOnA.balanceOf(alice.address);
    const finalSupply = await tokenOnA.totalSupply();
    LOGGER.log(`      Transfer(0→alice) re-credit mints: ${reCredits.length} (expected 1)`);
    LOGGER.log(`      PL-A alice balance: ${fmt(finalBalance)} (expected ${fmt(balanceBefore)}); supply: ${fmt(finalSupply)} (expected ${fmt(supplyBefore)})`);

    expect(reCredits.length).to.equal(1,
      `DOUBLE REVERT: ${reCredits.length} re-credit mints (Transfer 0→alice) landed on PL-A for one ` +
      `transfer (expected 1). crossTransferRevertBatch idempotency guard (RaylsEnygmaHandler.sol:479) ` +
      `failed to absorb the destination-relayer crash + NATS redelivery.`,
    );
    expect(finalBalance).to.equal(balanceBefore,
      `alice PL-A balance ${fmt(finalBalance)} != expected ${fmt(balanceBefore)} (over/under re-credit).`,
    );
    expect(finalSupply).to.equal(supplyBefore,
      `PL-A totalSupply ${fmt(finalSupply)} != expected ${fmt(supplyBefore)} (re-credit not conserved).`,
    );

    // Context: the revert must not inflate the CC homomorphic ledger's total supply.
    expect(await enygmaCC.getTotalSupply()).to.equal(ccSupplyBefore, 'CC totalSupply moved on the revert path');

    LOGGER.log('\n   PASSED: single re-credit; #68 guard holds end-to-end under crash-recovery');
  });
});
