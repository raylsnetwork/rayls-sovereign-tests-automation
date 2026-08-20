/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
import hre from 'hardhat';
import { expect } from 'chai';
import {
  TokenExample,
  TokenExample__factory,
  TokenRegistryV1,
  PNTokenRegistryV1,
  PNTokenFreezeManagerV1,
  ProductionErc721Token,
  ProductionErc721Token__factory,
  RaylsErc1155Example,
  RaylsErc1155Example__factory,
} from '../../typechain-types';
import { PrivateHub } from '../../src/entities/PrivateHub';
import { BEFORE_HOOK_TIMEOUT, DEFAULT_TIMEOUT, GAS_LIMIT } from '../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../setup';
import { ERC20Wrapper } from '../../src/entities/tokens/ERC20Wrapper';
import { ERC721Wrapper } from '../../src/entities/tokens/ERC721Wrapper';
import { ERC1155Wrapper } from '../../src/entities/tokens/ERC1155Wrapper';
import { createRandomWallet, eventually, sendTx, submitTx } from '../../src/utils/common';
import { shortHex } from '../../src/utils/formatters';
import {
  cleanupFrozenTokens,
  cleanupPnFrozenTokens,
  freezeAndSync,
  freezeOnPn,
  unfreezeAndSync,
  unfreezeOnPn,
} from '../test-utils/freeze-helpers';

const TRANSFER_AMOUNT = 100n;
const ERC1155_INITIAL_TRANSFER = 25n;

