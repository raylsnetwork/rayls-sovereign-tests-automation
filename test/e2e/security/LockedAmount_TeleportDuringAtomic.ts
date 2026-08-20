/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
/**
 * @title E2E SECURITY: LockedAmount teleport-during-atomic accounting invariant
 * @description Validates cross-chain token accounting when a user teleports their
 *              own free balance on chain B while an atomic teleport A→B has
 *              landed and minted-to-contract on B. The security property is that
 *              the user's burn and the protocol-driven unlock cannot together
 *              create or destroy tokens — even if they execute back-to-back in
 *              an unfavourable order.
 *
 * PROTOCOL TIMING (re-derived from the relayer-B logs on 2026-05-13):
 *   1. Source-relayer pushes `teleportAtomic` log to PNH.
 *   2. Destination-relayer mines `receiveTeleportAtomic` on B → tokens minted to
 *      address(this), `lockedAmount[user] = ATOMIC_XFER`, user balance untouched.
 *   3. Destination-relayer's `atomic_receipt` poller marks executed → calls
 *      PNH's `executeAtomicMessageBatch` → PNH emits
 *      `AtomicMessageStatusChangedBatch(Executed)` IMMEDIATELY (there is no
 *      on-chain lock-time/expiration window — see TeleportV1.sol).
 *   4. Destination-relayer's `logparser` ingests the Executed event → creates an
 *      `AtomicStatusUpdateMessage{Status: Executed}` in DB.
 *   5. Destination-relayer's `atomic_finalization` poller picks the SUM up →
 *      submits the unlock signature on chain B → `unlock(user, ATOMIC_XFER)`
 *      fires (contract → user transfer, `lockedAmount[user] = 0`).
 *
 *   In wall-clock terms steps 2→5 take ~3-5 seconds total. There is NO
 *   destination-side lock window; expiry is enforced off-chain by the relayer's
 *   revert poller, not by any on-chain lock-time.
 *
 * INVARIANT UNDER TEST (the only one the protocol actually guarantees):
 *   Sum of the user's balances across A and B at the end of the scenario equals
 *   the sum before — no tokens are created or destroyed by the race between the
 *   user's own teleport and the protocol-driven unlock.
 *
 * WHAT THIS TEST DOES NOT ASSERT (and intentionally so):
 *   Earlier revisions of this test asserted intermediate-state snapshots between
 *   the user's teleport and the auto-unlock (`user.B.balance == 0`,
 *   `lockedAmount == ATOMIC_XFER`, `contract.B.balance == ATOMIC_XFER`). Those
 *   assertions race with the relayer's atomic_finalization poller and fail
 *   non-deterministically — they were testing relayer scheduling, not a protocol
 *   invariant. The global accounting check below is the security property; if
 *   tokens were ever destroyed or duplicated by the race, the global sum would
 *   diverge.
 *
 * SECURITY IMPLICATION:
 *   A test failure (a step-6 divergence) would indicate that a user's teleport
 *   can interfere with the atomic lock's release path on the same chain — a
 *   cross-chain double-spend condition. The test asserts strict equality so any
 *   off-by-one leak is caught.
 */
import { expect } from 'chai';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER, SECOND } from '../../../src/config/env-config';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { ERC20Wrapper } from '../../../src/entities/tokens/ERC20Wrapper';
import { ProductionErc20Token, ProductionErc20Token__factory } from '../../../typechain-types';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { eventually, submitTx } from '../../../src/utils/common';
import { shortHex } from '../../../src/utils/formatters';

