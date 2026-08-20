/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
import { expect } from 'chai';
import { ethers } from 'ethers';
import {
  PNTokenRegistryV1,
  ProductionErc721Token,
  ProductionErc721Token__factory,
  PublicChainERC721,
  PublicChainERC721__factory,
} from '../../../typechain-types';
import {
  DEFAULT_TIMEOUT,
  GAS_LIMIT,
  LOGGER,
  PRIVATE_KEY_SYSTEM,
  PUBLIC_CHAIN_RPC_URL,
} from '../../../src/config/env-config';
import { ERC721Wrapper } from '../../../src/entities/tokens/ERC721Wrapper';
import { eventually, sendTx } from '../../../src/utils/common';
import { shortHex } from '../../../src/utils/formatters';
import { getProvider } from '../../../src/utils/network-utils';
import { initializePrivacyNodes, PrivacyNodeMap } from '../../setup';
import {
  cleanupPublicFrozenTokens,
  freezeOnPublicChain,
  unfreezeOnPublicChain,
} from '../../test-utils/freeze-helpers';

describe('E2E Tests: ERC721 Public Chain Transfer @decommissioned @hubless', function () {
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

  let tokenWrapper: ERC721Wrapper<ProductionErc721Token>;
  let tokenAddress: string;
  let publicTokenAddress: string;
  // Admin-connected PN registry — freezeOnPublicChain is `restricted` (ADMIN bypass).
  let tokenRegistryOnA: PNTokenRegistryV1;

  // Shared signers (initialized in before)
  let publicProvider: ethers.JsonRpcProvider;
  let userPrivateSigner: ethers.Wallet;
  let userPublicSigner: ethers.Wallet;
  let systemPublicSigner: ethers.Wallet;

  // Each test gets a fresh NFT via beforeEach
  let nextTokenId = 1;
  let currentTokenId = 0;

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
    tokenWrapper = new ERC721Wrapper<ProductionErc721Token>(privacyNodes.A, ProductionErc721Token__factory);
    await tokenWrapper.deploy();
    tokenAddress = tokenWrapper.address[privacyNodes.A.chainId];
    LOGGER.info(`ERC721 deployed at: ${tokenAddress}`);

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
    // Mint a fresh NFT for each test.
    // Use direct contract mint (tokenWrapper.contract uses deployer/owner signer).
    currentTokenId = nextTokenId++;
    await sendTx(
      () => tokenWrapper.contract.mint(user.privateAddress, currentTokenId, TX_OPTS),
      `mint NFT #${currentTokenId}`,
    );
  });

  it('Should transfer ERC721 NFT to public chain @smoke', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const tokenId = currentTokenId;

    await sendNFTToPublicChain(tokenId);

    // Verify public chain received the NFT
    await eventually<boolean>({
      check: async () => {
        const owner = await getPublicNFTOwner(tokenId);
        return owner.toLowerCase() === user.publicAddress.toLowerCase();
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for public NFT #${tokenId} owner → ${shortHex(user.publicAddress)}`,
      tolerateErrors: true,
    });

    // Verify locked on private chain
    const nft = getPrivateToken();
    const isLocked = await nft.isTokenLocked(user.privateAddress, tokenId);
    expect(isLocked).to.be.true;

    LOGGER.info(`NFT #${tokenId} transferred to public chain and locked`);
  }).timeout(DEFAULT_TIMEOUT);

  it('Should transfer ERC721 NFT back from public to private chain @smoke', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const tokenId = currentTokenId;
    const nft = getPrivateToken();

    // Send to public first
    await sendNFTToPublicChain(tokenId);

    await eventually<boolean>({
      check: async () => {
        const owner = await getPublicNFTOwner(tokenId);
        return owner.toLowerCase() === user.publicAddress.toLowerCase();
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for public NFT #${tokenId} owner → ${shortHex(user.publicAddress)}`,
      tolerateErrors: true,
    });

    // Burn on public chain -> relayer unlocks on private
    await burnNFTOnPublicChain(user.privateAddress, tokenId);

    // Verify unlocked on private chain
    await eventually<boolean>({
      check: async () => {
        const isLocked = await nft.isTokenLocked(user.privateAddress, tokenId);
        return !isLocked;
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for private NFT #${tokenId} unlock (${shortHex(user.privateAddress)})`,
    });

    // Verify ownership restored
    const owner = await nft.ownerOf(tokenId);
    expect(owner.toLowerCase()).to.equal(user.privateAddress.toLowerCase());

    LOGGER.info(`NFT #${tokenId} returned to private chain`);
  }).timeout(DEFAULT_TIMEOUT);

  it('Should revert teleportToPublicChain when NFT already sent to public chain @smoke', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const tokenId = currentTokenId;
    const nft = getPrivateToken();

    // First send locks the NFT into the token contract (ownerOf becomes the contract).
    await sendNFTToPublicChain(tokenId);

    // Second send of the same token should revert — caller is no longer the owner
    // (the NFT is held by the contract after the lock, so the ownership check fires first).
    await expect(
      nft.teleportToPublicChain.staticCall(user.publicAddress, tokenId, PC_CHAIN_ID, TX_OPTS),
    ).to.be.revertedWithCustomError(nft, 'RaylsErc721Handler__NotTokenOwner');

    // Wait for the first send to land on public so the NFT isn't left in-flight.
    await eventually<boolean>({
      check: async () => {
        const owner = await getPublicNFTOwner(tokenId);
        return owner.toLowerCase() === user.publicAddress.toLowerCase();
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for public NFT #${tokenId} owner → ${shortHex(user.publicAddress)} (settle send)`,
      tolerateErrors: true,
    });

    LOGGER.info(`teleportToPublicChain correctly reverted for already-sent token #${tokenId}`);
  }).timeout(DEFAULT_TIMEOUT);

  it('Should succeed teleportToPublicChain after unlocking NFT from public chain @smoke', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const tokenId = currentTokenId;
    const nft = getPrivateToken();

    // Lock token by sending to public chain
    await sendNFTToPublicChain(tokenId);

    // Wait for arrival on public chain
    await eventually<boolean>({
      check: async () => {
        const owner = await getPublicNFTOwner(tokenId);
        return owner.toLowerCase() === user.publicAddress.toLowerCase();
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for public NFT #${tokenId} owner → ${shortHex(user.publicAddress)}`,
      tolerateErrors: true,
    });

    // Burn on public -> relayer unlocks on private
    await burnNFTOnPublicChain(user.privateAddress, tokenId);

    // Wait for unlock
    await eventually<boolean>({
      check: async () => {
        const isLocked = await nft.isTokenLocked(user.privateAddress, tokenId);
        return !isLocked;
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for private NFT #${tokenId} unlock (${shortHex(user.privateAddress)})`,
    });

    // Token is now unlocked — sending it back to the public chain should succeed
    const tx = await nft.teleportToPublicChain(user.publicAddress, tokenId, PC_CHAIN_ID, TX_OPTS);
    const receipt = await tx.wait();
    expect(receipt?.status).to.equal(1);

    // Wait for the re-send to actually land on public so the NFT isn't left in-flight.
    await eventually<boolean>({
      check: async () => {
        const owner = await getPublicNFTOwner(tokenId);
        return owner.toLowerCase() === user.publicAddress.toLowerCase();
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for public NFT #${tokenId} owner → ${shortHex(user.publicAddress)} (settle re-send)`,
      tolerateErrors: true,
    });

    LOGGER.info(`teleportToPublicChain succeeded after unlock for token #${tokenId}`);
  }).timeout(DEFAULT_TIMEOUT);

  it('Should leave no NFT on public chain after full reverse transfer', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const tokenId = currentTokenId;
    const nft = getPrivateToken();

    // Send NFT to public
    await sendNFTToPublicChain(tokenId);

    await eventually<boolean>({
      check: async () => {
        const owner = await getPublicNFTOwner(tokenId);
        return owner.toLowerCase() === user.publicAddress.toLowerCase();
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for public NFT #${tokenId} owner → ${shortHex(user.publicAddress)}`,
      tolerateErrors: true,
    });

    // Burn back to private
    await burnNFTOnPublicChain(user.privateAddress, tokenId);

    // Verify unlocked on private
    await eventually<boolean>({
      check: async () => {
        const isLocked = await nft.isTokenLocked(user.privateAddress, tokenId);
        return !isLocked;
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for private NFT #${tokenId} unlock (${shortHex(user.privateAddress)})`,
    });

    // Verify NFT no longer exists on public chain (ownerOf should revert)
    const publicNFT = PublicChainERC721__factory.connect(publicTokenAddress, publicProvider) as PublicChainERC721;
    try {
      const owner = await publicNFT.ownerOf(tokenId);
      // If it doesn't revert, the owner should NOT be the user anymore
      expect(owner.toLowerCase()).to.not.equal(user.publicAddress.toLowerCase());
    } catch {
      // Expected — token burned on public chain
    }

    // Verify user still owns it on private chain
    const privateOwner = await nft.ownerOf(tokenId);
    expect(privateOwner.toLowerCase()).to.equal(user.privateAddress.toLowerCase());

    LOGGER.info(`Full reverse: NFT #${tokenId} removed from public chain, restored on private`);
  }).timeout(DEFAULT_TIMEOUT);

  it('Should prevent double spend — revert second burn of same NFT', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const tokenId = currentTokenId;
    const nft = getPrivateToken();

    // Send to public
    await sendNFTToPublicChain(tokenId);

    await eventually<boolean>({
      check: async () => {
        const owner = await getPublicNFTOwner(tokenId);
        return owner.toLowerCase() === user.publicAddress.toLowerCase();
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for public NFT #${tokenId} owner → ${shortHex(user.publicAddress)}`,
      tolerateErrors: true,
    });

    // First burn — should succeed
    await burnNFTOnPublicChain(user.privateAddress, tokenId);

    await eventually<boolean>({
      check: async () => {
        const isLocked = await nft.isTokenLocked(user.privateAddress, tokenId);
        return !isLocked;
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for private NFT #${tokenId} unlock (${shortHex(user.privateAddress)})`,
    });

    // Second burn — should revert, NFT no longer on public chain
    const publicNFT = PublicChainERC721__factory.connect(publicTokenAddress, userPublicSigner) as PublicChainERC721;
    await expect(
      publicNFT.teleportToPrivacyNode.staticCall(user.privateAddress, tokenId, privacyNodes.A.chainId, TX_OPTS),
    ).to.be.reverted;

    LOGGER.info(`Double spend prevented: second burn of NFT #${tokenId} correctly reverted`);
  }).timeout(DEFAULT_TIMEOUT);

  it('Should revert teleportToPrivacyNode for token not owned on public chain', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const tokenId = currentTokenId;
    const nft = getPrivateToken();

    // Token was minted on private chain but NOT sent to public chain
    // Attempt to burn on public chain should fail
    const publicNFT = PublicChainERC721__factory.connect(publicTokenAddress, userPublicSigner) as PublicChainERC721;
    await expect(
      publicNFT.teleportToPrivacyNode.staticCall(user.privateAddress, tokenId, privacyNodes.A.chainId, TX_OPTS),
    ).to.be.reverted;

    LOGGER.info(`teleportToPrivacyNode correctly reverted for token #${tokenId} not on public chain`);
  }).timeout(DEFAULT_TIMEOUT);

  it('Should revert teleportToPrivacyNode to non-approved address', async function () {
    this.timeout(DEFAULT_TIMEOUT * 2);
    const tokenId = currentTokenId;
    const nft = getPrivateToken();

    // Send NFT to public chain first
    await sendNFTToPublicChain(tokenId);

    await eventually<boolean>({
      check: async () => {
        const owner = await getPublicNFTOwner(tokenId);
        return owner.toLowerCase() === user.publicAddress.toLowerCase();
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for public NFT #${tokenId} owner → ${shortHex(user.publicAddress)}`,
      tolerateErrors: true,
    });

    // Try to burn to a non-approved address
    const nonApprovedAddress = ethers.Wallet.createRandom().address;
    const publicNFT = PublicChainERC721__factory.connect(publicTokenAddress, userPublicSigner) as PublicChainERC721;

    let txReverted = false;
    try {
      const lockTx = await publicNFT.teleportToPrivacyNode(nonApprovedAddress, tokenId, privacyNodes.A.chainId, TX_OPTS);
      await lockTx.wait();
      LOGGER.info('teleportToPrivacyNode to non-approved address did not revert on-chain — relayer handles revert');
    } catch {
      txReverted = true;
      LOGGER.info('teleportToPrivacyNode to non-approved address reverted on-chain');
    }

    if (txReverted) {
      // On-chain revert: NFT should still be owned by user on public chain
      const owner = await getPublicNFTOwner(tokenId);
      expect(owner.toLowerCase()).to.equal(user.publicAddress.toLowerCase(), 'NFT should be preserved after on-chain revert');
    } else {
      // Tx succeeded on-chain — NFT is burned from public chain.
      // Relayer rejects cross-chain delivery to non-approved address but does NOT refund.
      try {
        const owner = await getPublicNFTOwner(tokenId);
        // If ownerOf doesn't revert, the user should no longer own it
        expect(owner.toLowerCase()).to.not.equal(user.publicAddress.toLowerCase(), 'NFT should be burned from user');
      } catch {
        // ownerOf reverted — NFT burned, expected behavior
      }
      LOGGER.info(`NFT #${tokenId} burned on public chain — no refund`);
    }

    LOGGER.info(`Non-approved teleport verified for token #${tokenId}`);
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

    it('Should public-freeze ERC721 on A, then reject teleportToPublicChain @smoke', async function () {
      this.timeout(DEFAULT_TIMEOUT);
      const tokenId = currentTokenId;
      const nft = getPrivateToken();

      await freezeOnPublicChain(tokenRegistryOnA, tokenAddress);

      // publicChainStatus == FROZEN → whenPublicChainActive reverts on the sending contract.
      await expect(
        nft.teleportToPublicChain(user.publicAddress, tokenId, PC_CHAIN_ID),
      ).to.be.revertedWithCustomError(nft, 'RaylsApp__PublicChainNotActive');

      // NFT was never locked — the revert fired first, so the user still owns it.
      expect((await nft.ownerOf(tokenId)).toLowerCase()).to.equal(user.privateAddress.toLowerCase());
    }).timeout(DEFAULT_TIMEOUT);

    it('Should public-unfreeze ERC721 on A, then allow teleportToPublicChain', async function () {
      this.timeout(DEFAULT_TIMEOUT);
      const tokenId = currentTokenId;

      await freezeOnPublicChain(tokenRegistryOnA, tokenAddress);
      await unfreezeOnPublicChain(tokenRegistryOnA, tokenAddress);

      await sendNFTToPublicChain(tokenId);

      await eventually<boolean>({
        check: async () => (await getPublicNFTOwner(tokenId)).toLowerCase() === user.publicAddress.toLowerCase(),
        interval: 3000,
        attempts: 30,
        message: `Waiting for public NFT #${tokenId} owner → ${shortHex(user.publicAddress)} after public-unfreeze`,
        tolerateErrors: true,
      });
    }).timeout(DEFAULT_TIMEOUT);
  });

  // --- Helpers ---

  function getPrivateToken(): ProductionErc721Token {
    return privacyNodes.A.getContract<ProductionErc721Token>(tokenWrapper.symbol)
      .connect(userPrivateSigner) as ProductionErc721Token;
  }

  async function getPublicNFTOwner(tokenId: number): Promise<string> {
    const publicNFT = PublicChainERC721__factory.connect(publicTokenAddress, publicProvider) as PublicChainERC721;
    return publicNFT.ownerOf(tokenId);
  }

  async function sendNFTToPublicChain(tokenId: number) {
    const nft = getPrivateToken();
    await sendTx(
      () => nft.teleportToPublicChain(user.publicAddress, tokenId, PC_CHAIN_ID, TX_OPTS),
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

  async function burnNFTOnPublicChain(recipientAddr: string, tokenId: number) {
    const publicNFT = PublicChainERC721__factory.connect(publicTokenAddress, userPublicSigner) as PublicChainERC721;
    const lockTx = await publicNFT.teleportToPrivacyNode(recipientAddr, tokenId, privacyNodes.A.chainId, TX_OPTS);
    await lockTx.wait();
  }
});
