/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
/**
 * @title E2E SECURITY: LockedAmount accounting - teleport beyond `balance - locked`
 * @description Validates cross-chain token accounting when a user has tokens locked
 *              via `teleportToPublicChain` (bucket (a) lock: balance is debited,
 *              tokens held at `address(this)`, `lockedAmount[user]` incremented) and
 *              then teleports to a different chain an amount greater than
 *              `balance - lockedAmount` but still within the raw ERC20 balance.
 *
 * INVARIANT UNDER TEST:
 *   Sum of the user's balances across origin + destination + public chain at the
 *   end of the flow equals the sum before. No double-spend. The contract-held
 *   lock tokens are released exactly once via the public-chain return path.
 *
 * TEST SEQUENCE:
 *   1. user has initial balance `origBalance` on origin (private) chain.
 *   2. teleportToPublicChain(lockAmount): balance -> origBalance - lockAmount,
 *      lockedAmount -> origLocked + lockAmount, contract holds lockAmount,
 *      public chain mints lockAmount to the user.
 *   3. teleportAtomic(teleportAmount = (balance - lockedAmount) + 1, destChain):
 *      succeeds because the amount is still within the raw ERC20 balance.
 *   4. burnTokensOnPublicChain(lockAmount) triggers
 *      receiveTeleportFromPublicChain on origin: unlock + transfer from contract
 *      back to user.
 *   5. Assert atomic delivery on destChain completes.
 *   6. Assert global invariant: origin + public + dest final == origin + public
 *      initial.
 *
 * SECURITY IMPLICATION:
 *   A test failure (step-6 inequality) would indicate that bucket (a) locked
 *   tokens can be double-claimed or that the user's teleport interferes with
 *   the locked-token release path.
 */
import { expect } from 'chai';
import { ethers } from 'ethers';
import {
  ProductionErc20Token,
  ProductionErc20Token__factory,
  RaylsPublicERC20Handler__factory,
} from '../../../typechain-types';
import {
  DEFAULT_TIMEOUT,
  GAS_LIMIT,
  LOGGER,
  PRIVATE_KEY_SYSTEM,
  PUBLIC_CHAIN_RPC_URL,
} from '../../../src/config/env-config';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { ERC20Wrapper } from '../../../src/entities/tokens/ERC20Wrapper';
import { eventually, sendTx, submitTx } from '../../../src/utils/common';
import { shortHex } from '../../../src/utils/formatters';
import { getProvider } from '../../../src/utils/network-utils';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';

