/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
import { expect } from 'chai';
import {
  PNTokenRegistryV1,
  ProductionErc20Token,
  ProductionErc20Token__factory,
  PublicChainERC20__factory,
  RaylsPublicERC20Handler__factory,
} from '../../../typechain-types';
import { ethers } from 'ethers';
import {
  DEFAULT_TIMEOUT,
  GAS_LIMIT,
  LOGGER,
  PRIVATE_KEY_SYSTEM,
  PUBLIC_CHAIN_RPC_URL,
  ZERO_ADDRESS,
} from '../../../src/config/env-config';
import { ERC20Wrapper } from '../../../src/entities/tokens/ERC20Wrapper';
import { eventually, sendTx } from '../../../src/utils/common';
import { getProvider } from '../../../src/utils/network-utils';
import { initializePrivacyNodes, PrivacyNodeMap } from '../../setup';
import {
  cleanupPublicFrozenTokens,
  freezeOnPublicChain,
  unfreezeOnPublicChain,
} from '../../test-utils/freeze-helpers';

describe('E2E Tests: ERC20 Public Chain Transfer @decommissioned @hubless', function () {
  const MINT_AMOUNT = 2000n;
  const TRANSFER_AMOUNT = 100n;
  const BATCH_SIZE = 200;
  const BATCH_TRANSFER_AMOUNT = 5n;
  const TX_OPTS = { gasLimit: GAS_LIMIT } as const;
  const PC_CHAIN_ID = process.env.PUBLIC_CHAIN_ID || '7331';

  let privacyNodes: PrivacyNodeMap;

  let user: {
    userId: string;
    publicAddress: string;
    privateAddress: string;
    publicPrivateKey: string;
    privatePrivateKey: string;
  };

  let tokenWrapper: ERC20Wrapper<ProductionErc20Token>;
  let tokenAddress: string;
  let publicTokenAddress: string;
  // Admin-connected PN registry — freezeOnPublicChain is `restricted` (ADMIN bypass).
  let tokenRegistryOnA: PNTokenRegistryV1;

  // Shared signers (initialized in before)
  let publicProvider: ethers.JsonRpcProvider;
  let userPrivateSigner: ethers.Wallet;
  let userPublicSigner: ethers.Wallet;
  let systemPublicSigner: ethers.Wallet;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    // Public-chain teleport is PN-side + relayer-driven — no PrivateHub involvement.
    // Single-node init, then the operator + bank-employee grants the user-creation flow needs.
    privacyNodes = await initializePrivacyNodes(1);

    // Create and approve user via governance contracts
    const userGovAsOperator = await privacyNodes.A.getUserGovernance();
    const userGovAsBankEmployee = await privacyNodes.A.getContractAt(
      'RNUserGovernanceV1', privacyNodes.A.raylsNodeUserGovernance,
      'RNUserGovernanceV1', privacyNodes.A.bankEmployeeWallet,
    ) as any;
    const userId = ethers.keccak256(ethers.randomBytes(32));
    const publicWallet = ethers.Wallet.createRandom();
    const privateWallet = ethers.Wallet.createRandom();

    await sendTx(() => userGovAsOperator.createUser(userId), 'createUser');
    await sendTx(
      () => userGovAsBankEmployee.addAddressPair(userId, publicWallet.address, privateWallet.address),
      'addAddressPair',
    );
    await sendTx(() => userGovAsOperator.approveUser(userId), 'approveUser');

    user = {
      userId,
      publicAddress: publicWallet.address,
      privateAddress: privateWallet.address,
      publicPrivateKey: publicWallet.privateKey,
      privatePrivateKey: privateWallet.privateKey,
    };

    LOGGER.info(`User created: ${user.publicAddress}`);

    // Shared signers
    publicProvider = getProvider(PUBLIC_CHAIN_RPC_URL);
    userPrivateSigner = new ethers.Wallet(user.privatePrivateKey, privacyNodes.A.provider);
    userPublicSigner = new ethers.Wallet(user.publicPrivateKey, publicProvider);
    systemPublicSigner = new ethers.Wallet(PRIVATE_KEY_SYSTEM, publicProvider);

    // Public-chain activation flow (PNTokenRegistryV1): constructor-deploy the production
    // token (userWallet = deployer = owner, can mint), register + approve on the PN registry,
    // then submit to the public chain so the relayer deploys the public token.
    tokenWrapper = new ERC20Wrapper(privacyNodes.A, ProductionErc20Token__factory);
    await tokenWrapper.deploy();
    tokenAddress = tokenWrapper.address[privacyNodes.A.chainId];
    LOGGER.info(`ERC20 deployed at: ${tokenAddress}`);

    await tokenWrapper.activateOnPn(); // PN authorization — shared prerequisite
    publicTokenAddress = await tokenWrapper.activateOnPublicChain();
    LOGGER.info(`Public token at: ${publicTokenAddress}`);

    tokenRegistryOnA = await privacyNodes.A.getPnTokenRegistry(privacyNodes.A.adminWallet);

    // Fund user on public chain for gas (one-time). The public chain is non-gasless
    // (~48 Gwei base fee): each tx reserves GAS_LIMIT * maxFeePerGas (~1.44 ETH) up
    // front but is refunded after, so a few ETH covers the suite's sequential txs.
    // (Was 100 ETH — wasteful on a shared non-gasless chain; it drained the deployer.)
    await fundPublicChainAddress(user.publicAddress, '5');
  });

  beforeEach(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    // Mint fresh tokens so each test starts with a known available balance.
    // Use direct contract mint (tokenWrapper.contract uses deployer/owner signer).
    await sendTx(
      () => tokenWrapper.contract.mint(user.privateAddress, MINT_AMOUNT, TX_OPTS),
      'mint fresh tokens',
    );
  });

  it('Should transfer ERC20 tokens to public chain @smoke', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const token = getPrivateToken();
    const lockedBefore = await token.getLockedAmount(user.privateAddress);
    const publicBalBefore = await getPublicBalance();

    await sendTokenToPublicChain(TRANSFER_AMOUNT);

    // Verify tokens locked on private chain
    const newLocked = await token.getLockedAmount(user.privateAddress);
    expect(newLocked).to.be.gt(lockedBefore);

    // Verify tokens arrived on public chain
    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance();
        return bal >= publicBalBefore + TRANSFER_AMOUNT;
      },
      interval: 2000,
      attempts: 30,
      message: `Waiting for public balance → ${publicBalBefore + TRANSFER_AMOUNT}`,
    });

    LOGGER.info('Public chain balance verified');
  }).timeout(DEFAULT_TIMEOUT);

  it('Should transfer ERC20 tokens back from public to private chain @smoke', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const token = getPrivateToken();
    const lockedBefore = await token.getLockedAmount(user.privateAddress);
    const publicBalBefore = await getPublicBalance();

    // Send to public first
    await sendTokenToPublicChain(TRANSFER_AMOUNT);

    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance();
        return bal >= publicBalBefore + TRANSFER_AMOUNT;
      },
      interval: 2000,
      attempts: 30,
      message: `Waiting for public balance → ${publicBalBefore + TRANSFER_AMOUNT} (reverse-flow setup)`,
    });

    // Snapshot balance BEFORE burn (race: relayer may unlock before we read)
    const balanceBeforeBurn = await token.balanceOf(user.privateAddress);

    // Burn on public chain -> relayer unlocks on private
    await burnTokensOnPublicChain(user.privateAddress, TRANSFER_AMOUNT);

    // Verify unlock: the send+burn cycle must net to zero — locked back to lockedBefore exactly
    // and balance recovered by exactly TRANSFER_AMOUNT from the pre-burn snapshot.
    await eventually<boolean>({
      check: async () => {
        const locked = await token.getLockedAmount(user.privateAddress);
        const balance = await token.balanceOf(user.privateAddress);
        LOGGER.info(`Reverse check — balance: ${balance}, locked: ${locked}`);
        return locked === lockedBefore && balance === balanceBeforeBurn + TRANSFER_AMOUNT;
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for Public→Private unlock (locked → ${lockedBefore}, balance → ${balanceBeforeBurn + TRANSFER_AMOUNT})`,
    });

    LOGGER.info('Reverse transfer verified');
  }).timeout(DEFAULT_TIMEOUT);

  it('Should revert teleportToPublicChain to address(0) and preserve tokens @smoke', async function () {
    this.timeout(DEFAULT_TIMEOUT * 3);

    const token = getPrivateToken();
    const initialBalance = await token.balanceOf(user.privateAddress);
    const publicBalBefore = await getPublicBalance();

    // teleportToPublicChain to address(0) — should trigger revert flow
    const revertTx = await token.teleportToPublicChain(ZERO_ADDRESS, TRANSFER_AMOUNT, PC_CHAIN_ID, TX_OPTS);
    const receipt = await revertTx.wait();
    expect(receipt?.status).to.equal(1);
    LOGGER.info('Revert transaction sent');

    // Private balance should be restored after relayer processes revert
    await eventually<boolean>({
      check: async () => {
        const bal = await token.balanceOf(user.privateAddress);
        LOGGER.info(`Revert balance check — current: ${bal}, expected: ${initialBalance}`);
        return bal === initialBalance;
      },
      interval: 4000,
      attempts: 45,
      message: `Waiting for private balance → ${initialBalance} after teleportToPublicChain(0x0) revert`,
    });

    // After relayer processed the revert, verify public chain never received tokens.
    // Checked AFTER the private balance polling to give the relayer enough time to have
    // minted if it was going to (avoids trivially-true immediate check).
    const publicBalAfter = await getPublicBalance();
    expect(publicBalAfter).to.equal(publicBalBefore);

    LOGGER.info('Revert logic (private -> public) verified');
  }).timeout(DEFAULT_TIMEOUT * 3);

  it('Should revert teleportToPrivacyNode to address(0) and preserve public tokens @smoke', async function () {
    this.timeout(DEFAULT_TIMEOUT * 3);

    const token = getPrivateToken();
    const publicBalBefore = await getPublicBalance();

    // Ensure sufficient public balance or top-up from private
    if (publicBalBefore < TRANSFER_AMOUNT) {
      await sendTokenToPublicChain(TRANSFER_AMOUNT);
      await eventually<boolean>({
        check: async () => {
          const bal = await getPublicBalance();
          return bal >= TRANSFER_AMOUNT;
        },
        interval: 2000,
        attempts: 30,
        message: `Waiting for public balance ≥ ${TRANSFER_AMOUNT} (setup top-up)`,
      });
    }

    const publicBalBeforeBurn = await getPublicBalance();
    const privateBalBefore = await token.balanceOf(user.privateAddress);
    const privateLockedBefore = await token.getLockedAmount(user.privateAddress);

    // teleportToPrivacyNode to address(0) — may revert on-chain or be caught by relayer.
    // Either way, tokens must be preserved on both chains.
    const publicToken = RaylsPublicERC20Handler__factory.connect(publicTokenAddress, userPublicSigner);
    let txReverted = false;
    try {
      const lockTx = await publicToken.teleportToPrivacyNode(ZERO_ADDRESS, TRANSFER_AMOUNT, privacyNodes.A.chainId, TX_OPTS);
      await lockTx.wait();
      LOGGER.info('teleportToPrivacyNode to address(0) did not revert on-chain — relayer handles revert');
    } catch {
      txReverted = true;
      LOGGER.info('teleportToPrivacyNode to address(0) reverted on-chain');
    }

    // Public chain tokens should be preserved (polling briefly to let state settle)
    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance();
        return bal >= publicBalBeforeBurn;
      },
      interval: 3000,
      attempts: 15,
      message: `Waiting for public balance preserved ≥ ${publicBalBeforeBurn} after teleportToPrivacyNode(0x0)`,
    });

    // If tx didn't revert on-chain, wait for relayer to process and verify private state unchanged
    if (!txReverted) {
      // Give relayer time to process and potentially revert
      await eventually<boolean>({
        check: async () => {
          const [bal, locked] = await Promise.all([
            token.balanceOf(user.privateAddress),
            token.getLockedAmount(user.privateAddress),
          ]);
          return bal === privateBalBefore && locked === privateLockedBefore;
        },
        interval: 4000,
        attempts: 45,
        message: `Waiting for private state unchanged (balance=${privateBalBefore}, locked=${privateLockedBefore})`,
      });
    } else {
      // Tx reverted — private state should be unchanged immediately
      const [bal, locked] = await Promise.all([
        token.balanceOf(user.privateAddress),
        token.getLockedAmount(user.privateAddress),
      ]);
      expect(bal).to.equal(privateBalBefore);
      expect(locked).to.equal(privateLockedBefore);
    }

    LOGGER.info('Revert logic (public -> private) verified');
  }).timeout(DEFAULT_TIMEOUT * 3);

  it('Should revert teleportToPublicChain when amount exceeds balance @smoke', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    // teleportToPublicChain LOCKS tokens (no burn), so an over-balance send reverts inside
    // _lockInternal with the handler's own RaylsErc20Handler__InsufficientBalanceToLock.
    // balanceOf excludes locked tokens, so balance + 1n always exceeds the lockable amount.
    const token = getPrivateToken();
    const balance = await token.balanceOf(user.privateAddress);
    expect(balance).to.be.gt(0n);

    LOGGER.info(`Balance: ${balance}`);

    await expect(
      token.teleportToPublicChain.staticCall(user.publicAddress, balance + 1n, PC_CHAIN_ID, TX_OPTS),
    ).to.be.revertedWithCustomError(token, 'RaylsErc20Handler__InsufficientBalanceToLock');

    LOGGER.info('teleportToPublicChain correctly reverted with RaylsErc20Handler__InsufficientBalanceToLock');
  }).timeout(DEFAULT_TIMEOUT);

  it('Should succeed sendTokenToPublicChain with available balance after tokens are locked @smoke', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const token = getPrivateToken();
    const publicBalBefore = await getPublicBalance();

    // Lock some tokens first
    const lockAmount = TRANSFER_AMOUNT / 3n;
    await sendTokenToPublicChain(lockAmount);

    const balance = await token.balanceOf(user.privateAddress);
    const locked = await token.getLockedAmount(user.privateAddress);
    const available = balance - locked;

    LOGGER.info(`Balance: ${balance}, Locked: ${locked}, Available: ${available}`);
    expect(available).to.be.gt(0n);

    const tx = await token.teleportToPublicChain(user.publicAddress, 1n, PC_CHAIN_ID, TX_OPTS);
    const receipt = await tx.wait();
    expect(receipt?.status).to.equal(1);

    // Wait for both sends (lockAmount + 1) to settle on the public chain so no in-flight
    // tokens leak into a later test's drain baseline.
    const expectedPublic = publicBalBefore + lockAmount + 1n;
    await eventually<boolean>({
      check: async () => (await getPublicBalance()) >= expectedPublic,
      interval: 2000,
      attempts: 30,
      message: `Waiting for public balance → ${expectedPublic} (settle sends)`,
    });

    LOGGER.info('teleportToPublicChain succeeded');
  }).timeout(DEFAULT_TIMEOUT);

  it('Should succeed sendTokenToPublicChain after unlocking tokens from public chain @smoke', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const token = getPrivateToken();
    const lockedBefore = await token.getLockedAmount(user.privateAddress);
    const publicBalBefore = await getPublicBalance();

    // Lock tokens via teleportToPublicChain
    const lockAmount = TRANSFER_AMOUNT / 3n;
    await sendTokenToPublicChain(lockAmount);

    const lockedAfterTeleport = await token.getLockedAmount(user.privateAddress);
    expect(lockedAfterTeleport).to.be.gt(lockedBefore);
    LOGGER.info(`Locked before: ${lockedBefore}, after teleport: ${lockedAfterTeleport}`);

    // Wait for tokens to arrive on public chain
    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance();
        return bal >= publicBalBefore + lockAmount;
      },
      interval: 2000,
      attempts: 30,
      message: `Waiting for public balance → ${publicBalBefore + lockAmount}`,
    });

    // Burn only what THIS test locked on public -> relayer unlocks on private
    await burnTokensOnPublicChain(user.privateAddress, lockAmount);

    // Wait for the lock to return to lockedBefore exactly — the test sent lockAmount and burned
    // lockAmount back, so the cycle must net to zero on the private lock.
    await eventually<boolean>({
      check: async () => {
        const locked = await token.getLockedAmount(user.privateAddress);
        LOGGER.info(`Unlock check — locked: ${locked}, target: === ${lockedBefore}`);
        return locked === lockedBefore;
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for private locked → ${lockedBefore} after burn ${lockAmount}`,
    });

    const balance = await token.balanceOf(user.privateAddress);
    const locked = await token.getLockedAmount(user.privateAddress);
    const available = balance - locked;

    LOGGER.info(`After unlock — Balance: ${balance}, Locked: ${locked}, Available: ${available}`);
    expect(available).to.be.gt(0n);

    const tx = await token.teleportToPublicChain(user.publicAddress, 1n, PC_CHAIN_ID, TX_OPTS);
    const receipt = await tx.wait();
    expect(receipt?.status).to.equal(1);

    // The lockAmount round-tripped (sent + burned back), so the only net public delta is the
    // final 1n. Wait for it to land so it doesn't leak into a later test's drain baseline.
    const expectedPublic = publicBalBefore + 1n;
    await eventually<boolean>({
      check: async () => (await getPublicBalance()) >= expectedPublic,
      interval: 2000,
      attempts: 30,
      message: `Waiting for public balance → ${expectedPublic} (settle final send)`,
    });

    LOGGER.info('teleportToPublicChain succeeded after unlocking tokens from public chain');
  }).timeout(DEFAULT_TIMEOUT);

  it('Should leave zero public balance after full reverse transfer', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const token = getPrivateToken();
    const lockedBefore = await token.getLockedAmount(user.privateAddress);

    // Drain any leftover public balance from previous tests before starting
    const preExisting = await getPublicBalance();
    if (preExisting > 0n) {
      LOGGER.info(`Draining ${preExisting} leftover public tokens before test`);
      await burnTokensOnPublicChain(user.privateAddress, preExisting);
      const cleared = await eventually<boolean>({
        check: async () => {
          const bal = await getPublicBalance();
          return bal === 0n;
        },
        interval: 3000,
        attempts: 30,
        message: `Draining public balance ${preExisting} → 0 (pre-test)`,
      });
      expect(cleared, 'Failed to drain leftover public balance before test').to.be.true;
    }

    // Send exact amount to public
    await sendTokenToPublicChain(TRANSFER_AMOUNT);

    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance();
        return bal >= TRANSFER_AMOUNT;
      },
      interval: 2000,
      attempts: 30,
      message: `Waiting for public balance → ${TRANSFER_AMOUNT} (full-reverse)`,
    });

    const publicBalAfterSend = await getPublicBalance();

    // Burn ALL tokens back to private
    await burnTokensOnPublicChain(user.privateAddress, publicBalAfterSend);

    // Public balance should drop to 0
    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance();
        LOGGER.info(`Drain check — public balance: ${bal}`);
        return bal === 0n;
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for public balance → 0 after burn ${publicBalAfterSend} (full-reverse)`,
    });

    // After a full drain (preExisting) + send + burn-all cycle, the cross-chain
    // invariant requires locked == public_balance == 0. Wait for the actual
    // settled state (not just `locked <= lockedBefore`, which can succeed while
    // unlock events are still in flight and leave the next test with a
    // non-zero baseline).
    await eventually<boolean>({check: async () => {
      const locked = await token.getLockedAmount(user.privateAddress);
      return locked === 0n;
    },interval: 3000,
      attempts: 30,
      message: `Waiting for private lock → ${0} (full-reverse)`,
  });

    LOGGER.info('Full reverse transfer: public balance is 0, private lock fully released');
  }).timeout(DEFAULT_TIMEOUT);

  it('Should prevent double spend — revert second burn after full reverse', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    let token = getPrivateToken();
    const lockedBefore = await token.getLockedAmount(user.privateAddress);

    // Drain any leftover public balance from previous tests
    const preExisting = await getPublicBalance();
    if (preExisting > 0n) {
      LOGGER.info(`Draining ${preExisting} leftover public tokens before double-spend test`);
      await burnTokensOnPublicChain(user.privateAddress, preExisting);
      const cleared = await eventually<boolean>({
        check: async () => {
          const bal = await getPublicBalance();
          return bal === 0n;
        },
        interval: 3000,
        attempts: 30,
        message: `Draining leftover public balance ${preExisting} to 0 before double-spend test`,
      });
      expect(cleared, 'Failed to drain leftover public balance').to.be.true;
    }

    // Send to public
    await sendTokenToPublicChain(TRANSFER_AMOUNT);

    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance();
        return bal >= TRANSFER_AMOUNT;
      },
      interval: 2000,
      attempts: 30,
      message: `Waiting for public balance → ${TRANSFER_AMOUNT} (double-spend)`,
    });

    const publicBalAfterSend = await getPublicBalance();

    // Burn ALL back
    await burnTokensOnPublicChain(user.privateAddress, publicBalAfterSend);

    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance();
        return bal === 0n;
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for public balance → 0 after burn ${publicBalAfterSend} (double-spend)`,
    });

    // Same invariant as the full-reverse test: wait for the private lock to actually unwind
    // before declaring the round-trip complete. Public balance reaching 0 doesn't guarantee
    // the lock-release has propagated, and leaving orphan-locked tokens here poisons the
    // partial-reverse test below (its send fails to increment locked from a polluted baseline).
    const expectedFinalLocked = lockedBefore - preExisting;
    await eventually<boolean>({
      check: async () => (await token.getLockedAmount(user.privateAddress)) === expectedFinalLocked,
      interval: 3000,
      attempts: 30,
      message: `Waiting for private lock → ${expectedFinalLocked} (double-spend, lockedBefore=${lockedBefore})`,
    });

    // Wait for the private-side unlock to land too, so the next test starts
    // from a known baseline (otherwise a still-in-flight unlock can land
    // mid-test and break lock-counter assertions).
    token = getPrivateToken();
    await eventually<boolean>({ check : async () => (
      await token.getLockedAmount(user.privateAddress)) === 0n
    , interval: 3000,attempts: 30,
    message:`Wait for the private-side unlock to land too, so the next test starts`});

    // Second burn should revert — no tokens left on public chain
    const publicToken = RaylsPublicERC20Handler__factory.connect(publicTokenAddress, userPublicSigner);
    await expect(
      publicToken.teleportToPrivacyNode.staticCall(user.privateAddress, 1n, privacyNodes.A.chainId, TX_OPTS),
    ).to.be.reverted;

    LOGGER.info('Double spend prevented: second burn correctly reverted');
  }).timeout(DEFAULT_TIMEOUT);

  it('Should correctly track balances after partial reverse transfer', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const token = getPrivateToken();
    const lockedBefore = await token.getLockedAmount(user.privateAddress);
    const publicBalBefore = await getPublicBalance();

    // Send full amount to public
    await sendTokenToPublicChain(TRANSFER_AMOUNT);

    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance();
        return bal >= publicBalBefore + TRANSFER_AMOUNT;
      },
      interval: 2000,
      attempts: 30,
      message: `Waiting for public balance → ${publicBalBefore + TRANSFER_AMOUNT} (partial-reverse)`,
    });

    // Verify the send leg fully propagated — `locked` must climb to lockedBefore + TRANSFER_AMOUNT
    // before we check the partial unwind. Without this an incomplete send would masquerade as
    // a partial-unlock bug (e.g. orphan-lock pollution from a prior test).
    await eventually<boolean>({
      check: async () => (await token.getLockedAmount(user.privateAddress)) >= lockedBefore + TRANSFER_AMOUNT,
      interval: 2000,
      attempts: 30,
      message: `Waiting for locked peak → ${lockedBefore + TRANSFER_AMOUNT} (lockedBefore=${lockedBefore})`,
    });

    const halfAmount = TRANSFER_AMOUNT / 2n;

    // Burn only half back
    await burnTokensOnPublicChain(user.privateAddress, halfAmount);

    // Public chain should still hold the other half
    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance();
        LOGGER.info(`Partial reverse check — public balance: ${bal}`);
        return bal >= publicBalBefore + halfAmount && bal < publicBalBefore + TRANSFER_AMOUNT;
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for public balance in (${publicBalBefore + halfAmount}, ${publicBalBefore + TRANSFER_AMOUNT}) after partial burn ${halfAmount}`,
    });

    // Locked amount should have partially decreased
    await eventually<boolean>({
      check: async () => {
        const locked = await token.getLockedAmount(user.privateAddress);
        LOGGER.info(`Partial reverse lock check — locked: ${locked}`);
        return locked > lockedBefore && locked < lockedBefore + TRANSFER_AMOUNT;
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for private locked in (${lockedBefore}, ${lockedBefore + TRANSFER_AMOUNT}) after partial burn`,
    });

    LOGGER.info('Partial reverse transfer: balances correctly tracked on both chains');
  }).timeout(DEFAULT_TIMEOUT);

  it('Should revert teleportToPrivacyNode when amount exceeds public balance', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const publicBal = await getPublicBalance();

    // Ensure we have some public balance to test with
    if (publicBal < TRANSFER_AMOUNT) {
      await sendTokenToPublicChain(TRANSFER_AMOUNT);
      await eventually<boolean>({
        check: async () => {
          const bal = await getPublicBalance();
          return bal >= TRANSFER_AMOUNT;
        },
        interval: 2000,
        attempts: 30,
        message: `Waiting for public balance ≥ ${TRANSFER_AMOUNT} (setup top-up)`,
      });
    }

    const currentPublicBal = await getPublicBalance();
    const excessAmount = currentPublicBal + 1n;

    const publicToken = RaylsPublicERC20Handler__factory.connect(publicTokenAddress, userPublicSigner);
    await expect(
      publicToken.teleportToPrivacyNode.staticCall(user.privateAddress, excessAmount, privacyNodes.A.chainId, TX_OPTS),
    ).to.be.reverted;

    LOGGER.info('teleportToPrivacyNode correctly reverted when amount exceeds public balance');
  }).timeout(DEFAULT_TIMEOUT);

  it('Should revert teleportToPrivacyNode to non-approved address', async function () {
    this.timeout(DEFAULT_TIMEOUT * 2);

    const publicBal = await getPublicBalance();

    if (publicBal < TRANSFER_AMOUNT) {
      await sendTokenToPublicChain(TRANSFER_AMOUNT);
      await eventually<boolean>({
        check: async () => {
          const bal = await getPublicBalance();
          return bal >= TRANSFER_AMOUNT;
        },
        interval: 2000,
        attempts: 30,
        message: `Waiting for public balance ≥ ${TRANSFER_AMOUNT} (setup top-up)`,
      });
    }

    const publicBalBefore = await getPublicBalance();
    const token = getPrivateToken();
    const privateBalBefore = await token.balanceOf(user.privateAddress);

    // Random address not registered in governance
    const nonApprovedAddress = ethers.Wallet.createRandom().address;
    const publicToken = RaylsPublicERC20Handler__factory.connect(publicTokenAddress, userPublicSigner);

    let txReverted = false;
    try {
      const lockTx = await publicToken.teleportToPrivacyNode(nonApprovedAddress, TRANSFER_AMOUNT, privacyNodes.A.chainId, TX_OPTS);
      await lockTx.wait();
      LOGGER.info('teleportToPrivacyNode to non-approved address did not revert on-chain — relayer handles revert');
    } catch {
      txReverted = true;
      LOGGER.info('teleportToPrivacyNode to non-approved address reverted on-chain');
    }

    if (txReverted) {
      // On-chain revert: public balance should be unchanged
      const publicBal = await getPublicBalance();
      expect(publicBal).to.equal(publicBalBefore, 'Public balance should be preserved after on-chain revert');
    } else {
      // Tx succeeded on-chain — tokens are burned from public chain.
      // Relayer rejects the cross-chain delivery to non-approved address but does NOT refund.
      const publicBalAfter = await getPublicBalance();
      expect(publicBalAfter).to.be.lt(publicBalBefore, 'Tokens should be burned from public chain');
      LOGGER.info(`Tokens burned — public balance before: ${publicBalBefore}, after: ${publicBalAfter}`);
    }

    LOGGER.info('Non-approved teleport: tokens burned on public chain, no refund');
  }).timeout(DEFAULT_TIMEOUT * 2);

  it('Should handle batch transfer of 200 transactions to public chain', async function () {
    this.retries(0);
    this.timeout(DEFAULT_TIMEOUT * 2);

    const token = getPrivateToken();
    const requiredBalance = BigInt(BATCH_SIZE) * BATCH_TRANSFER_AMOUNT;
    const balance = await token.balanceOf(user.privateAddress);
    expect(balance).to.be.gte(requiredBalance);

    const publicBalBefore = await getPublicBalance();

    LOGGER.info(`Sending batch of ${BATCH_SIZE} transactions...`);
    const batchStartTime = Date.now();

    const txPromises: Promise<ethers.ContractTransactionResponse>[] = [];
    let currentNonce = await userPrivateSigner.provider!.getTransactionCount(userPrivateSigner.address, 'pending');

    for (let i = 0; i < BATCH_SIZE; i++) {
      txPromises.push(
        token.teleportToPublicChain(user.publicAddress, BATCH_TRANSFER_AMOUNT, PC_CHAIN_ID, {
          gasLimit: GAS_LIMIT,
          nonce: currentNonce + i,
        }),
      );

      if (i < BATCH_SIZE - 1) await new Promise(resolve => setTimeout(resolve, 25));
    }

    LOGGER.info(`All ${BATCH_SIZE} transactions sent in ${Date.now() - batchStartTime}ms`);

    const results = await Promise.allSettled(txPromises.map(p => p.then(tx => tx.wait())));
    const successfulTxs = results.filter(r => r.status === 'fulfilled' && r.value?.status === 1).length;
    expect(successfulTxs).to.equal(BATCH_SIZE);

    // Verify batch arrived on public chain
    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance();
        return bal >= publicBalBefore + BigInt(successfulTxs) * BATCH_TRANSFER_AMOUNT;
      },
      // 200 cross-chain deliveries are serialized across the public relayer's signer pool and
      // mined sequentially on the non-gasless public chain — far slower than a single-message
      // wait. Budget 5 min (well under this test's DEFAULT_TIMEOUT*2 mocha cap) instead of 90s.
      interval: 5000,
      attempts: 60,
      tolerateErrors: true,
      message: `Waiting for batch balance → ${publicBalBefore + BigInt(successfulTxs) * BATCH_TRANSFER_AMOUNT} (${successfulTxs} txs × ${BATCH_TRANSFER_AMOUNT})`,
    });

    const totalTime = Date.now() - batchStartTime;
    LOGGER.info(`Batch: ${successfulTxs}/${BATCH_SIZE} txs in ${(totalTime / 1000).toFixed(2)}s (${(successfulTxs / (totalTime / 1000)).toFixed(2)} tx/s)`);
  }).timeout(DEFAULT_TIMEOUT * 2);

  // -------------------------------------------------------------------------
  // PublicChain-layer freeze (freezeOnPublicChain) — flips publicChainStatus to FROZEN locally on PN A
  // (no relayer sync). A frozen token's teleportToPublicChain reverts RaylsApp__PublicChainNotActive
  // (whenPublicChainActive requires publicChainStatus == DEPLOYED). Freeze is not idempotent — the nested
  // afterEach unfreezes only if still frozen.
  // -------------------------------------------------------------------------
  describe('public-chain layer freeze', function () {
    afterEach(async function () {
      this.timeout(DEFAULT_TIMEOUT);
      await cleanupPublicFrozenTokens(tokenRegistryOnA, [tokenAddress]);
    });

    it('Should public-freeze ERC20 on A, then reject teleportToPublicChain @smoke', async function () {
      this.timeout(DEFAULT_TIMEOUT);
      const token = getPrivateToken();
      const lockedBefore = await token.getLockedAmount(user.privateAddress);

      await freezeOnPublicChain(tokenRegistryOnA, tokenAddress);

      // publicChainStatus == FROZEN → whenPublicChainActive reverts on the sending contract.
      await expect(
        token.teleportToPublicChain(user.publicAddress, TRANSFER_AMOUNT, PC_CHAIN_ID),
      ).to.be.revertedWithCustomError(token, 'RaylsApp__PublicChainNotActive');

      // No tokens locked — the revert fired before the lock.
      expect(await token.getLockedAmount(user.privateAddress)).to.equal(lockedBefore);
    }).timeout(DEFAULT_TIMEOUT);

    it('Should public-unfreeze ERC20 on A, then allow teleportToPublicChain', async function () {
      this.timeout(DEFAULT_TIMEOUT);
      const publicBalBefore = await getPublicBalance();

      await freezeOnPublicChain(tokenRegistryOnA, tokenAddress);
      await unfreezeOnPublicChain(tokenRegistryOnA, tokenAddress);

      await sendTokenToPublicChain(TRANSFER_AMOUNT);

      await eventually<boolean>({
        check: async () => (await getPublicBalance()) >= publicBalBefore + TRANSFER_AMOUNT,
        interval: 2000,
        attempts: 30,
        message: `Waiting for public balance → ${publicBalBefore + TRANSFER_AMOUNT} after public-unfreeze`,
      });
    }).timeout(DEFAULT_TIMEOUT);
  });

  // --- Helpers ---

  async function getPublicBalance(): Promise<bigint> {
    const publicToken = PublicChainERC20__factory.connect(publicTokenAddress, publicProvider);
    return publicToken.balanceOf(user.publicAddress);
  }

  function getPrivateToken(): ProductionErc20Token {
    // Bind directly to the frozen token address so the teleport target is provably the same
    // instance the freeze wrote to (a symbol-based store lookup could resolve a different one).
    return ProductionErc20Token__factory.connect(tokenAddress, userPrivateSigner);
  }

  async function sendTokenToPublicChain(amount: bigint) {
    const token = getPrivateToken();
    await sendTx(
      () => token.teleportToPublicChain(user.publicAddress, amount, PC_CHAIN_ID, TX_OPTS),
      'teleportToPublicChain',
    );
  }

  async function fundPublicChainAddress(address: string, amount: string) {
    const tx = await systemPublicSigner.sendTransaction({
      to: address,
      value: ethers.parseEther(amount),
    });
    await tx.wait();
  }

  async function burnTokensOnPublicChain(recipientAddr: string, amount: bigint) {
    const publicToken = RaylsPublicERC20Handler__factory.connect(publicTokenAddress, userPublicSigner);
    const lockTx = await publicToken.teleportToPrivacyNode(recipientAddr, amount, privacyNodes.A.chainId, TX_OPTS);
    await lockTx.wait();
  }
});
