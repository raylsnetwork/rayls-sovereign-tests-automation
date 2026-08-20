import { expect } from 'chai';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
  TokenRegistryV1,
  PNTokenRegistryV1,
} from '../../../../typechain-types';
import { DEFAULT_TIMEOUT } from '../../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { cleanEnygmaDb } from '../../../../src/utils/db-utils';
import { createRandomWallet, eventually, sendTx } from '../../../../src/utils/common';
import { shortHex } from '../../../../src/utils/formatters';
import {
  cleanupFrozenTokens,
  cleanupPnFrozenTokens,
  freezeAndSync,
  freezeOnPn,
  unfreezeAndSync,
  unfreezeOnPn,
} from '../../../test-utils/freeze-helpers';


describe('E2E Tests: Enygma Transfer Freeze Functionality', function () {
  const MINT_AMOUNT = 1000n;
  const TRANSFER_AMOUNT = 100n;

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let enygmaOnPNA: EnygmaWrapper<ProductionEnygmaToken>;
  let enygmaOnPNB: ProductionEnygmaToken;
  let tokenRegistry: TokenRegistryV1;
  let tokenRegistryOnA: PNTokenRegistryV1;
  let tokenRegistryOnB: PNTokenRegistryV1;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    tokenRegistry = await privateHub.getTokenRegistryAsCompliance();
    // getFrozenTokenForParticipant is `restricted` — connect an ADMIN signer so the cleanup poll can read it.
    tokenRegistryOnA = await privacyNodes.A.getPnTokenRegistry(privacyNodes.A.adminWallet);
    tokenRegistryOnB = await privacyNodes.B.getPnTokenRegistry(privacyNodes.B.adminWallet);

    await cleanEnygmaDb();

    enygmaOnPNA = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
    // New token-registry flow: node-factory deploy as user (seeded codehash clears the
    // programmability gate), then PN-authorize + hub-activate.
    await enygmaOnPNA.deployViaFactory();
    await enygmaOnPNA.activateOnPn();
    await enygmaOnPNA.activateOnHub(privateHub);
    await enygmaOnPNA.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: enygmaOnPNA.userWallet.address });

    // Initial transfer to set up token replica on PN B
    const receipt = await sendTx(() => enygmaOnPNA.contract.crossTransfer(
      [enygmaOnPNA.userWallet.address],
      [TRANSFER_AMOUNT],
      [privacyNodes.B.chainId],
      [[]]
    ));
    expect(receipt?.status).to.be.equal(1);

    enygmaOnPNB = await privacyNodes.B.setContractByResourceId<ProductionEnygmaToken>(
      ProductionEnygmaToken__factory.name,
      enygmaOnPNA.resourceId,
      enygmaOnPNA.symbol,
      enygmaOnPNA.userWallet.connect(privacyNodes.B.provider)
    );

    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const balanceB = await enygmaOnPNB.balanceOf(enygmaOnPNA.userWallet.address);
        return balanceB === BigInt(TRANSFER_AMOUNT);
      },
      interval: 1000,
      attempts: 600,
      message: `Waiting for ${enygmaOnPNA.symbol} balance B → ${TRANSFER_AMOUNT} for ${shortHex(enygmaOnPNA.userWallet.address)} (setup A→B)`,
      tolerateErrors: true,
    });

    const balanceA = await enygmaOnPNA.contract.balanceOf(enygmaOnPNA.userWallet.address);
    const balanceB = await enygmaOnPNB.balanceOf(enygmaOnPNA.userWallet.address);
    expect(balanceA).to.be.equal(BigInt(MINT_AMOUNT - TRANSFER_AMOUNT));
    expect(balanceB).to.be.equal(BigInt(TRANSFER_AMOUNT));
  });

  afterEach(async function () {
    await cleanupFrozenTokens(tokenRegistry, [tokenRegistryOnA, tokenRegistryOnB], [
      { resourceId: enygmaOnPNA.resourceId, chainIds: [privacyNodes.A.chainId, privacyNodes.B.chainId] },
    ]);
  });

  // Note: source+destination are frozen here, so the local `hubStatus` flips to FROZEN and the token's
  // `whenHubActive` guard (RaylsApp._requireHubActive) reverts RaylsApp__HubNotActive before execution
  // ever reaches EnygmaPNEvents. (A destination-only freeze would instead surface
  // TokenFreezeManagerV1__TokenFrozenForParticipant inside EnygmaPNEvents.)

  it('Should freeze Enygma token and verify cross transfers are blocked @smoke', async function () {
    const initialBalanceA = await enygmaOnPNA.contract.balanceOf(enygmaOnPNA.userWallet.address);
    const initialBalanceB = await enygmaOnPNB.balanceOf(enygmaOnPNA.userWallet.address);

    // Enygma routes through Node A's MessageSender — replicaOnA validates both src (A) and dst (B) chainIds.
    await freezeAndSync(tokenRegistry, enygmaOnPNA.resourceId, [privacyNodes.A.chainId, privacyNodes.B.chainId], [
      { replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId },
      { replica: tokenRegistryOnA, chainId: privacyNodes.B.chainId },
    ]);

    await expect(
      enygmaOnPNA.contract.crossTransfer([enygmaOnPNA.userWallet.address], [50], [privacyNodes.B.chainId], [[]])
    ).to.be.revertedWithCustomError(enygmaOnPNA.contract, 'RaylsApp__HubNotActive');

    const finalBalanceA = await enygmaOnPNA.contract.balanceOf(enygmaOnPNA.userWallet.address);
    const finalBalanceB = await enygmaOnPNB.balanceOf(enygmaOnPNA.userWallet.address);
    expect(finalBalanceA).to.equal(initialBalanceA);
    expect(finalBalanceB).to.equal(initialBalanceB);
  }).timeout(DEFAULT_TIMEOUT);

  it('Should freeze Enygma token and verify linear transfers are blocked @smoke', async function () {
    const initialBalanceA = await enygmaOnPNA.contract.balanceOf(enygmaOnPNA.userWallet.address);
    const initialBalanceB = await enygmaOnPNB.balanceOf(enygmaOnPNA.userWallet.address);

    // Enygma routes through Node A's MessageSender — replicaOnA validates both src (A) and dst (B) chainIds.
    await freezeAndSync(tokenRegistry, enygmaOnPNA.resourceId, [privacyNodes.A.chainId, privacyNodes.B.chainId], [
      { replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId },
      { replica: tokenRegistryOnA, chainId: privacyNodes.B.chainId },
    ]);

    await expect(
      enygmaOnPNA.contract.linearCrossTransfer(
        enygmaOnPNA.userWallet.address,
        50,
        privacyNodes.B.chainId,
        []
      )
    ).to.be.revertedWithCustomError(enygmaOnPNA.contract, 'RaylsApp__HubNotActive');

    const finalBalanceA = await enygmaOnPNA.contract.balanceOf(enygmaOnPNA.userWallet.address);
    const finalBalanceB = await enygmaOnPNB.balanceOf(enygmaOnPNA.userWallet.address);
    expect(finalBalanceA).to.equal(initialBalanceA);
    expect(finalBalanceB).to.equal(initialBalanceB);
  }).timeout(DEFAULT_TIMEOUT);

  it('Should unfreeze Enygma token and verify transfers resume @smoke', async function () {
    // Enygma routes through Node A's MessageSender — replicaOnA validates both src (A) and dst (B) chainIds.
    await freezeAndSync(tokenRegistry, enygmaOnPNA.resourceId, [privacyNodes.A.chainId, privacyNodes.B.chainId], [
      { replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId },
      { replica: tokenRegistryOnA, chainId: privacyNodes.B.chainId },
    ]);

    await unfreezeAndSync(
      tokenRegistry,
      enygmaOnPNA.resourceId,
      [privacyNodes.A.chainId, privacyNodes.B.chainId],
      [
        { replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId },
        { replica: tokenRegistryOnA, chainId: privacyNodes.B.chainId },
      ]
    );

    const initialBalanceA = await enygmaOnPNA.contract.balanceOf(enygmaOnPNA.userWallet.address);
    const initialBalanceB = await enygmaOnPNB.balanceOf(enygmaOnPNA.userWallet.address);

    await sendTx(() => enygmaOnPNA.contract.crossTransfer(
      [enygmaOnPNA.userWallet.address],
      [50],
      [privacyNodes.B.chainId],
      [[]]
    ));

    await eventually<boolean>({
      check: async (): Promise<boolean> => {
        const balanceA = await enygmaOnPNA.contract.balanceOf(enygmaOnPNA.userWallet.address);
        const balanceB = await enygmaOnPNB.balanceOf(enygmaOnPNA.userWallet.address);
        return balanceA === initialBalanceA - BigInt(50) && balanceB === initialBalanceB + BigInt(50);
      },
      interval: 1000,
      attempts: 300,
      message: `Waiting for ${enygmaOnPNA.symbol} unfreeze: A → ${initialBalanceA - 50n}, B → ${initialBalanceB + 50n}`,
    });

    const finalBalanceA = await enygmaOnPNA.contract.balanceOf(enygmaOnPNA.userWallet.address);
    const finalBalanceB = await enygmaOnPNB.balanceOf(enygmaOnPNA.userWallet.address);
    expect(finalBalanceA).to.be.equal(initialBalanceA - BigInt(50));
    expect(finalBalanceB).to.be.equal(initialBalanceB + BigInt(50));
  }).timeout(DEFAULT_TIMEOUT);

  it('Should verify unauthorized freeze attempts fail @smoke', async function () {
    const unauthorizedSigner = createRandomWallet(privateHub.provider);
    const unauthorizedTokenRegistry = tokenRegistry.connect(unauthorizedSigner);

    const unauthorizedFreezePromise = unauthorizedTokenRegistry.freezeToken(enygmaOnPNA.resourceId, [
      privacyNodes.A.chainId,
    ]);

    await expect(unauthorizedFreezePromise).to.be.reverted;

    const isFrozenA = await tokenRegistry.isTokenFrozenForParticipant(enygmaOnPNA.resourceId, privacyNodes.A.chainId);
    const isFrozenB = await tokenRegistry.isTokenFrozenForParticipant(enygmaOnPNA.resourceId, privacyNodes.B.chainId);
    expect(isFrozenA).to.be.false;
    expect(isFrozenB).to.be.false;
  }).timeout(DEFAULT_TIMEOUT);

  it('Should test mint and burn operations when token is frozen', async function () {
    await freezeAndSync(
      tokenRegistry,
      enygmaOnPNA.resourceId,
      [privacyNodes.A.chainId, privacyNodes.B.chainId],
      [
        { replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId },
        { replica: tokenRegistryOnB, chainId: privacyNodes.B.chainId },
      ]
    );

    // mint/burn are owner-gated; the FACTORY-mode instance owner is the registrant EOA (userWallet),
    // which `enygmaOnPNA.contract` is already signed by.
    const mintReceipt = await sendTx(() => enygmaOnPNA.contract.mint(enygmaOnPNA.userWallet.address, 100));
    expect(mintReceipt?.status).to.be.equal(1);

    const burnReceipt = await sendTx(() => enygmaOnPNA.contract.burn(enygmaOnPNA.userWallet.address, 50));
    expect(burnReceipt?.status).to.be.equal(1);
  }).timeout(DEFAULT_TIMEOUT);

  it('Should revert crossTransferFrom immediately when token is frozen', async function () {
    const spenderSignerA = createRandomWallet(privacyNodes.A.provider);

    const initialBalanceA_Owner = await enygmaOnPNA.contract.balanceOf(enygmaOnPNA.userWallet.address);
    const initialBalanceA_Spender = await enygmaOnPNA.contract.balanceOf(spenderSignerA.address);
    const initialBalanceB_Owner = await enygmaOnPNB.balanceOf(enygmaOnPNA.userWallet.address);

    await sendTx(() => enygmaOnPNA.contract.connect(enygmaOnPNA.userWallet).approve(spenderSignerA.address, 20));
    const initialAllowance = await enygmaOnPNA.contract.allowance(enygmaOnPNA.userWallet.address, spenderSignerA.address);
    expect(initialAllowance).to.equal(20);

    // Enygma routes through Node A's MessageSender — replicaOnA validates both src (A) and dst (B) chainIds.
    await freezeAndSync(tokenRegistry, enygmaOnPNA.resourceId, [privacyNodes.A.chainId, privacyNodes.B.chainId], [
      { replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId },
      { replica: tokenRegistryOnA, chainId: privacyNodes.B.chainId },
    ]);

    // Source frozen → token's whenHubActive guard reverts RaylsApp__HubNotActive before crossTransferFrom runs
    const enygmaOnPNASignedBySpender = enygmaOnPNA.contract.connect(spenderSignerA);
    await expect(
      enygmaOnPNASignedBySpender.crossTransferFrom(
        enygmaOnPNA.userWallet.address,
        [enygmaOnPNA.userWallet.address],
        [10],
        [privacyNodes.B.chainId],
        [[]]
      )
    ).to.be.revertedWithCustomError(enygmaOnPNA.contract, 'RaylsApp__HubNotActive');

    const finalBalanceA_Owner = await enygmaOnPNA.contract.balanceOf(enygmaOnPNA.userWallet.address);
    const finalBalanceA_Spender = await enygmaOnPNA.contract.balanceOf(spenderSignerA.address);
    const finalBalanceB_Owner = await enygmaOnPNB.balanceOf(enygmaOnPNA.userWallet.address);
    const finalAllowance = await enygmaOnPNA.contract.allowance(enygmaOnPNA.userWallet.address, spenderSignerA.address);


    expect(finalBalanceA_Owner).to.equal(initialBalanceA_Owner, 'Owner balance should not change');
    expect(finalBalanceA_Spender).to.equal(initialBalanceA_Spender, 'Spender balance should not change');
    expect(finalBalanceB_Owner).to.equal(initialBalanceB_Owner, 'Destination balance should not change');
    expect(finalAllowance).to.equal(initialAllowance, 'Allowance should not be consumed on revert');
  }).timeout(DEFAULT_TIMEOUT);

  it('Should revert linearCrossTransferFrom immediately when token is frozen', async function () {
    const spenderSignerA = createRandomWallet(privacyNodes.A.provider);

    const initialBalanceA_Owner = await enygmaOnPNA.contract.balanceOf(enygmaOnPNA.userWallet.address);
    const initialBalanceA_Spender = await enygmaOnPNA.contract.balanceOf(spenderSignerA.address);
    const initialBalanceB_Owner = await enygmaOnPNB.balanceOf(enygmaOnPNA.userWallet.address);

    await sendTx(() => enygmaOnPNA.contract.connect(enygmaOnPNA.userWallet).approve(spenderSignerA.address, 15));
    const initialAllowance = await enygmaOnPNA.contract.allowance(enygmaOnPNA.userWallet.address, spenderSignerA.address);
    expect(initialAllowance).to.equal(15);

    // Enygma routes through Node A's MessageSender — replicaOnA validates both src (A) and dst (B) chainIds.
    await freezeAndSync(tokenRegistry, enygmaOnPNA.resourceId, [privacyNodes.A.chainId, privacyNodes.B.chainId], [
      { replica: tokenRegistryOnA, chainId: privacyNodes.A.chainId },
      { replica: tokenRegistryOnA, chainId: privacyNodes.B.chainId },
    ]);

    const enygmaOnPNASignedBySpender = enygmaOnPNA.contract.connect(spenderSignerA);
    await expect(
      enygmaOnPNASignedBySpender.linearCrossTransferFrom(
        enygmaOnPNA.userWallet.address,
        enygmaOnPNA.userWallet.address,
        10,
        privacyNodes.B.chainId,
        []
      )
    ).to.be.revertedWithCustomError(enygmaOnPNA.contract, 'RaylsApp__HubNotActive');

    const finalBalanceA_Owner = await enygmaOnPNA.contract.balanceOf(enygmaOnPNA.userWallet.address);
    const finalBalanceA_Spender = await enygmaOnPNA.contract.balanceOf(spenderSignerA.address);
    const finalBalanceB_Owner = await enygmaOnPNB.balanceOf(enygmaOnPNA.userWallet.address);
    const finalAllowance = await enygmaOnPNA.contract.allowance(enygmaOnPNA.userWallet.address, spenderSignerA.address);

    expect(finalBalanceA_Owner).to.equal(initialBalanceA_Owner, 'Owner balance should not change');
    expect(finalBalanceA_Spender).to.equal(initialBalanceA_Spender, 'Spender balance should not change');
    expect(finalBalanceB_Owner).to.equal(initialBalanceB_Owner, 'Destination balance should not change');
    expect(finalAllowance).to.equal(initialAllowance, 'Allowance should not be consumed on revert');
  }).timeout(DEFAULT_TIMEOUT);

  // ---------------------------------------------------------------------------
  // PN-layer freeze (freezeOnPrivacyNode) — freezes the Enygma token LOCALLY on PN A's registry,
  // independent of the hub. Sets privacyNodeStatus = FROZEN (no relayer sync). Enygma crossTransfer routes
  // through the same whenHubActive → _requireHubActive path as ERC20, so a PN-frozen source reverts
  // RaylsApp__PrivacyNodeFrozen on the token contract (checked before MessageSender). All transfers send
  // A→B. PN freeze is inherently source-side/local — no destination-freeze variant applies.
  // ---------------------------------------------------------------------------

  describe('E2E Tests: Enygma Transfer Freeze - privacy-node layer', function () {
    afterEach(async function () {
      this.timeout(DEFAULT_TIMEOUT);
      await cleanupPnFrozenTokens(tokenRegistryOnA, [enygmaOnPNA.address[privacyNodes.A.chainId]]);
    });

    it('Should PN-freeze Enygma on A, then reject crossTransfer @smoke', async function () {
      const addrA = enygmaOnPNA.address[privacyNodes.A.chainId];
      const initialBalanceA = await enygmaOnPNA.contract.balanceOf(enygmaOnPNA.userWallet.address);
      const initialBalanceB = await enygmaOnPNB.balanceOf(enygmaOnPNA.userWallet.address);

      await freezeOnPn(tokenRegistryOnA, addrA);

      // privacyNodeStatus == FROZEN → whenHubActive reverts before MessageSender runs.
      await expect(
        enygmaOnPNA.contract.crossTransfer([enygmaOnPNA.userWallet.address], [50], [privacyNodes.B.chainId], [[]])
      ).to.be.revertedWithCustomError(enygmaOnPNA.contract, 'RaylsApp__PrivacyNodeFrozen');

      expect(await enygmaOnPNA.contract.balanceOf(enygmaOnPNA.userWallet.address)).to.equal(initialBalanceA);
      expect(await enygmaOnPNB.balanceOf(enygmaOnPNA.userWallet.address)).to.equal(initialBalanceB);
    }).timeout(DEFAULT_TIMEOUT);

    it('Should PN-unfreeze Enygma on A, then allow crossTransfer', async function () {
      const addrA = enygmaOnPNA.address[privacyNodes.A.chainId];

      await freezeOnPn(tokenRegistryOnA, addrA);
      await unfreezeOnPn(tokenRegistryOnA, addrA);

      const initialBalanceA = await enygmaOnPNA.contract.balanceOf(enygmaOnPNA.userWallet.address);
      const initialBalanceB = await enygmaOnPNB.balanceOf(enygmaOnPNA.userWallet.address);

      await sendTx(() => enygmaOnPNA.contract.crossTransfer(
        [enygmaOnPNA.userWallet.address],
        [50],
        [privacyNodes.B.chainId],
        [[]]
      ));

      await eventually<boolean>({
        check: async (): Promise<boolean> => {
          const balanceA = await enygmaOnPNA.contract.balanceOf(enygmaOnPNA.userWallet.address);
          const balanceB = await enygmaOnPNB.balanceOf(enygmaOnPNA.userWallet.address);
          return balanceA === initialBalanceA - 50n && balanceB === initialBalanceB + 50n;
        },
        interval: 1000,
        attempts: 300,
        message: `Waiting for ${enygmaOnPNA.symbol} PN-unfreeze: A → ${initialBalanceA - 50n}, B → ${initialBalanceB + 50n}`,
      });
    }).timeout(DEFAULT_TIMEOUT);
  });
});