describe('E2E SECURITY: LockedAmount - teleport beyond (balance - locked) preserves accounting @security @erc20 @decommissioned', function () {
  this.timeout(DEFAULT_TIMEOUT * 3);
  this.retries(0);

  const MINT_AMOUNT = 2000n;
  const TX_OPTS = { gasLimit: GAS_LIMIT } as const;
  const PC_CHAIN_ID = process.env.PUBLIC_CHAIN_ID || '7331';

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

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

  let publicProvider: ethers.JsonRpcProvider;
  let userPrivateSigner: ethers.Wallet;
  let userPublicSigner: ethers.Wallet;
  let systemPublicSigner: ethers.Wallet;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    // Create an approved user via governance (teleportToPublicChain is onlyRegisteredUsers).
    const userGovAsOperator = await privacyNodes.A.getUserGovernance();
    const userGovAsBankEmployee = (await privacyNodes.A.getContractAt(
      'RNUserGovernanceV1',
      privacyNodes.A.raylsNodeUserGovernance,
      'RNUserGovernanceV1',
      privacyNodes.A.bankEmployeeWallet,
    )) as any;
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

    publicProvider = getProvider(PUBLIC_CHAIN_RPC_URL);
    userPrivateSigner = new ethers.Wallet(user.privatePrivateKey, privacyNodes.A.provider);
    userPublicSigner = new ethers.Wallet(user.publicPrivateKey, publicProvider);
    systemPublicSigner = new ethers.Wallet(PRIVATE_KEY_SYSTEM, publicProvider);

    // Deploy + register ERC20. This flow needs BOTH legs: hub (for teleportAtomic to B)
    // and public chain (for teleportToPublicChain).
    tokenWrapper = new ERC20Wrapper(privacyNodes.A, ProductionErc20Token__factory);
    await tokenWrapper.deploy();
    await tokenWrapper.activateOnPn();
    await tokenWrapper.activateOnHub(privateHub);
    tokenAddress = tokenWrapper.address[privacyNodes.A.chainId];
    LOGGER.info(`ERC20 ${tokenAddress} registered and active`);

    publicTokenAddress = await tokenWrapper.activateOnPublicChain();
    LOGGER.info(`Public token at: ${publicTokenAddress}`);

    // Fund user on public chain for gas (one-time) and mint initial supply on PN-A.
    // Public chain is non-gasless (48 Gwei base fee): each tx reserves
    // GAS_LIMIT * maxFeePerGas up front, so 0.1 is far too low.
    await fundPublicChainAddress(user.publicAddress, '100');
    await sendTx(
      () => tokenWrapper.contract.mint(user.privateAddress, MINT_AMOUNT, TX_OPTS),
      'mint initial supply',
    );
  });

  it('teleportToPublicChain(lockAmount) then teleportAtomic(newAvailable + 1) preserves cross-chain accounting', async function () {
    LOGGER.log('\n   ============================================================');
    LOGGER.log('   LockedAmount accounting - bucket (a) lock path');
    LOGGER.log('   ============================================================');

    const privateToken = getPrivateToken();
    const publicToken = RaylsPublicERC20Handler__factory.connect(publicTokenAddress, userPublicSigner);
    const destChainId = privacyNodes.B.chainId;

    const origBalance = await privateToken.balanceOf(user.privateAddress);
    const origLocked = await privateToken.getLockedAmount(user.privateAddress);
    const origPublic = await publicToken.balanceOf(user.publicAddress);
    const available = origBalance - origLocked;
    const lockAmount = available / 3n;
    expect(lockAmount).to.be.gt(0n, 'test pre-condition: user has free balance to lock');

    LOGGER.log(`   origin.balance          = ${origBalance}`);
    LOGGER.log(`   origin.locked           = ${origLocked}`);
    LOGGER.log(`   available (b - l)       = ${available}`);
    LOGGER.log(`   lockAmount              = ${lockAmount}`);
    LOGGER.log(`   public.balance          = ${origPublic}`);

    // ── STEP 1: teleportToPublicChain(lockAmount) - bucket (a) lock ─────────
    LOGGER.log(`\n   STEP 1: teleportToPublicChain(${lockAmount})`);
    await sendTx(
      () => privateToken.teleportToPublicChain(user.publicAddress, lockAmount, PC_CHAIN_ID, TX_OPTS),
      'teleportToPublicChain',
    );

    // Wait for relayer to mint on public chain (the lock on private chain is already
    // applied synchronously because _lock is local).
    const mintedOnPublic = await eventually<boolean>({
      check: async () => (await publicToken.balanceOf(user.publicAddress)) >= origPublic + lockAmount,
      interval: 2000,
      attempts: 30,
      message: `Waiting for public mint ${lockAmount} → ${shortHex(user.publicAddress)} (balance ≥ ${origPublic + lockAmount})`,
    });
    expect(mintedOnPublic, 'public chain should mint lockAmount to user').to.be.true;

    const newBalance = await privateToken.balanceOf(user.privateAddress);
    const newLocked = await privateToken.getLockedAmount(user.privateAddress);
    const newAvailable = newBalance - newLocked;
    LOGGER.log(`   private.balance now     = ${newBalance}   (expect ${origBalance - lockAmount})`);
    LOGGER.log(`   private.locked now      = ${newLocked}    (expect ${origLocked + lockAmount})`);
    LOGGER.log(`   newAvailable (b - l)    = ${newAvailable}`);
    expect(newBalance).to.equal(origBalance - lockAmount, 'balance decreased by lockAmount');
    expect(newLocked).to.equal(origLocked + lockAmount, 'locked increased by lockAmount');

    // ── STEP 2: teleportAtomic beyond newAvailable but within raw balance ───
    // Soundness here rests on the ERC20 _burn invariant: the burn must be within
    // the caller's raw balance. The pre-condition below asserts that.
    const teleportAmount = newAvailable + 1n;
    expect(teleportAmount).to.be.lte(
      newBalance,
      'teleportAmount must be within raw ERC20 balance (otherwise _burn reverts on balance)',
    );

    LOGGER.log(`\n   STEP 2: teleportAtomic(${teleportAmount}) to chain ${destChainId}`);

    await submitTx(
      () => privateToken.teleportAtomic(
        user.privateAddress,  // send to self on destChain (arrives via atomic mint)
        teleportAmount,
        destChainId,
        TX_OPTS,
      ),
      `teleportAtomic(${teleportAmount})`,
    );

    const afterAtomicBalance = await privateToken.balanceOf(user.privateAddress);
    const afterAtomicLocked = await privateToken.getLockedAmount(user.privateAddress);
    LOGGER.log(`   private.balance         = ${afterAtomicBalance}  (expect ${newBalance - teleportAmount})`);
    LOGGER.log(`   private.locked          = ${afterAtomicLocked}   (unchanged)`);
    expect(afterAtomicBalance).to.equal(newBalance - teleportAmount);
    expect(afterAtomicLocked).to.equal(newLocked, 'user teleport must not touch the lock');

    // ── STEP 3: trigger the lock return (public → private) and unlock ─────
    LOGGER.log(`\n   STEP 3: burn ${lockAmount} on public chain → receiveTeleportFromPublicChain unlocks`);
    await sendTx(
      () => publicToken.teleportToPrivacyNode(user.privateAddress, lockAmount, privacyNodes.A.chainId, TX_OPTS),
      'teleportToPrivacyNode (burn on public)',
    );
    const unlocked = await eventually<boolean>({
      check: async () => (await privateToken.getLockedAmount(user.privateAddress)) <= origLocked,
      interval: 3000,
      attempts: 30,
      message: `Waiting for public→private unlock (${shortHex(user.privateAddress)}, lockedAmount ≤ ${origLocked})`,
    });
    expect(unlocked, 'relayer should process the public → private return and unlock').to.be.true;

    // ── STEP 4: cross-chain accounting invariant ──────────────────────────
    LOGGER.log('\n   STEP 4: global accounting invariant');
    const finalOriginBalance = await privateToken.balanceOf(user.privateAddress);
    const finalPublicBalance = await publicToken.balanceOf(user.publicAddress);

    // Expected end state:
    //   origin   = origBalance - teleportAmount  (teleportAtomic burned teleportAmount)
    //   public   = origPublic                    (lockAmount minted then burned back)
    //   destChain = teleportAmount               (teleportAtomic mint on dest)
    LOGGER.log(`   origin.balance final    = ${finalOriginBalance}  (expect ${origBalance - teleportAmount})`);
    LOGGER.log(`   public.balance final    = ${finalPublicBalance}  (expect ${origPublic})`);

    expect(finalOriginBalance).to.equal(
      origBalance - teleportAmount,
      'origin accounting: initial - teleportAtomic burn = remainder + returned lock',
    );
    expect(finalPublicBalance).to.equal(
      origPublic,
      'public accounting: lockAmount went in, lockAmount came back',
    );

    // Wait for atomic receive on destChain, then add it to the total.
    const tokenOnB = await privacyNodes.B.setContractByResourceId(
      'ProductionErc20Token',
      tokenWrapper.resourceId,
      tokenWrapper.symbol,
      userPrivateSigner.connect(privacyNodes.B.provider),
    ) as ProductionErc20Token;
    const destArrived = await eventually<boolean>({
      check: async () => (await tokenOnB.balanceOf(user.privateAddress)) >= teleportAmount,
      interval: 3000,
      attempts: 60,
      message: `Waiting for atomic teleport on B: balance for ${shortHex(user.privateAddress)} ≥ ${teleportAmount}`,
    });
    expect(destArrived, 'atomic teleport should complete delivery on destChain').to.be.true;

    const finalDestBalance = await tokenOnB.balanceOf(user.privateAddress);
    const totalAcrossChains = finalOriginBalance + finalPublicBalance + finalDestBalance;
    LOGGER.log(`   dest.balance final      = ${finalDestBalance}`);
    LOGGER.log(`   sum across chains       = ${totalAcrossChains}  (expect ${origBalance + origPublic})`);
    expect(totalAcrossChains).to.equal(
      origBalance + origPublic,
      'cross-chain accounting invariant violated: tokens were created or destroyed',
    );
  });

  // ─────────────────────────────────────────────────────────────────────────
  //                              HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  function getPrivateToken(): ProductionErc20Token {
    return tokenWrapper.contract.connect(userPrivateSigner) as ProductionErc20Token;
  }

  async function fundPublicChainAddress(address: string, amount: string): Promise<void> {
    const tx = await systemPublicSigner.sendTransaction({
      to: address,
      value: ethers.parseEther(amount),
    });
    await tx.wait();
  }
});