describe('E2E Tests: Freeze Tokens (ERC20/ERC721/ERC1155) @decommissioned', function () {
  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let tokenRegistry: TokenRegistryV1;
  let tokenRegistryOnA: PNTokenRegistryV1;
  let tokenRegistryOnB: PNTokenRegistryV1;
  let freezeManagerOnA: PNTokenFreezeManagerV1;
  let erc20Token: ERC20Wrapper<TokenExample>;
  let erc20TokenOnB: TokenExample;
  let erc721Token: ERC721Wrapper<ProductionErc721Token>;
  let erc721TokenOnB: ProductionErc721Token;
  let erc1155Token: ERC1155Wrapper<RaylsErc1155Example>;
  let erc1155TokenOnB: RaylsErc1155Example;

  before(async function () {
    this.timeout(BEFORE_HOOK_TIMEOUT(9)); // 3 tokens: ERC20 + ERC721 + ERC1155

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    tokenRegistry = await privateHub.getTokenRegistryAsCompliance();
    // getFrozenTokenForParticipant is `restricted` — connect an ADMIN signer so the poll can read it.
    tokenRegistryOnA = await privacyNodes.A.getPnTokenRegistry(privacyNodes.A.adminWallet);
    tokenRegistryOnB = await privacyNodes.B.getPnTokenRegistry(privacyNodes.B.adminWallet);
    freezeManagerOnA = await privacyNodes.A.getPnTokenFreezeManager(privacyNodes.A.adminWallet);

    // Setup ERC20 token (constructor-deploy path; factory path hits RaylsAccessManaged__Unauthorized).
    // Constructor-deployed TokenExample mints its default supply to the deployer (userWallet) — no mint needed.
    erc20Token = new ERC20Wrapper<TokenExample>(privacyNodes.A, TokenExample__factory);
    await erc20Token.deploy();
    await erc20Token.activateOnPn();
    await erc20Token.activateOnHub(privateHub);

    // Transfer ERC20 to B to set up contract on B
    await submitTx(
      () => erc20Token.contract.teleportAtomic(
        erc20Token.userWallet.address,
        TRANSFER_AMOUNT,
        privacyNodes.B.chainId,
        { gasLimit: GAS_LIMIT }
      ),
      'Teleporting ERC20 from A to B'
    );

    erc20TokenOnB = await privacyNodes.B.setContractByResourceId(
      TokenExample__factory.name,
      erc20Token.resourceId,
      erc20Token.symbol,
      erc20Token.userWallet.connect(privacyNodes.B.provider)
    );

    await eventually<boolean>({
      check: async () => {
        const balance = await erc20TokenOnB.balanceOf(erc20Token.userWallet.address);
        return balance === TRANSFER_AMOUNT;
      },
      message: `Waiting for ${erc20Token.symbol} balance on PN B`,
    });

    // Setup ERC721 token (constructor-deploy path). Production factory (no constructor premint) —
    // RaylsErc721Example pre-mints ids 0/100/150 to the deployer, which collides with the explicit
    // mint(0) below. Mirrors the canonical ERC721.ts suite.
    erc721Token = new ERC721Wrapper<ProductionErc721Token>(privacyNodes.A, ProductionErc721Token__factory);
    await erc721Token.deploy();
    await erc721Token.activateOnPn();
    await erc721Token.activateOnHub(privateHub);

    // Mint #0 before teleporting it.
    await erc721Token.mintAndAwait(privateHub, { toAddress: erc721Token.userWallet.address, tokenId: 0n });

    // Mint and transfer ERC721 to B
    await submitTx(
      () => erc721Token.contract.teleportAtomic(
        erc721Token.userWallet.address,
        0,
        privacyNodes.B.chainId,
        { gasLimit: GAS_LIMIT }
      ),
      'Teleporting ERC721 from A to B'
    );

    erc721TokenOnB = await privacyNodes.B.setContractByResourceId(
      ProductionErc721Token__factory.name,
      erc721Token.resourceId,
      erc721Token.symbol,
      erc721Token.userWallet.connect(privacyNodes.B.provider)
    );

    await eventually<boolean>({
      check: async () => {
        const owner = await erc721TokenOnB.ownerOf(0);
        return owner === erc721Token.userWallet.address;
      },
      message: `Waiting for ${erc721Token.symbol} #0 owner on PN B`,
      tolerateErrors: true,
    });

    // Setup ERC1155 token (constructor-deploy path)
    erc1155Token = new ERC1155Wrapper<RaylsErc1155Example>(privacyNodes.A, RaylsErc1155Example__factory);
    await erc1155Token.deploy();
    await erc1155Token.activateOnPn();
    await erc1155Token.activateOnHub(privateHub);

    // Mint id 0 before teleporting it.
    // A keeps a balance after sending ERC1155_INITIAL_TRANSFER so the freeze tests can move more.
    await erc1155Token.mintAndAwait(privateHub, {
      toAddress: erc1155Token.userWallet.address,
      tokenId: 0n,
      amount: 100n,
    });

    // Transfer ERC1155 to B — only a subset so A keeps tokens for the freeze tests.
    await submitTx(
      () => erc1155Token.contract.teleportAtomic(
        erc1155Token.userWallet.address,
        0,
        ERC1155_INITIAL_TRANSFER,
        privacyNodes.B.chainId,
        hre.ethers.toUtf8Bytes(''),
        { gasLimit: GAS_LIMIT }
      ),
      'Teleporting ERC1155 from A to B'
    );

    erc1155TokenOnB = await privacyNodes.B.setContractByResourceId(
      RaylsErc1155Example__factory.name,
      erc1155Token.resourceId,
      erc1155Token.symbol,
      erc1155Token.userWallet.connect(privacyNodes.B.provider)
    );

    await eventually<boolean>({
      check: async () => {
        const balance = await erc1155TokenOnB.balanceOf(erc1155Token.userWallet.address, 0);
        return balance === ERC1155_INITIAL_TRANSFER;
      },
      message: `Waiting for ${erc1155Token.symbol} balance on PN B`,
    });
  });

  afterEach(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    await cleanupFrozenTokens(tokenRegistry, [tokenRegistryOnA, tokenRegistryOnB], [
      { resourceId: erc20Token.resourceId, chainIds: [privacyNodes.A.chainId, privacyNodes.B.chainId] },
      { resourceId: erc721Token.resourceId, chainIds: [privacyNodes.A.chainId, privacyNodes.B.chainId] },
      { resourceId: erc1155Token.resourceId, chainIds: [privacyNodes.A.chainId, privacyNodes.B.chainId] },
    ]);
  });

  describe('ERC20 Token Freeze', function () {
    it('Should reject unauthorized freeze attempt', async function () {
      const randomSigner = createRandomWallet(privateHub.provider);

      await expect(tokenRegistry.connect(randomSigner).freezeToken(erc20Token.resourceId, [privacyNodes.A.chainId])).to.be
        .reverted;
    }).timeout(DEFAULT_TIMEOUT);

    it('Should freeze ERC20 token for participants A and B, then reject teleportAtomic', async function () {
      const initialBalanceA = await erc20Token.contract.balanceOf(erc20Token.userWallet.address);
      const initialBalanceB = await erc20TokenOnB.balanceOf(erc20Token.userWallet.address);

      await freezeAndSync(tokenRegistry, erc20Token.resourceId, [privacyNodes.A.chainId, privacyNodes.B.chainId], [
        { replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId },
        { replica: tokenRegistryOnB, chainId: privacyNodes.B.chainId },
      ]);

      // Source (A) is frozen → the whenHubActive modifier reverts before MessageSender runs.
      await expect(
        erc20Token.contract.teleportAtomic(erc20Token.userWallet.address, 50n, privacyNodes.B.chainId)
      ).to.be.revertedWithCustomError(erc20Token.contract, 'RaylsApp__HubNotActive');

      const finalBalanceA = await erc20Token.contract.balanceOf(erc20Token.userWallet.address);
      const finalBalanceB = await erc20TokenOnB.balanceOf(erc20Token.userWallet.address);
      expect(finalBalanceA).to.equal(initialBalanceA);
      expect(finalBalanceB).to.equal(initialBalanceB);
    }).timeout(DEFAULT_TIMEOUT);

    it('Should unfreeze ERC20 token for participants A and B, then allow teleportAtomic', async function () {
      const initialBalanceA = await erc20Token.contract.balanceOf(erc20Token.userWallet.address);
      const initialBalanceB = await erc20TokenOnB.balanceOf(erc20Token.userWallet.address);

      await freezeAndSync(tokenRegistry, erc20Token.resourceId, [privacyNodes.A.chainId, privacyNodes.B.chainId], [
        { replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId },
        { replica: tokenRegistryOnB, chainId: privacyNodes.B.chainId },
      ]);

      await unfreezeAndSync(tokenRegistry, erc20Token.resourceId, [privacyNodes.A.chainId, privacyNodes.B.chainId], [
        { replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId },
        { replica: tokenRegistryOnB, chainId: privacyNodes.B.chainId },
      ]);

      await sendTx(() => erc20Token.contract.teleportAtomic(erc20Token.userWallet.address, 50n, privacyNodes.B.chainId));

      await eventually<boolean>({
        check: async () => {
          const [balA, balB] = await Promise.all([
            erc20Token.contract.balanceOf(erc20Token.userWallet.address),
            erc20TokenOnB.balanceOf(erc20Token.userWallet.address),
          ]);
          return balA === initialBalanceA - 50n && balB === initialBalanceB + 50n;
        },
        interval: 1000,
        attempts: 240,
        message: `Waiting for ${erc20Token.symbol} unfreeze: A → ${initialBalanceA - 50n}, B → ${initialBalanceB + 50n}`,
      });
    }).timeout(DEFAULT_TIMEOUT);
  });

  describe('ERC721 Token Freeze', function () {
    it('Should freeze ERC721 token for participants A and B, then reject teleportAtomic', async function () {
      await freezeAndSync(tokenRegistry, erc721Token.resourceId, [privacyNodes.A.chainId, privacyNodes.B.chainId], [
        { replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId },
        { replica: tokenRegistryOnB, chainId: privacyNodes.B.chainId },
      ]);

      // Source (B) is frozen → the whenHubActive modifier reverts on the B-side contract.
      await expect(
        erc721TokenOnB.teleportAtomic(erc721Token.userWallet.address, 0, privacyNodes.A.chainId)
      ).to.be.revertedWithCustomError(erc721TokenOnB, 'RaylsApp__HubNotActive');
    }).timeout(DEFAULT_TIMEOUT);

    it('Should unfreeze ERC721 token for participants A and B, then allow teleportAtomic @smoke', async function () {
      await freezeAndSync(tokenRegistry, erc721Token.resourceId, [privacyNodes.A.chainId, privacyNodes.B.chainId], [
        { replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId },
        { replica: tokenRegistryOnB, chainId: privacyNodes.B.chainId },
      ]);

      await unfreezeAndSync(tokenRegistry, erc721Token.resourceId, [privacyNodes.A.chainId, privacyNodes.B.chainId], [
        { replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId },
        { replica: tokenRegistryOnB, chainId: privacyNodes.B.chainId },
      ]);

      await sendTx(() => erc721TokenOnB.teleportAtomic(erc721Token.userWallet.address, 0, privacyNodes.A.chainId));

      await eventually<boolean>({
        check: async () => (await erc721Token.contract.ownerOf(0)) === erc721Token.userWallet.address,
        interval: 1000,
        attempts: 240,
        message: `Waiting for ${erc721Token.symbol}#0 owner → ${shortHex(erc721Token.userWallet.address)} on PN A (B→A)`,
        tolerateErrors: true,
      });
    }).timeout(DEFAULT_TIMEOUT);
  });

  describe('ERC1155 Token Freeze', function () {
    // ERC1155 freeze tests send from A → B. A retains tokens because only ERC1155_INITIAL_TRANSFER was sent
    // to B during setup. A's replica is checked since the call goes through A's
    // MessageSender which validates against tokenRegistryOnA.

    it('Should freeze ERC1155 token for participants A and B, then reject teleportAtomic', async function () {
      const initialBalanceA = await erc1155Token.contract.balanceOf(erc1155Token.userWallet.address, 0);
      const initialBalanceB = await erc1155TokenOnB.balanceOf(erc1155Token.userWallet.address, 0);

      // Both chainIds are synced on replica A since the call goes through A.
      await freezeAndSync(
        tokenRegistry,
        erc1155Token.resourceId,
        [privacyNodes.A.chainId, privacyNodes.B.chainId],
        [
          { replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId },
          { replica: tokenRegistryOnA, chainId: privacyNodes.B.chainId },
        ]
      );

      // Source (A) is frozen → the whenHubActive modifier reverts before MessageSender runs.
      await expect(
        erc1155Token.contract.teleportAtomic(
          erc1155Token.userWallet.address,
          0,
          25n,
          privacyNodes.B.chainId,
          hre.ethers.toUtf8Bytes('')
        )
      ).to.be.revertedWithCustomError(erc1155Token.contract, 'RaylsApp__HubNotActive');

      const finalBalanceA = await erc1155Token.contract.balanceOf(erc1155Token.userWallet.address, 0);
      const finalBalanceB = await erc1155TokenOnB.balanceOf(erc1155Token.userWallet.address, 0);
      expect(finalBalanceA).to.equal(initialBalanceA);
      expect(finalBalanceB).to.equal(initialBalanceB);
    }).timeout(DEFAULT_TIMEOUT);

    it('Should unfreeze ERC1155 token for participants A and B, then allow teleportAtomic', async function () {
      const initialBalanceA = await erc1155Token.contract.balanceOf(erc1155Token.userWallet.address, 0);
      const initialBalanceB = await erc1155TokenOnB.balanceOf(erc1155Token.userWallet.address, 0);

      await freezeAndSync(tokenRegistry, erc1155Token.resourceId, [privacyNodes.A.chainId, privacyNodes.B.chainId], [
        { replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId },
        { replica: tokenRegistryOnB, chainId: privacyNodes.B.chainId },
      ]);

      await unfreezeAndSync(tokenRegistry, erc1155Token.resourceId, [privacyNodes.A.chainId, privacyNodes.B.chainId], [
        { replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId },
        { replica: tokenRegistryOnB, chainId: privacyNodes.B.chainId },
      ]);

      await sendTx(() => erc1155TokenOnB.teleportAtomic(
        erc1155Token.userWallet.address,
        0,
        25n,
        privacyNodes.A.chainId,
        hre.ethers.toUtf8Bytes('')
      ));

      await eventually<boolean>({
        check: async () => {
          const [balA, balB] = await Promise.all([
            erc1155Token.contract.balanceOf(erc1155Token.userWallet.address, 0),
            erc1155TokenOnB.balanceOf(erc1155Token.userWallet.address, 0),
          ]);
          return balA === initialBalanceA + 25n && balB === initialBalanceB - 25n;
        },
        interval: 1000,
        attempts: 240,
        message: `Waiting for ${erc1155Token.symbol}#0 unfreeze: A → ${initialBalanceA + 25n}, B → ${initialBalanceB - 25n}`,
      });
    }).timeout(DEFAULT_TIMEOUT);
  });

  // ---------------------------------------------------------------------------
  // Single participant frozen — each test freezes exactly one chain.
  // ---------------------------------------------------------------------------

  describe('E2E Tests: Freeze Tokens - single participant', function () {
    describe('ERC20 Token Freeze', function () {
      it('Should freeze ERC20 token for source (A only), then reject teleportAtomic @smoke', async function () {
        const initialBalanceA = await erc20Token.contract.balanceOf(erc20Token.userWallet.address);
        const initialBalanceB = await erc20TokenOnB.balanceOf(erc20Token.userWallet.address);

        await freezeAndSync(
          tokenRegistry,
          erc20Token.resourceId,
          [privacyNodes.A.chainId],
          [{ replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId }]
        );

        // Source (A) frozen → whenHubActive reverts on the sending contract.
        await expect(
          erc20Token.contract.teleportAtomic(erc20Token.userWallet.address, 50n, privacyNodes.B.chainId)
        ).to.be.revertedWithCustomError(erc20Token.contract, 'RaylsApp__HubNotActive');

        const finalBalanceA = await erc20Token.contract.balanceOf(erc20Token.userWallet.address);
        const finalBalanceB = await erc20TokenOnB.balanceOf(erc20Token.userWallet.address);
        expect(finalBalanceA).to.equal(initialBalanceA);
        expect(finalBalanceB).to.equal(initialBalanceB);
      }).timeout(DEFAULT_TIMEOUT);

      it('Should freeze ERC20 token for destination (B only), then reject teleportAtomic', async function () {
        const initialBalanceA = await erc20Token.contract.balanceOf(erc20Token.userWallet.address);
        const initialBalanceB = await erc20TokenOnB.balanceOf(erc20Token.userWallet.address);

        await freezeAndSync(
          tokenRegistry,
          erc20Token.resourceId,
          [privacyNodes.B.chainId],
          [{ replica: tokenRegistryOnA, chainId: privacyNodes.B.chainId }]
        );

        // Source (A) stays active; MessageSender rejects the frozen destination (B).
        await expect(
          erc20Token.contract.teleportAtomic(erc20Token.userWallet.address, 50n, privacyNodes.B.chainId)
        ).to.be.revertedWithCustomError(freezeManagerOnA, 'TokenFreezeManagerV1__TokenFrozenForParticipant');

        const finalBalanceA = await erc20Token.contract.balanceOf(erc20Token.userWallet.address);
        const finalBalanceB = await erc20TokenOnB.balanceOf(erc20Token.userWallet.address);
        expect(finalBalanceA).to.equal(initialBalanceA);
        expect(finalBalanceB).to.equal(initialBalanceB);
      }).timeout(DEFAULT_TIMEOUT);
    });

    describe('ERC721 Token Freeze', function () {
      // After the "unfreeze allows" test above, the NFT was transferred A→B→A and is now on A.
      // Single-participant tests therefore send A→B.

      it('Should freeze ERC721 token for source (A only), then reject teleportAtomic @smoke', async function () {
        await freezeAndSync(tokenRegistry, erc721Token.resourceId, [privacyNodes.A.chainId], [
          { replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId },
        ]);

        // Source (A) frozen → whenHubActive reverts on the sending contract.
        await expect(
          erc721Token.contract.teleportAtomic(erc721Token.userWallet.address, 0, privacyNodes.B.chainId)
        ).to.be.revertedWithCustomError(erc721Token.contract, 'RaylsApp__HubNotActive');
      }).timeout(DEFAULT_TIMEOUT);

      it('Should freeze ERC721 token for destination (B only), then reject teleportAtomic', async function () {
        await freezeAndSync(
          tokenRegistry,
          erc721Token.resourceId,
          [privacyNodes.B.chainId],
          [{ replica: tokenRegistryOnA, chainId: privacyNodes.B.chainId }]
        );

        // Source (A) stays active; MessageSender rejects the frozen destination (B).
        await expect(
          erc721Token.contract.teleportAtomic(erc721Token.userWallet.address, 0, privacyNodes.B.chainId)
        ).to.be.revertedWithCustomError(freezeManagerOnA, 'TokenFreezeManagerV1__TokenFrozenForParticipant');
      }).timeout(DEFAULT_TIMEOUT);
    });

    describe('ERC1155 Token Freeze', function () {
      it('Should freeze ERC1155 token for source (A only), then reject teleportAtomic @smoke', async function () {
        const initialBalanceA = await erc1155Token.contract.balanceOf(erc1155Token.userWallet.address, 0);
        const initialBalanceB = await erc1155TokenOnB.balanceOf(erc1155Token.userWallet.address, 0);

        await freezeAndSync(
          tokenRegistry,
          erc1155Token.resourceId,
          [privacyNodes.A.chainId],
          [{ replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId }]
        );

        // Source (A) frozen → whenHubActive reverts on the sending contract.
        await expect(
          erc1155Token.contract.teleportAtomic(
            erc1155Token.userWallet.address,
            0,
            25n,
            privacyNodes.B.chainId,
            hre.ethers.toUtf8Bytes('')
          )
        ).to.be.revertedWithCustomError(erc1155Token.contract, 'RaylsApp__HubNotActive');

        const finalBalanceA = await erc1155Token.contract.balanceOf(erc1155Token.userWallet.address, 0);
        const finalBalanceB = await erc1155TokenOnB.balanceOf(erc1155Token.userWallet.address, 0);
        expect(finalBalanceA).to.equal(initialBalanceA);
        expect(finalBalanceB).to.equal(initialBalanceB);
      }).timeout(DEFAULT_TIMEOUT);

      it('Should freeze ERC1155 token for destination (B only), then reject teleportAtomic', async function () {
        const initialBalanceA = await erc1155Token.contract.balanceOf(erc1155Token.userWallet.address, 0);
        const initialBalanceB = await erc1155TokenOnB.balanceOf(erc1155Token.userWallet.address, 0);

        // Wait for A's registry to know that B is frozen; A's MessageSender
        // validates dstChainId (B) via validateTokenForParticipant on A's freeze manager.
        await freezeAndSync(
          tokenRegistry,
          erc1155Token.resourceId,
          [privacyNodes.B.chainId],
          [{ replica: tokenRegistryOnA, chainId: privacyNodes.B.chainId }]
        );

        // Source (A) stays active; MessageSender rejects the frozen destination (B).
        await expect(
          erc1155Token.contract.teleportAtomic(
            erc1155Token.userWallet.address,
            0,
            25n,
            privacyNodes.B.chainId,
            hre.ethers.toUtf8Bytes('')
          )
        ).to.be.revertedWithCustomError(freezeManagerOnA, 'TokenFreezeManagerV1__TokenFrozenForParticipant');

        const finalBalanceA = await erc1155Token.contract.balanceOf(erc1155Token.userWallet.address, 0);
        const finalBalanceB = await erc1155TokenOnB.balanceOf(erc1155Token.userWallet.address, 0);
        expect(finalBalanceA).to.equal(initialBalanceA);
        expect(finalBalanceB).to.equal(initialBalanceB);
      }).timeout(DEFAULT_TIMEOUT);
    });
  });

  // ---------------------------------------------------------------------------
  // PN-layer freeze (freezeOnPrivacyNode) — freezes the token LOCALLY on PN A's registry, independent of
  // the hub. Sets privacyNodeStatus = FROZEN (no relayer sync). A teleport from the frozen source reverts
  // RaylsApp__PrivacyNodeFrozen on the token contract (whenHubActive, before MessageSender). All teleports
  // send A→B; prior blocks leave ERC721 #0 on A and A-side balances for ERC20/ERC1155.
  // ---------------------------------------------------------------------------

  describe('E2E Tests: Freeze Tokens - privacy-node layer', function () {
    afterEach(async function () {
      this.timeout(DEFAULT_TIMEOUT);
      await cleanupPnFrozenTokens(tokenRegistryOnA, [
        erc20Token.address[privacyNodes.A.chainId],
        erc721Token.address[privacyNodes.A.chainId],
        erc1155Token.address[privacyNodes.A.chainId],
      ]);
    });

    describe('ERC20 Token Freeze', function () {
      it('Should PN-freeze ERC20 on A, then reject teleportAtomic @smoke', async function () {
        const addrA = erc20Token.address[privacyNodes.A.chainId];
        const initialBalanceA = await erc20Token.contract.balanceOf(erc20Token.userWallet.address);

        await freezeOnPn(tokenRegistryOnA, addrA);

        // privacyNodeStatus == FROZEN → whenHubActive reverts before MessageSender runs.
        await expect(
          erc20Token.contract.teleportAtomic(erc20Token.userWallet.address, 50n, privacyNodes.B.chainId)
        ).to.be.revertedWithCustomError(erc20Token.contract, 'RaylsApp__PrivacyNodeFrozen');

        expect(await erc20Token.contract.balanceOf(erc20Token.userWallet.address)).to.equal(initialBalanceA);
      }).timeout(DEFAULT_TIMEOUT);

      it('Should PN-unfreeze ERC20 on A, then allow teleportAtomic', async function () {
        const addrA = erc20Token.address[privacyNodes.A.chainId];
        const initialBalanceA = await erc20Token.contract.balanceOf(erc20Token.userWallet.address);
        const initialBalanceB = await erc20TokenOnB.balanceOf(erc20Token.userWallet.address);

        await freezeOnPn(tokenRegistryOnA, addrA);
        await unfreezeOnPn(tokenRegistryOnA, addrA);

        await sendTx(() => erc20Token.contract.teleportAtomic(erc20Token.userWallet.address, 50n, privacyNodes.B.chainId));

        await eventually<boolean>({
          check: async () => {
            const [balA, balB] = await Promise.all([
              erc20Token.contract.balanceOf(erc20Token.userWallet.address),
              erc20TokenOnB.balanceOf(erc20Token.userWallet.address),
            ]);
            return balA === initialBalanceA - 50n && balB === initialBalanceB + 50n;
          },
          interval: 1000,
          attempts: 240,
          message: `Waiting for ${erc20Token.symbol} PN-unfreeze: A → ${initialBalanceA - 50n}, B → ${initialBalanceB + 50n}`,
        });
      }).timeout(DEFAULT_TIMEOUT);
    });

    describe('ERC721 Token Freeze', function () {
      it('Should PN-freeze ERC721 on A, then reject teleportAtomic', async function () {
        const addrA = erc721Token.address[privacyNodes.A.chainId];

        await freezeOnPn(tokenRegistryOnA, addrA);

        // privacyNodeStatus == FROZEN → whenHubActive reverts on the sending contract.
        await expect(
          erc721Token.contract.teleportAtomic(erc721Token.userWallet.address, 0, privacyNodes.B.chainId)
        ).to.be.revertedWithCustomError(erc721Token.contract, 'RaylsApp__PrivacyNodeFrozen');

        expect(await erc721Token.contract.ownerOf(0)).to.equal(erc721Token.userWallet.address);
      }).timeout(DEFAULT_TIMEOUT);

      it('Should PN-unfreeze ERC721 on A, then allow teleportAtomic', async function () {
        const addrA = erc721Token.address[privacyNodes.A.chainId];

        await freezeOnPn(tokenRegistryOnA, addrA);
        await unfreezeOnPn(tokenRegistryOnA, addrA);

        await sendTx(() => erc721Token.contract.teleportAtomic(erc721Token.userWallet.address, 0, privacyNodes.B.chainId));

        await eventually<boolean>({
          check: async () => (await erc721TokenOnB.ownerOf(0)) === erc721Token.userWallet.address,
          interval: 1000,
          attempts: 240,
          message: `Waiting for ${erc721Token.symbol}#0 owner → ${shortHex(erc721Token.userWallet.address)} on PN B (A→B)`,
          tolerateErrors: true,
        });
      }).timeout(DEFAULT_TIMEOUT);
    });

    describe('ERC1155 Token Freeze', function () {
      it('Should PN-freeze ERC1155 on A, then reject teleportAtomic', async function () {
        const addrA = erc1155Token.address[privacyNodes.A.chainId];
        const initialBalanceA = await erc1155Token.contract.balanceOf(erc1155Token.userWallet.address, 0);

        await freezeOnPn(tokenRegistryOnA, addrA);

        // privacyNodeStatus == FROZEN → whenHubActive reverts on the sending contract.
        await expect(
          erc1155Token.contract.teleportAtomic(
            erc1155Token.userWallet.address,
            0,
            25n,
            privacyNodes.B.chainId,
            hre.ethers.toUtf8Bytes('')
          )
        ).to.be.revertedWithCustomError(erc1155Token.contract, 'RaylsApp__PrivacyNodeFrozen');

        expect(await erc1155Token.contract.balanceOf(erc1155Token.userWallet.address, 0)).to.equal(initialBalanceA);
      }).timeout(DEFAULT_TIMEOUT);

      it('Should PN-unfreeze ERC1155 on A, then allow teleportAtomic', async function () {
        const addrA = erc1155Token.address[privacyNodes.A.chainId];
        const initialBalanceA = await erc1155Token.contract.balanceOf(erc1155Token.userWallet.address, 0);
        const initialBalanceB = await erc1155TokenOnB.balanceOf(erc1155Token.userWallet.address, 0);

        await freezeOnPn(tokenRegistryOnA, addrA);
        await unfreezeOnPn(tokenRegistryOnA, addrA);

        await sendTx(() => erc1155Token.contract.teleportAtomic(
          erc1155Token.userWallet.address,
          0,
          25n,
          privacyNodes.B.chainId,
          hre.ethers.toUtf8Bytes('')
        ));

        await eventually<boolean>({
          check: async () => {
            const [balA, balB] = await Promise.all([
              erc1155Token.contract.balanceOf(erc1155Token.userWallet.address, 0),
              erc1155TokenOnB.balanceOf(erc1155Token.userWallet.address, 0),
            ]);
            return balA === initialBalanceA - 25n && balB === initialBalanceB + 25n;
          },
          interval: 1000,
          attempts: 240,
          message: `Waiting for ${erc1155Token.symbol}#0 PN-unfreeze: A → ${initialBalanceA - 25n}, B → ${initialBalanceB + 25n}`,
        });
      }).timeout(DEFAULT_TIMEOUT);
    });
  });
}).timeout(DEFAULT_TIMEOUT);
