/**
 * @title E2E SECURITY (ADVERSARIAL): Destination Relayer crashes 3x during revert → still exactly ONE re-credit (#68)
 *
 * Adversarial hardening of Enygma_DestRevertCrash_DoubleRevertBatch.ts. Instead of a single
 * crash + redelivery, this forces the SAME referenceId through crossTransferRevertBatch 4 times
 * (3 crash+restart cycles + a final clean pass) and asserts the sender is re-credited EXACTLY ONCE.
 *
 * Stresses the #68 idempotency guard (RaylsEnygmaHandler.crossTransferRevertBatch :479
 * referenceIdsStatus[refId]==REVERTED → no-op, set atomically with the sendTransferPNH emit) under
 * repeated NATS redelivery, plus the independent PL-A crossMint referenceId guard (:294-298) on the
 * re-credit leg. If either guard were weak, ≥2 re-credit mints would land on PL-A.
 *
 * TOKEN CHOICE (deliberate): ProductionEnygmaToken — seeded codehash, so the origin re-credit re-mint
 *   clears the programmability gate. See the sibling DoubleRevertBatch test header for why the example
 *   token would instead trip ProgramData__UnapprovedTemplate and miss this guard.
 *
 * FI (relayer-B, port 6661):
 *   fail_mint          (error, unlimited) — every redelivery re-enters the revert path
 *   after_revert_batch (crash, max_count 3) — crash after each of the first 3 revert-batch executions
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
const CRASH_CYCLES = 3;
const POST_RESTART_GRACE_MS = 60_000;

function fmt(amount: bigint): string {
  return ethers.formatUnits(amount, 18);
}

describe('E2E SECURITY (ADVERSARIAL): 3x dest-relayer crash during revert → exactly ONE re-credit (#68)', function () {
  this.timeout(DEFAULT_TIMEOUT * 15);

  let raylsNodes: PrivacyNodeMap;
  let commitChain: PrivateHub;
  let enygma: EnygmaWrapper<ProductionEnygmaToken>;
  let tokenOnA: ProductionEnygmaToken;
  let enygmaCC: EnygmaV1;
  let alice: ethers.HDNodeWallet;
  let faultB: FaultInjector;
  let sessionB: FaultSession;

  before(async function () {
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    raylsNodes = initializedNodes;
    commitChain = initializedPNH;

    faultB = FaultInjector.forRelayer('B', '127.0.0.1');
    expect(await faultB.isAlive()).to.equal(true, 'FI must be reachable on relayer-B (6661).');
    sessionB = await faultB.newSession();

    alice = createRandomWallet(raylsNodes.A.provider);
    await (await raylsNodes.A.adminWallet.sendTransaction({ to: alice.address, value: ethers.parseEther('5.0') })).wait();

    enygma = new EnygmaWrapper<ProductionEnygmaToken>(raylsNodes.A, ProductionEnygmaToken__factory);
    await enygma.deployViaFactory();
    await enygma.activateOnPn();
    await enygma.activateOnHub(commitChain);
    enygmaCC = commitChain.getPNHContract<EnygmaV1>(enygma.symbol);
    tokenOnA = raylsNodes.A.getContract<ProductionEnygmaToken>(enygma.symbol);

    await submitTx(() => tokenOnA.mint(alice.address, INITIAL_MINT, { gasLimit: GAS_LIMIT }), `Mint ${fmt(INITIAL_MINT)} to alice`);
    await eventually({ check: async () => (await tokenOnA.balanceOf(alice.address)) === INITIAL_MINT, message: 'mint balance' });

    // Gate on CC mint finalization before transferring: a mint is a PENDING commit-chain entry until a
    // later finalization tallies it; transferring before that proves against a zero finalized balance →
    // "Invalid public signal for balance" (non-retryable) → the transfer is dropped and PL-B never mints.
    // getTotalSupply() advances only on mint finalization (same gate as CcLedgerDoubleApply.ts).
    await eventually({ check: async () => (await enygmaCC.getTotalSupply()) === INITIAL_MINT, message: 'CC mint finalization (getTotalSupply == INITIAL_MINT)' });

    const aliceTok = tokenOnA.connect(alice) as ProductionEnygmaToken;
    await submitTx(
      () => aliceTok.linearCrossTransfer(raylsNodes.B.userWallet.address, TRANSFER_AMOUNT, raylsNodes.B.chainId,
        [], { gasLimit: 5_000_000 }), // plain transfer (no programmability) — issue/225 linearCrossTransfer signature
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
      message: 'token deploy on PL-B',
    });
    const tokenOnB = raylsNodes.B.getContract<ProductionEnygmaToken>(enygma.symbol);
    await eventually({ check: async () => (await tokenOnB.balanceOf(raylsNodes.B.userWallet.address)) === TRANSFER_AMOUNT, message: 'setup mint on PL-B' });
    await eventually({ check: async () => (await tokenOnA.balanceOf(alice.address)) === INITIAL_MINT - TRANSFER_AMOUNT, message: 'setup debit on PL-A' });
    await new Promise(r => setTimeout(r, 5_000));
    LOGGER.log('   Setup complete (fully settled)\n');
  });

  after(async function () {
    try {
      compose.restart('relayer-b');
      await faultB.waitUntilAlive(180_000);
      if (sessionB) await sessionB.clear();
    } catch { /* best-effort */ }
  });

  it(`survives ${CRASH_CYCLES}x crash during revert: sender re-credited exactly once`, async function () {
    const balanceBefore = await tokenOnA.balanceOf(alice.address); // == TRANSFER_AMOUNT
    const supplyBefore = await tokenOnA.totalSupply();
    expect(balanceBefore).to.equal(TRANSFER_AMOUNT, 'precondition: alice holds exactly the transfer amount');

    // fail_mint unlimited (every redelivery re-enters the revert path) + crash up to CRASH_CYCLES times.
    LOGGER.log(`\n   Arming fail_mint(error, unlimited) + after_revert_batch(crash, max_count ${CRASH_CYCLES}) on relayer-B`);
    await sessionB.arm({ point: FAULT_POINTS.FAIL_MINT, action: 'error', message: 'forced dest-mint failure (#68 triple-revert)', one_shot: false, max_count: 0 });
    await sessionB.arm({ point: FAULT_POINTS.AFTER_REVERT_BATCH, action: 'crash', one_shot: false, max_count: CRASH_CYCLES });

    const plABlockBefore = await raylsNodes.A.provider.getBlockNumber();
    const aliceTok = tokenOnA.connect(alice) as ProductionEnygmaToken;
    await submitTx(
      () => aliceTok.linearCrossTransfer(raylsNodes.B.userWallet.address, TRANSFER_AMOUNT, raylsNodes.B.chainId,
        [], { gasLimit: 5_000_000 }), // plain transfer (no programmability) — issue/225 linearCrossTransfer signature
      'Cross-transfer PL-A -> PL-B (test; dest mint fails → revert)',
    );

    // Drive CRASH_CYCLES crash+restart cycles; the same referenceId is reverted on each redelivery.
    for (let i = 1; i <= CRASH_CYCLES; i++) {
      LOGGER.log(`\n   Crash cycle ${i}/${CRASH_CYCLES}: waiting for relayer-B crash...`);
      await faultB.waitForCrash(180_000);
      compose.restart('relayer-b');
      await faultB.waitUntilAlive(180_000);
      LOGGER.log(`      relayer-B back up (cycle ${i})`);
    }

    // 4th delivery: crash max_count exhausted → revert completes (guard no-op) → message acks.
    // The final (crash-exhausted) redelivery completes the revert and re-credits alice. `eventually`
    // gates on the observable balance (no fixed sleep). Then, with FAIL_MINT still armed so NATS keeps
    // churning the revert path, hold a temporal invariant that NO second re-credit ever mints — mirrors
    // DoubleRevertBatch and fails fast on an idempotency-guard breakage instead of relying on the
    // post-hoc count alone. Clear FAIL_MINT only after the window so a late redelivery can't
    // mint-succeed on PL-B.
    LOGGER.log('\n   Waiting for the final (no-crash) redelivery + re-credit to settle on PL-A...');
    await eventually({
      check: async () => (await tokenOnA.balanceOf(alice.address)) >= balanceBefore,
      message: 'Waiting for the (single) re-credit on PL-A',
    });
    await never({
      check: async () => (await tokenOnA.queryFilter(
        tokenOnA.filters.Transfer(ethers.ZeroAddress, alice.address),
        plABlockBefore + 1,
        await raylsNodes.A.provider.getBlockNumber(),
      )).length > 1,
      message: 'Asserting no second re-credit on PL-A after 3x crash (adversarial invariant)',
      interval: 2_000,
      attempts: POST_RESTART_GRACE_MS / 2_000,
      tolerateErrors: true, // a transient PL-A RPC blip in the check means "not observed", never a false violation
    });
    await sessionB.clearPoint(FAULT_POINTS.FAIL_MINT);

    // DEFINITIVE: count Transfer(0 → alice) re-credit mints on PL-A across all the cycles.
    const plABlockAfter = await raylsNodes.A.provider.getBlockNumber();
    const reCredits = await tokenOnA.queryFilter(tokenOnA.filters.Transfer(ethers.ZeroAddress, alice.address), plABlockBefore + 1, plABlockAfter);
    const crashCount = await sessionB.triggerCount(FAULT_POINTS.AFTER_REVERT_BATCH);
    const finalBalance = await tokenOnA.balanceOf(alice.address);
    const finalSupply = await tokenOnA.totalSupply();
    LOGGER.log(`\n   after_revert_batch crashes: ${crashCount} (expected ${CRASH_CYCLES})`);
    LOGGER.log(`   PL-A re-credit mints Transfer(0→alice): ${reCredits.length} (expected 1)`);
    LOGGER.log(`   PL-A alice balance: ${fmt(finalBalance)} (expected ${fmt(balanceBefore)}); supply ${fmt(finalSupply)} (expected ${fmt(supplyBefore)})`);

    expect(crashCount).to.be.greaterThanOrEqual(CRASH_CYCLES,
      `revert batch must have crashed >=${CRASH_CYCLES}x for the same refId (got ${crashCount})`);
    expect(reCredits.length).to.equal(1,
      `MULTI-REVERT BREAK: ${reCredits.length} re-credit mints landed on PL-A for ONE transfer after ${CRASH_CYCLES} ` +
      `crash+redelivery cycles — crossTransferRevertBatch idempotency (RaylsEnygmaHandler.sol:479) and/or the PL-A ` +
      `crossMint guard (:294-298) failed under repeated redelivery.`);
    expect(finalBalance).to.equal(balanceBefore, `alice PL-A balance ${fmt(finalBalance)} != ${fmt(balanceBefore)}`);
    expect(finalSupply).to.equal(supplyBefore, `PL-A totalSupply ${fmt(finalSupply)} != ${fmt(supplyBefore)}`);

    LOGGER.log('\n   PASSED: exactly one re-credit after 3x crash — #68 guard holds adversarially');
  });
});
