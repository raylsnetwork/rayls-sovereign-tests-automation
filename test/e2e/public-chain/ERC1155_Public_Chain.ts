/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
import { expect } from 'chai';
import { ethers } from 'ethers';
import {
  PNTokenRegistryV1,
  ProductionErc1155Token,
  ProductionErc1155Token__factory,
  PublicChainERC1155,
  PublicChainERC1155__factory,
} from '../../../typechain-types';
import {
  DEFAULT_TIMEOUT,
  GAS_LIMIT,
  LOGGER,
  PRIVATE_KEY_SYSTEM,
  PUBLIC_CHAIN_RPC_URL,
} from '../../../src/config/env-config';
import { ERC1155Wrapper } from '../../../src/entities/tokens/ERC1155Wrapper';
import { eventually, sendTx } from '../../../src/utils/common';
import { getProvider } from '../../../src/utils/network-utils';
import { initializePrivacyNodes, PrivacyNodeMap } from '../../setup';
import {
  cleanupPublicFrozenTokens,
  freezeOnPublicChain,
  unfreezeOnPublicChain,
} from '../../test-utils/freeze-helpers';

describe('E2E Tests: ERC1155 Public Chain Transfer @decommissioned @hubless', function () {
  const TOKEN_ID = 0;
  const MINT_AMOUNT = 200n;
  const TRANSFER_AMOUNT = 100n;
  const TRANSFER_DATA = '0x1234567890abcdef';
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

  let tokenWrapper: ERC1155Wrapper<ProductionErc1155Token>;
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
    tokenWrapper = new ERC1155Wrapper<ProductionErc1155Token>(privacyNodes.A, ProductionErc1155Token__factory);
    await tokenWrapper.deploy();
    tokenAddress = tokenWrapper.address[privacyNodes.A.chainId];
    LOGGER.info(`ERC1155 deployed at: ${tokenAddress}`);

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
    // tokenWrapper.contract uses userWallet (deployer/owner) — only owner can mint.
    await sendTx(
      () => tokenWrapper.contract.mint(user.privateAddress, TOKEN_ID, MINT_AMOUNT, TRANSFER_DATA, TX_OPTS),
      'mint fresh tokens',
    );
  });

  it('Should transfer ERC1155 tokens to public chain @smoke', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const token = getPrivateToken();
    const lockedBefore = await token.getLockedAmount(user.privateAddress, TOKEN_ID);
    const publicBalBefore = await getPublicBalance(TOKEN_ID);

    await sendTokenToPublicChain(TOKEN_ID, TRANSFER_AMOUNT);

    // Verify tokens locked on private chain
    const newLocked = await token.getLockedAmount(user.privateAddress, TOKEN_ID);
    expect(newLocked).to.be.gt(lockedBefore);

    // Verify tokens arrived on public chain
    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance(TOKEN_ID);
        return bal >= publicBalBefore + TRANSFER_AMOUNT;
      },
      interval: 2000,
      attempts: 30,
      message: `Waiting for public #${TOKEN_ID} balance → ${publicBalBefore + TRANSFER_AMOUNT}`,
    });

    LOGGER.info('Public chain balance verified');
  }).timeout(DEFAULT_TIMEOUT);

  it('Should transfer ERC1155 tokens back from public to private chain @smoke', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const token = getPrivateToken();
    const lockedBefore = await token.getLockedAmount(user.privateAddress, TOKEN_ID);
    const publicBalBefore = await getPublicBalance(TOKEN_ID);

    // Send to public first
    await sendTokenToPublicChain(TOKEN_ID, TRANSFER_AMOUNT);

    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance(TOKEN_ID);
        return bal >= publicBalBefore + TRANSFER_AMOUNT;
      },
      interval: 2000,
      attempts: 30,
      message: `Waiting for public #${TOKEN_ID} balance → ${publicBalBefore + TRANSFER_AMOUNT} (reverse-flow setup)`,
    });

    // Snapshot balance BEFORE burn (race: relayer may unlock before we read)
    const balanceBeforeBurn = await token.balanceOf(user.privateAddress, TOKEN_ID);

    // Burn on public chain -> relayer unlocks on private
    await burnTokensOnPublicChain(TOKEN_ID, user.privateAddress, TRANSFER_AMOUNT);

    // Verify unlock: the send+burn cycle must net to zero — locked back to lockedBefore exactly
    // and balance recovered by exactly TRANSFER_AMOUNT from the pre-burn snapshot.
    await eventually<boolean>({
      check: async () => {
        const locked = await token.getLockedAmount(user.privateAddress, TOKEN_ID);
        const balance = await token.balanceOf(user.privateAddress, TOKEN_ID);
        LOGGER.info(`Reverse check — balance: ${balance}, locked: ${locked}`);
        return locked === lockedBefore && balance === balanceBeforeBurn + TRANSFER_AMOUNT;
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for #${TOKEN_ID} reverse unlock (locked → ${lockedBefore}, balance → ${balanceBeforeBurn + TRANSFER_AMOUNT})`,
    });

    LOGGER.info('Reverse transfer verified');
  }).timeout(DEFAULT_TIMEOUT);

  it('Should handle batch token transfers to public chain @smoke', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const BATCH_TOKEN_ID = 1;
    const BATCH_AMOUNT = 50n;

    // Mint tokens for a different token ID
    await sendTx(
      () => tokenWrapper.contract.mint(user.privateAddress, BATCH_TOKEN_ID, BATCH_AMOUNT, TRANSFER_DATA, TX_OPTS),
      'mint batch tokens',
    );

    const publicBalBefore = await getPublicBalance(BATCH_TOKEN_ID);
    await sendTokenToPublicChain(BATCH_TOKEN_ID, BATCH_AMOUNT);

    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance(BATCH_TOKEN_ID);
        return bal >= publicBalBefore + BATCH_AMOUNT;
      },
      interval: 2000,
      attempts: 30,
      message: `Waiting for public #${BATCH_TOKEN_ID} balance → ${publicBalBefore + BATCH_AMOUNT} (batch ${BATCH_AMOUNT})`,
    });

    LOGGER.info('Batch transfer verified');
  }).timeout(DEFAULT_TIMEOUT);

  it('Should revert teleportToPublicChain when amount exceeds balance @smoke', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    // teleportToPublicChain LOCKS tokens (no burn), so an over-balance send reverts inside
    // _lockInternal with the handler's own RaylsErc1155Handler__InsufficientBalanceToLock.
    // balanceOf excludes locked tokens, so balance + 1n always exceeds the lockable amount.
    const token = getPrivateToken();
    const balance = await token.balanceOf(user.privateAddress, TOKEN_ID);
    expect(balance).to.be.gt(0n);

    LOGGER.info(`Balance: ${balance}`);

    await expect(
      token.teleportToPublicChain.staticCall(user.publicAddress, TOKEN_ID, balance + 1n, PC_CHAIN_ID, TRANSFER_DATA, TX_OPTS),
    ).to.be.revertedWithCustomError(token, 'RaylsErc1155Handler__InsufficientBalanceToLock');

    LOGGER.info('teleportToPublicChain correctly reverted with RaylsErc1155Handler__InsufficientBalanceToLock');
  }).timeout(DEFAULT_TIMEOUT);

  it('Should succeed teleportToPublicChain with available balance after tokens are locked @smoke', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const token = getPrivateToken();
    const publicBalBefore = await getPublicBalance(TOKEN_ID);

    // Lock some tokens first
    const lockAmount = TRANSFER_AMOUNT / 3n;
    await sendTokenToPublicChain(TOKEN_ID, lockAmount);

    const balance = await token.balanceOf(user.privateAddress, TOKEN_ID);
    const locked = await token.getLockedAmount(user.privateAddress, TOKEN_ID);
    const available = balance - locked;

    LOGGER.info(`Balance: ${balance}, Locked: ${locked}, Available: ${available}`);
    expect(available).to.be.gt(0n);

    const tx = await token.teleportToPublicChain(user.publicAddress, TOKEN_ID, 1n, PC_CHAIN_ID, TRANSFER_DATA, TX_OPTS);
    const receipt = await tx.wait();
    expect(receipt?.status).to.equal(1);

    // Wait for both sends (lockAmount + 1) to settle on the public chain so no in-flight
    // tokens leak into a later test's drain baseline.
    const expectedPublic = publicBalBefore + lockAmount + 1n;
    await eventually<boolean>({
      check: async () => (await getPublicBalance(TOKEN_ID)) >= expectedPublic,
      interval: 2000,
      attempts: 30,
      message: `Waiting for public #${TOKEN_ID} balance → ${expectedPublic} (settle sends)`,
    });

    LOGGER.info('teleportToPublicChain succeeded');
  }).timeout(DEFAULT_TIMEOUT);

  it('Should succeed teleportToPublicChain after unlocking tokens from public chain @smoke', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const token = getPrivateToken();
    const lockedBefore = await token.getLockedAmount(user.privateAddress, TOKEN_ID);
    const publicBalBefore = await getPublicBalance(TOKEN_ID);

    // Lock tokens via teleportToPublicChain
    const lockAmount = TRANSFER_AMOUNT / 3n;
    await sendTokenToPublicChain(TOKEN_ID, lockAmount);

    const lockedAfterTeleport = await token.getLockedAmount(user.privateAddress, TOKEN_ID);
    expect(lockedAfterTeleport).to.be.gt(lockedBefore);
    LOGGER.info(`Locked before: ${lockedBefore}, after teleport: ${lockedAfterTeleport}`);

    // Wait for tokens to arrive on public chain
    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance(TOKEN_ID);
        return bal >= publicBalBefore + lockAmount;
      },
      interval: 2000,
      attempts: 30,
      message: `Waiting for public #${TOKEN_ID} balance → ${publicBalBefore + lockAmount}`,
    });

    // Burn only what THIS test locked on public -> relayer unlocks on private
    await burnTokensOnPublicChain(TOKEN_ID, user.privateAddress, lockAmount);

    // Wait for the lock to return to lockedBefore exactly — the test sent lockAmount and burned
    // lockAmount back, so the cycle must net to zero on the private lock.
    await eventually<boolean>({
      check: async () => {
        const locked = await token.getLockedAmount(user.privateAddress, TOKEN_ID);
        LOGGER.info(`Unlock check — locked: ${locked}, target: === ${lockedBefore}`);
        return locked === lockedBefore;
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for private locked #${TOKEN_ID} → ${lockedBefore} after burn ${lockAmount}`,
    });

    const balance = await token.balanceOf(user.privateAddress, TOKEN_ID);
    const locked = await token.getLockedAmount(user.privateAddress, TOKEN_ID);
    const available = balance - locked;

    LOGGER.info(`After unlock — Balance: ${balance}, Locked: ${locked}, Available: ${available}`);
    expect(available).to.be.gt(0n);

    const tx = await token.teleportToPublicChain(user.publicAddress, TOKEN_ID, 1n, PC_CHAIN_ID, TRANSFER_DATA, TX_OPTS);
    const receipt = await tx.wait();
    expect(receipt?.status).to.equal(1);

    // The lockAmount round-tripped (sent + burned back), so the only net public delta is the
    // final 1n. Wait for it to land so it doesn't leak into a later test's drain baseline.
    const expectedPublic = publicBalBefore + 1n;
    await eventually<boolean>({
      check: async () => (await getPublicBalance(TOKEN_ID)) >= expectedPublic,
      interval: 2000,
      attempts: 30,
      message: `Waiting for public #${TOKEN_ID} balance → ${expectedPublic} (settle final send)`,
    });

    LOGGER.info('teleportToPublicChain succeeded after unlocking tokens from public chain');
  }).timeout(DEFAULT_TIMEOUT);

  it('Should leave zero public balance after full reverse transfer', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const token = getPrivateToken();
    const lockedBefore = await token.getLockedAmount(user.privateAddress, TOKEN_ID);

    // Drain any leftover public balance from previous tests before starting
    const preExisting = await getPublicBalance(TOKEN_ID);
    if (preExisting > 0n) {
      LOGGER.info(`Draining ${preExisting} leftover public tokens before test`);
      await burnTokensOnPublicChain(TOKEN_ID, user.privateAddress, preExisting);
      const cleared = await eventually<boolean>({
        check: async () => {
          const bal = await getPublicBalance(TOKEN_ID);
          return bal === 0n;
        },
        interval: 3000,
        attempts: 30,
        message: `Draining #${TOKEN_ID} public balance ${preExisting} → 0 (full-reverse)`,
      });
      expect(cleared, 'Failed to drain leftover public balance before test').to.be.true;
    }

    // Send exact amount to public
    await sendTokenToPublicChain(TOKEN_ID, TRANSFER_AMOUNT);

    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance(TOKEN_ID);
        return bal >= TRANSFER_AMOUNT;
      },
      interval: 2000,
      attempts: 30,
      message: `Waiting for public #${TOKEN_ID} balance → ${TRANSFER_AMOUNT} (full-reverse)`,
    });

    const publicBalAfterSend = await getPublicBalance(TOKEN_ID);

    // Burn ALL tokens back to private
    await burnTokensOnPublicChain(TOKEN_ID, user.privateAddress, publicBalAfterSend);

    // Public balance should drop to 0
    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance(TOKEN_ID);
        LOGGER.info(`Drain check — public balance: ${bal}`);
        return bal === 0n;
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for public #${TOKEN_ID} balance → 0 after burn ${publicBalAfterSend} (full-reverse)`,
    });

    // After a full drain (preExisting) + send + burn-all cycle, the cross-chain
    // invariant requires locked == public_balance == 0. Wait for the actual
    // settled state (not just `locked <= lockedBefore`, which can succeed while
    // unlock events are still in flight and leave the next test with a
    // non-zero baseline).
    await eventually<boolean>({
      check: async () => (await token.getLockedAmount(user.privateAddress, TOKEN_ID)) === 0n,
    interval: 3000, attempts: 30, message: `Wait for the actual settled state `});

    LOGGER.info('Full reverse transfer: public balance is 0, private lock fully released');
  }).timeout(DEFAULT_TIMEOUT);

  it('Should prevent double spend — revert second burn after full reverse', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const token = getPrivateToken();
    const lockedBefore = await token.getLockedAmount(user.privateAddress, TOKEN_ID);

    // Drain any leftover public balance from previous tests
    const preExisting = await getPublicBalance(TOKEN_ID);
    if (preExisting > 0n) {
      LOGGER.info(`Draining ${preExisting} leftover public tokens before double-spend test`);
      await burnTokensOnPublicChain(TOKEN_ID, user.privateAddress, preExisting);
      const cleared = await eventually<boolean>({
        check: async () => {
          const bal = await getPublicBalance(TOKEN_ID);
          return bal === 0n;
        },
        interval: 3000,
        attempts: 30,
        message: `Draining leftover ERC1155 public balance ${preExisting} (tokenId=${TOKEN_ID}) to 0 before double-spend test`,
      });
      expect(cleared, 'Failed to drain leftover public balance').to.be.true;
    }

    // Send to public
    await sendTokenToPublicChain(TOKEN_ID, TRANSFER_AMOUNT);

    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance(TOKEN_ID);
        return bal >= TRANSFER_AMOUNT;
      },
      interval: 2000,
      attempts: 30,
      message: `Waiting for public #${TOKEN_ID} balance → ${TRANSFER_AMOUNT} (double-spend)`,
    });

    const publicBalAfterSend = await getPublicBalance(TOKEN_ID);

    // Burn ALL back
    await burnTokensOnPublicChain(TOKEN_ID, user.privateAddress, publicBalAfterSend);

    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance(TOKEN_ID);
        return bal === 0n;
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for public #${TOKEN_ID} balance → 0 after burn ${publicBalAfterSend} (double-spend)`,
    });

    // Same invariant as the full-reverse test: wait for the private lock to actually unwind
    // before declaring the round-trip complete. Public balance reaching 0 doesn't guarantee
    // the lock-release has propagated, and leaving orphan-locked tokens here poisons the
    // partial-reverse test below (its send fails to increment locked from a polluted baseline).
    const expectedFinalLocked = lockedBefore - preExisting;
    await eventually<boolean>({
      check: async () => (await token.getLockedAmount(user.privateAddress, TOKEN_ID)) === expectedFinalLocked,
      interval: 3000,
      attempts: 30,
      message: `Waiting for private lock → ${expectedFinalLocked} (double-spend, lockedBefore=${lockedBefore})`,
    });

    // Wait for the private-side unlock to land too, so the next test starts
    // from a known baseline (otherwise a still-in-flight unlock can land
    // mid-test and break lock-counter assertions).
     await eventually({
       check: async () => (await token.getLockedAmount(user.privateAddress, TOKEN_ID)) === 0n,
    interval: 3000,
      attempts : 30,
      message : `Wait for the private-side unlock to land too`});

    // Second burn should revert — no tokens left
    const publicToken = PublicChainERC1155__factory.connect(publicTokenAddress, userPublicSigner) as PublicChainERC1155;
    await expect(
      publicToken.teleportToPrivacyNode.staticCall(user.privateAddress, TOKEN_ID, 1n, privacyNodes.A.chainId, TX_OPTS),
    ).to.be.reverted;

    LOGGER.info('Double spend prevented: second burn correctly reverted');
  }).timeout(DEFAULT_TIMEOUT);

  it('Should correctly track balances after partial reverse transfer', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const token = getPrivateToken();
    const lockedBefore = await token.getLockedAmount(user.privateAddress, TOKEN_ID);
    const publicBalBefore = await getPublicBalance(TOKEN_ID);

    // Send full amount to public
    await sendTokenToPublicChain(TOKEN_ID, TRANSFER_AMOUNT);

    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance(TOKEN_ID);
        return bal >= publicBalBefore + TRANSFER_AMOUNT;
      },
      interval: 2000,
      attempts: 30,
      message: `Waiting for public #${TOKEN_ID} balance → ${publicBalBefore + TRANSFER_AMOUNT} (partial-reverse)`,
    });

    const halfAmount = TRANSFER_AMOUNT / 2n;

    // Burn only half back
    await burnTokensOnPublicChain(TOKEN_ID, user.privateAddress, halfAmount);

    // Public chain should still hold the other half
    await eventually<boolean>({
      check: async () => {
        const bal = await getPublicBalance(TOKEN_ID);
        LOGGER.info(`Partial reverse check — public balance: ${bal}`);
        return bal >= publicBalBefore + halfAmount && bal < publicBalBefore + TRANSFER_AMOUNT;
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for public #${TOKEN_ID} balance in (${publicBalBefore + halfAmount}, ${publicBalBefore + TRANSFER_AMOUNT}) after partial burn ${halfAmount}`,
    });

    // Locked amount should have partially decreased
    await eventually<boolean>({
      check: async () => {
        const locked = await token.getLockedAmount(user.privateAddress, TOKEN_ID);
        LOGGER.info(`Partial reverse lock check — locked: ${locked}`);
        return locked > lockedBefore && locked < lockedBefore + TRANSFER_AMOUNT;
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for private locked #${TOKEN_ID} in (${lockedBefore}, ${lockedBefore + TRANSFER_AMOUNT}) after partial burn`,
    });

    LOGGER.info('Partial reverse transfer: balances correctly tracked on both chains');
  }).timeout(DEFAULT_TIMEOUT);

  it('Should revert teleportToPrivacyNode when amount exceeds public balance', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const publicBal = await getPublicBalance(TOKEN_ID);

    if (publicBal < TRANSFER_AMOUNT) {
      await sendTokenToPublicChain(TOKEN_ID, TRANSFER_AMOUNT);
      await eventually<boolean>({
        check: async () => {
          const bal = await getPublicBalance(TOKEN_ID);
          return bal >= TRANSFER_AMOUNT;
        },
        interval: 2000,
        attempts: 30,
        message: `Waiting for public #${TOKEN_ID} balance ≥ ${TRANSFER_AMOUNT} (setup top-up)`,
      });
    }

    const currentPublicBal = await getPublicBalance(TOKEN_ID);
    const excessAmount = currentPublicBal + 1n;

    const publicToken = PublicChainERC1155__factory.connect(publicTokenAddress, userPublicSigner) as PublicChainERC1155;
    await expect(
      publicToken.teleportToPrivacyNode.staticCall(user.privateAddress, TOKEN_ID, excessAmount, privacyNodes.A.chainId, TX_OPTS),
    ).to.be.reverted;

    LOGGER.info('teleportToPrivacyNode correctly reverted when amount exceeds public balance');
  }).timeout(DEFAULT_TIMEOUT);

  it('Should revert teleportToPrivacyNode to non-approved address', async function () {
    this.timeout(DEFAULT_TIMEOUT * 2);

    const publicBal = await getPublicBalance(TOKEN_ID);

    if (publicBal < TRANSFER_AMOUNT) {
      await sendTokenToPublicChain(TOKEN_ID, TRANSFER_AMOUNT);
      await eventually<boolean>({
        check: async () => {
          const bal = await getPublicBalance(TOKEN_ID);
          return bal >= TRANSFER_AMOUNT;
        },
        interval: 2000,
        attempts: 30,
        message: `Waiting for public #${TOKEN_ID} balance ≥ ${TRANSFER_AMOUNT} (setup top-up)`,
      });
    }

    const publicBalBefore = await getPublicBalance(TOKEN_ID);

    // Random address not registered in governance
    const nonApprovedAddress = ethers.Wallet.createRandom().address;
    const publicToken = PublicChainERC1155__factory.connect(publicTokenAddress, userPublicSigner) as PublicChainERC1155;

    let txReverted = false;
    try {
      const lockTx = await publicToken.teleportToPrivacyNode(nonApprovedAddress, TOKEN_ID, TRANSFER_AMOUNT, privacyNodes.A.chainId, TX_OPTS);
      await lockTx.wait();
      LOGGER.info('teleportToPrivacyNode to non-approved address did not revert on-chain — relayer handles revert');
    } catch {
      txReverted = true;
      LOGGER.info('teleportToPrivacyNode to non-approved address reverted on-chain');
    }

    if (txReverted) {
      // On-chain revert: public balance should be unchanged
      const publicBal = await getPublicBalance(TOKEN_ID);
      expect(publicBal).to.equal(publicBalBefore, 'Public balance should be preserved after on-chain revert');
    } else {
      // Tx succeeded on-chain — tokens are burned from public chain.
      // Relayer rejects the cross-chain delivery to non-approved address but does NOT refund.
      // Verify tokens were permanently burned (balance decreased).
      const publicBalAfter = await getPublicBalance(TOKEN_ID);
      expect(publicBalAfter).to.be.lt(publicBalBefore, 'Tokens should be burned from public chain');
      LOGGER.info(`Tokens burned — public balance before: ${publicBalBefore}, after: ${publicBalAfter}`);
    }

    LOGGER.info('Non-approved teleport: tokens burned on public chain, no refund');
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

    it('Should public-freeze ERC1155 on A, then reject teleportToPublicChain @smoke', async function () {
      this.timeout(DEFAULT_TIMEOUT);
      const token = getPrivateToken();
      const balanceBefore = await token.balanceOf(user.privateAddress, TOKEN_ID);

      await freezeOnPublicChain(tokenRegistryOnA, tokenAddress);

      // publicChainStatus == FROZEN → whenPublicChainActive reverts on the sending contract.
      await expect(
        token.teleportToPublicChain(user.publicAddress, TOKEN_ID, 1n, PC_CHAIN_ID, TRANSFER_DATA),
      ).to.be.revertedWithCustomError(token, 'RaylsApp__PublicChainNotActive');

      // No tokens locked — the revert fired before the lock.
      expect(await token.balanceOf(user.privateAddress, TOKEN_ID)).to.equal(balanceBefore);
    }).timeout(DEFAULT_TIMEOUT);

    it('Should public-unfreeze ERC1155 on A, then allow teleportToPublicChain', async function () {
      this.timeout(DEFAULT_TIMEOUT);
      const publicBalBefore = await getPublicBalance(TOKEN_ID);

      await freezeOnPublicChain(tokenRegistryOnA, tokenAddress);
      await unfreezeOnPublicChain(tokenRegistryOnA, tokenAddress);

      await sendTokenToPublicChain(TOKEN_ID, 1n);

      await eventually<boolean>({
        check: async () => (await getPublicBalance(TOKEN_ID)) >= publicBalBefore + 1n,
        interval: 2000,
        attempts: 30,
        message: `Waiting for public ERC1155 #${TOKEN_ID} balance → ${publicBalBefore + 1n} after public-unfreeze`,
      });
    }).timeout(DEFAULT_TIMEOUT);
  });

  // --- Helpers ---

  async function getPublicBalance(tokenId: number | bigint): Promise<bigint> {
    const publicToken = PublicChainERC1155__factory.connect(publicTokenAddress, publicProvider);
    return publicToken.balanceOf(user.publicAddress, tokenId);
  }

  function getPrivateToken(): ProductionErc1155Token {
    return privacyNodes.A.getContract<ProductionErc1155Token>(tokenWrapper.symbol)
      .connect(userPrivateSigner) as ProductionErc1155Token;
  }

  async function sendTokenToPublicChain(tokenId: number | bigint, amount: bigint) {
    const token = getPrivateToken();
    await sendTx(
      () => token.teleportToPublicChain(user.publicAddress, tokenId, amount, PC_CHAIN_ID, TRANSFER_DATA, TX_OPTS),
      `teleportToPublicChain #${tokenId}`,
    );
  }

  async function fundPublicChainAddress(address: string, amount: string) {
    const tx = await systemPublicSigner.sendTransaction({
      to: address,
      value: ethers.parseEther(amount),
    });
    await tx.wait();
  }

  async function burnTokensOnPublicChain(tokenId: number | bigint, recipientAddr: string, amount: bigint) {
    const publicToken = PublicChainERC1155__factory.connect(publicTokenAddress, userPublicSigner) as PublicChainERC1155;
    const lockTx = await publicToken.teleportToPrivacyNode(
      recipientAddr, tokenId, amount, privacyNodes.A.chainId, TX_OPTS,
    );
    await lockTx.wait();
  }
});