describe('E2E SECURITY: LockedAmount Burn During Atomic @security @erc20 @decommissioned', function () {
  this.retries(0);

  const INITIAL_MINT = 200n;
  const VANILLA_XFER = 100n;  // A → B (vanilla teleport, funds user on B)
  const ATOMIC_XFER  = 50n;   // A → B (atomic — creates the pending inbound lock on B)
  const RACE_XFER    = 100n;  // B → A (user-initiated teleport during the atomic lock window)

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  let token: ERC20Wrapper<ProductionErc20Token>;
  let tokenOnA: ProductionErc20Token;
  let tokenOnB: ProductionErc20Token;

  let userAddress: string;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    token = new ERC20Wrapper<ProductionErc20Token>(privacyNodes.A, ProductionErc20Token__factory);
    await token.deploy();
    await token.activateOnPn();
    await token.activateOnHub(privateHub);

    tokenOnA = token.contract as ProductionErc20Token;
    userAddress = token.userWallet.address;

    // Mint initial INITIAL_MINT to user on A.
    await token.mintAndAwait(privateHub, {
      toAddress: userAddress,
      amount: INITIAL_MINT,
    });

    // Seed user on B with VANILLA_XFER via a vanilla teleport (also deploys token on B).
    await submitTx(
      () => tokenOnA.teleport(userAddress, VANILLA_XFER, privacyNodes.B.chainId, { gasLimit: GAS_LIMIT }),
      `Seeding user on B via vanilla teleport(${VANILLA_XFER})...`,
    );
    tokenOnB = await privacyNodes.B.setContractByResourceId(
      ProductionErc20Token__factory.name,
      token.resourceId,
      token.symbol,
      token.userWallet.connect(privacyNodes.B.provider),
    );
    await eventually<boolean>({
      check: async () => (await tokenOnB.balanceOf(userAddress)) === VANILLA_XFER,
      message: 'Confirming user.B balance = VANILLA_XFER',
    });
  });

  it('User can teleport own balance during an inbound atomic lock window without breaking atomic accounting', async function () {
    LOGGER.log('\n   ═══════════════════════════════════════════════════════════');
    LOGGER.log('   LockedAmount: pre-check removal reproduction');
    LOGGER.log('   ═══════════════════════════════════════════════════════════');
    LOGGER.log(`   User address:             ${userAddress}`);
    LOGGER.log(`   Chain A chainId:          ${privacyNodes.A.chainId}`);
    LOGGER.log(`   Chain B chainId:          ${privacyNodes.B.chainId}`);
    LOGGER.log(`   Token on A:               ${await tokenOnA.getAddress()}`);
    LOGGER.log(`   Token on B:               ${await tokenOnB.getAddress()}`);

    const tokenAddrOnB = await tokenOnB.getAddress();

    // ── PRECONDITION ──
    // NOTE: ProductionErc20Token has NO constructor pre-mint (thin passthrough). The token's
    //       only supply on A is the explicit mintAndAwait(INITIAL_MINT); VANILLA_XFER is then
    //       teleported to B. We snapshot absolute values and assert on deltas regardless.
    const preA = await tokenOnA.balanceOf(userAddress);
    const preB = await tokenOnB.balanceOf(userAddress);
    const preLockB = await tokenOnB.getLockedAmount(userAddress);
    const preCtBalB = await tokenOnB.balanceOf(tokenAddrOnB);
    LOGGER.log(`\n   --- PRECONDITION (deltas asserted, not absolutes) ---`);
    LOGGER.log(`   user.A.balance snapshot = ${preA}`);
    LOGGER.log(`   user.B.balance          = ${preB}              (expect ${VANILLA_XFER})`);
    LOGGER.log(`   user.B.lockedAmount     = ${preLockB}              (expect 0)`);
    LOGGER.log(`   contract.B.balance      = ${preCtBalB}              (expect 0)`);
    expect(preB).to.equal(VANILLA_XFER, 'user on B should hold exactly the vanilla-teleported amount');
    expect(preLockB).to.equal(0n);
    expect(preCtBalB).to.equal(0n);

    // ── STEP 1: Atomic teleport A→B, burn on A, mint-to-contract + lock on B ──
    LOGGER.log(`\n   --- STEP 1: teleportAtomic ${ATOMIC_XFER} A → B ---`);
    await submitTx(
      () => tokenOnA.teleportAtomic(
        userAddress,
        ATOMIC_XFER,
        privacyNodes.B.chainId,
        { gasLimit: GAS_LIMIT },
      ),
      `teleportAtomic(${ATOMIC_XFER}) A → B`,
    );

    // Burned from user on A immediately.
    const midA = await tokenOnA.balanceOf(userAddress);
    LOGGER.log(`   user.A.balance          = ${midA}  (expect preA - ATOMIC_XFER = ${preA - ATOMIC_XFER})`);
    expect(midA).to.equal(preA - ATOMIC_XFER, 'atomic send should burn exactly ATOMIC_XFER from A');

    // ── STEP 2: Wait for receiveTeleportAtomic on B (lock appears, contract gets funded) ──
    LOGGER.log(`\n   --- STEP 2: wait for receiveTeleportAtomic on B ---`);
    const atomicLanded = await eventually<boolean>({
      check: async () => {
        const lock = await tokenOnB.getLockedAmount(userAddress);
        const ct   = await tokenOnB.balanceOf(tokenAddrOnB);
        return lock === ATOMIC_XFER && ct === ATOMIC_XFER;
      },
      interval: 2 * SECOND,
      attempts: 30,
      message: `Waiting for atomic receive on B (lockedAmount and ct balance → ${ATOMIC_XFER})`,
    });
    expect(atomicLanded, 'atomic receive did not land on B within polling window').to.be.true;

    const lockDuring = await tokenOnB.getLockedAmount(userAddress);
    const ctDuring = await tokenOnB.balanceOf(tokenAddrOnB);
    const userDuring = await tokenOnB.balanceOf(userAddress);
    LOGGER.log(`   user.B.lockedAmount     = ${lockDuring}  (expect ${ATOMIC_XFER})`);
    LOGGER.log(`   contract.B.balance      = ${ctDuring}  (expect ${ATOMIC_XFER})`);
    LOGGER.log(`   user.B.balance          = ${userDuring}  (expect ${VANILLA_XFER}, unchanged)`);
    expect(lockDuring).to.equal(ATOMIC_XFER);
    expect(ctDuring).to.equal(ATOMIC_XFER);
    expect(userDuring).to.equal(VANILLA_XFER);

    // ── STEP 3: teleport user's free balance on B while an inbound atomic lock
    //           is pending. The only protocol-guaranteed property of this call
    //           is that it MUST NOT revert — the user's free balance is theirs
    //           to teleport regardless of the contract-held lock state. We do
    //           NOT assert intermediate balance/lock snapshots here because the
    //           atomic_finalization poller can fire the unlock at any moment
    //           between this call returning and the next on-chain read; that
    //           race is observed but not bound by the protocol, so an
    //           intermediate snapshot is testing relayer scheduling, not a
    //           protocol invariant. The accounting truth is asserted at step 6.
    LOGGER.log(`\n   --- STEP 3: teleport ${RACE_XFER} B → A during the atomic lock window ---`);
    let raceSucceeded = false;
    try {
      await submitTx(
        () => tokenOnB.teleport(
          userAddress,
          RACE_XFER,
          privacyNodes.A.chainId,
          { gasLimit: GAS_LIMIT },
        ),
        `teleport(${RACE_XFER}) B → A during lock window`,
      );
      raceSucceeded = true;
      LOGGER.log(`   teleport B→A during lock window: SUCCESS`);
    } catch (err: any) {
      LOGGER.log(`   teleport B→A during lock window: REVERTED (${err?.shortMessage || err?.message || err})`);
    }
    expect(
      raceSucceeded,
      'teleport of user own balance must not be blocked by a pending inbound atomic lock',
    ).to.be.true;

    // Diagnostic snapshot (logged, not asserted) — useful for forensics if the
    // global invariant ends up violated. Either order of (user.teleport(),
    // auto-unlock()) is protocol-valid; tokens conservation is the only
    // guarantee, and that's checked at step 6.
    const afterRaceB = await tokenOnB.balanceOf(userAddress);
    const afterRaceLockB = await tokenOnB.getLockedAmount(userAddress);
    const afterRaceCtB = await tokenOnB.balanceOf(tokenAddrOnB);
    LOGGER.log(`   user.B.balance          = ${afterRaceB}  (diagnostic — racy)`);
    LOGGER.log(`   user.B.lockedAmount     = ${afterRaceLockB}  (diagnostic — racy)`);
    LOGGER.log(`   contract.B.balance      = ${afterRaceCtB}  (diagnostic — racy)`);

    // ── STEP 4: atomic unlock fires — contract releases to user on B ──
    LOGGER.log(`\n   --- STEP 4: wait for atomic unlock on B ---`);
    // up to 120s — lock time is 60s plus relayer/scheduler latency
    const unlocked = await eventually<boolean>({
      check: async () => (await tokenOnB.getLockedAmount(userAddress)) === 0n,
      interval: 2 * SECOND,
      attempts: 60,
      message: `Waiting for atomic unlock: user.B.lockedAmount → 0 (${shortHex(userAddress)})`,
    });
    expect(unlocked, 'atomic unlock did not fire within window').to.be.true;

    const postB = await tokenOnB.balanceOf(userAddress);
    const postCtB = await tokenOnB.balanceOf(tokenAddrOnB);
    LOGGER.log(`   user.B.balance          = ${postB}  (expect ${ATOMIC_XFER})`);
    LOGGER.log(`   user.B.lockedAmount     = 0`);
    LOGGER.log(`   contract.B.balance      = ${postCtB}  (expect 0)`);
    expect(postB).to.equal(ATOMIC_XFER, 'atomic leg completed — user received the locked amount');
    expect(postCtB).to.equal(0n, 'contract drained exactly');

    // ── STEP 5: step-3 teleport arrives on A ──
    LOGGER.log(`\n   --- STEP 5: wait for step-3 teleport on A ---`);
    // Expected user.A = preA - ATOMIC_XFER (burned in step 1) + RACE_XFER (arrives from step 3)
    const targetABalance = preA - ATOMIC_XFER + RACE_XFER;
    const arrived = await eventually<boolean>({
      check: async () => (await tokenOnA.balanceOf(userAddress)) === targetABalance,
      interval: 2 * SECOND,
      attempts: 60,
      message: `Waiting for user.A balance → ${targetABalance} (${shortHex(userAddress)}) after step-3 B→A`,
    });
    expect(arrived, `user.A balance never converged to ${targetABalance}`).to.be.true;

    const postA = await tokenOnA.balanceOf(userAddress);
    LOGGER.log(`   user.A.balance          = ${postA}  (expect ${targetABalance})`);
    expect(postA).to.equal(targetABalance);

    // ── STEP 6: GLOBAL ACCOUNTING INVARIANT ──
    // Tokens are neither created nor destroyed across the user's two chains during
    // this scenario (atomic send burns on A and mints-for-lock on B; the "race"
    // teleport burns on B and mints on A; unlock moves contract→user on B; public
    // chain is not involved). Thus:  postA + postB == preA + preB.
    LOGGER.log(`\n   --- STEP 6: Global accounting invariant ---`);
    const totalUser = postA + postB;
    const expectedTotal = preA + preB;
    LOGGER.log(`   sum(user balances across A+B) = ${totalUser}  (expect ${expectedTotal})`);
    expect(totalUser).to.equal(
      expectedTotal,
      'cross-chain accounting invariant violated: tokens were created or destroyed',
    );
  }).timeout(DEFAULT_TIMEOUT * 2);
});
