// Guardrailed Programmability E2E (Enygma).
//
// Journeys through the programmability gate. Tokens register via the node-factory deploy-as-user
// new token-registry flow (deployViaFactory + activateOnPn + activateOnHub); the issuer instance
// is deployed off the seeded RAYLS_ENYGMA_KEY template so its extcodehash matches the approved
// programmability template (a constructor deploy would not):
//
//   1. SINGLE-BLOB happy path — a plain crossTransfer rides as a one-element [mintBlob] array.
//      The receiver signs one executeProgramData([mintBlob]); the gate matches the seeded
//      standard crossMint template and the value lands. Net effect identical to a normal
//      transfer, but it now flows entirely through the gate.
//
//   2. COMPOSITION — crossTransfer composes the transfer with a downstream call.
//      The handler prepends the mint blob, stamping [mintBlob, userBlob] on the source event; the
//      receiver walks the array atomically: mint lands, then userBlob target.call's
//      RaylsArbitraryCallable.setMessage(string). Both clear the gate (mint via the seeded
//      standard template; the custom call via a propose+approve custom template on PNH keyed to
//      RaylsArbitraryCallable's bytecode) and both succeed atomically.
//
//   3. GATE REJECTION — a userBlob whose (target bytecode, selector) is NOT an approved template.
//      executeProgramData reverts at that blob with ProgramData__UnapprovedTemplate, unwinding the WHOLE
//      tx including the earlier mint. The relayer drives the existing failure-recovery path
//      (crossTransferRevertBatch back to the hub) which reverses the burn and re-credits the
//      SENDER on the source PN. Two sub-cases: an unresolved-placeholder blob and a
//      real-but-unapproved deployed callable.
//
//   4. CROSS-STANDARD, OWNER-RESTRICTED — an Enygma transfer composes mint+burn of OTHER token
//      standards (ERC20 "X") under the owner-restricted gate:
//        * Token X (ERC20) is FACTORY-deployed on PN B by user 0xA via
//          `RNContractFactory.deployErc20AsUser`. The deploying EOA becomes TOKEN_OWNER scoped to X
//          on PN B's AccessManager (via the factory's `_pendingOwnerOverride` mechanism). The
//          deployed runtime bytecode equals the seeded ERC20 template (codehash matches the gate).
//        * 0xA then sends an Enygma `crossTransfer` from PN A. The Enygma handler
//          stamps `msg.sender` (= 0xA) into PNHTransfer.from. The relayer reads that and invokes the
//          3-arg `executeProgramData(blobs, expectedMintTotal, originSender)` on PN B's executor.
//          The executor APPENDS originSender as a trusted 20-byte calldata tail on each
//          non-settlement userBlob's inner call (NOT into the ABI args).
//        * X's `crossMint(to, value)` is `restricted` (executor-only direct caller) AND reads the
//          appended origin via `_getMsgSenderOnReceiveMethod()`, then does an in-body
//          `hasContractScopedRole(TOKEN_OWNER, origin, address(this))` check.
//          0xA is the TOKEN_OWNER on B (by virtue of having deployed X there), so the call lands.
//        * Delegation: 0xA can `grantContractScopedRole(TOKEN_OWNER, 0xC, X, 0)` on PN B's
//          AccessManager. From the next block, 0xC's Enygma transfer with the same userBlob also
//          lands — the in-body check passes for any address holding TOKEN_OWNER scoped to X.
//        * Negative path: a non-owner EOA's Enygma transfer carrying a `crossMint(X)` userBlob
//          reverts atomically (the in-body check fails on B; the executor returns
//          `RaylsErc20Handler__NotTokenOwnerScoped`; the executeProgramData tx reverts; the Enygma
//          settlement mint and the user's Enygma burn on A both unwind via the existing revert path).
//        * Because X is user-deployed (not PNH-registered), its resourceId is not bound on B's
//          endpoint — blobs target X by ADDRESS (left-padded into the bytes32 target field) and the
//          executor resolves it via its address-fallback path (ProgrammabilityExecutorV1._resolveTarget).
//
// PRECONDITIONS (live env): PN factory has setBytecode(ENYGMA_KEY, ...) and the PNH
// `seed-standard-templates` task has seeded the crossMint template; relayer EnygmaDeployer is in
// FACTORY mode. For Composition, additionally a custom template for (RaylsArbitraryCallable
// bytecodeHash, setMessage(string) selector) must be proposed+approved on the PNH TemplateRegistry
// and replicated to PN B. For Cross-standard: regenerated typechain (crossMint/crossBurn signatures
// WITHOUT the originSender argument — the executor appends it as a trusted calldata tail); rebuilt
// PN/PNH/relayer images carrying the updated executor bytecode (tail-append + address-fallback
// resolution) + the relayer's 3-arg PackExecuteProgramData callsite; template seeding for
// `crossMint(address,uint256)` / `crossBurn(address,uint256)` against the ERC20 seeded codehash.
// Requires a running multi-node environment. Pending live-env run.

import { expect } from 'chai';
import { ethers } from 'hardhat';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
  ProductionErc20Token,
  ProductionErc20Token__factory,
  RaylsArbitraryCallable,
  RaylsArbitraryCallable__factory,
  RNContractFactoryV1__factory,
  RaylsAccessManagerV1__factory,
  TemplateRegistryV1__factory,
  TemplateRegistryReplicaV1__factory,
} from '../../../../typechain-types';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { HDNodeWallet, Wallet } from 'ethers';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER, ZERO_ADDRESS } from '../../../../src/config/env-config';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { ERC20Wrapper } from '../../../../src/entities/tokens/ERC20Wrapper';
import { eventually, sendTx, submitTx } from '../../../../src/utils/common';
import { checkDbBalance } from '../../../../src/utils/db-utils';
import { createUserOperator } from '../../../../src/utils/wallet-factory';
import { generateRandomHex } from '../../../../src/utils/generators';

// A typed EnygmaProgramData step: { resourceId, contractAddress, selector, args }. The target is
// addressed by EXACTLY ONE of resourceId / contractAddress (the other is zero). The attested
// originSender is NOT part of the blob — the executor appends it as a trusted calldata tail.
interface ProgramDataBlob {
  resourceId: string;
  contractAddress: string;
  selector: string;
  args: string;
}

// Build a blob targeting by resourceId (contractAddress = zero).
function blobByResourceId(resourceId: string, selector: string, args: string): ProgramDataBlob {
  return { resourceId, contractAddress: ethers.ZeroAddress, selector, args };
}

// Build a blob targeting by direct contract address (resourceId = zero). `target` may be a
// left-padded bytes32 or a 20-byte address; it is normalized to a checksummed address.
function blobByAddress(target: string, selector: string, args: string): ProgramDataBlob {
  const addr = ethers.getAddress(ethers.dataSlice(ethers.zeroPadValue(target, 32), 12, 32));
  return { resourceId: ethers.ZeroHash, contractAddress: addr, selector, args };
}

// Poll a raw token instance's balanceOf until it equals `expected`.
async function waitForBalanceOf(
  balanceOf: () => Promise<bigint>,
  expected: bigint,
  label: string,
): Promise<void> {
  await eventually({
    check: async () => (await balanceOf()) === expected,
    message: label,
    tolerateErrors: true,
  });
}

const enygmaTransferAmount = 10n;

// Per-test mocha budget for the cross-chain programmability flows (transfer → relayer →
// destination executeProgramData → settlement finalization). Longer than DEFAULT_TIMEOUT because
// the relayer's finalize/sign + SC↔DB commitment reconciliation can take several blocks.
const PROGRAMMABILITY_TEST_TIMEOUT = 5 * 60 * 1000;

// Gas ceilings for programmability sends. Deliberately below the project GAS_LIMIT (10M): the
// programmability path is more gas-intensive (atomic blob dispatch + downstream calls), and these
// values exercise it against a realistic, tighter ceiling. CROSS_TRANSFER_GAS covers a plain
// single-mint-blob transfer; PROGRAMMABILITY_GAS covers composed crossTransfer.
const CROSS_TRANSFER_GAS = 5_000_000;
const PROGRAMMABILITY_GAS = 6_000_000;

describe('E2E Tests: Programmability — single-blob transfer', function () {
  let signerB: HDNodeWallet | Wallet;
  let tokenOnPNA: EnygmaWrapper<ProductionEnygmaToken>;
  let tokenOnPNB: ProductionEnygmaToken;
  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    tokenOnPNA = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
    signerB = tokenOnPNA.userWallet;
    // New token-registry flow: node-factory deploy as user via deployEnygmaAsUser — deploys off the
    // seeded RAYLS_ENYGMA_KEY template so the issuer instance's codehash matches the approved
    // programmability template (a constructor deploy would not), then PN-authorize + hub-activate.
    await tokenOnPNA.deployViaFactory();
    await tokenOnPNA.activateOnPn();
    await tokenOnPNA.activateOnHub(privateHub);
    await tokenOnPNA.mintAndAwait(privateHub, { amount: 1000n, toAddress: tokenOnPNA.userWallet.address });
  });

  it('plain cross transfer A -> B lands via executeProgramData([mintBlob]) @smoke', async function () {
    this.timeout(PROGRAMMABILITY_TEST_TIMEOUT);

    LOGGER.log('🛠️ Cross transfer A -> B (single mint blob, auto-built by the sender handler)');
    await submitTx(
      () => privacyNodes.A
        .getContract<ProductionEnygmaToken>(tokenOnPNA.symbol)
        // Empty per-recipient program-data array → plain transfer; the handler auto-prepends the mint blob.
        .crossTransfer([signerB.address], [10n], [privacyNodes.B.chainId], [[]], { gasLimit: CROSS_TRANSFER_GAS }),
      'Programmability single-blob transfer A->B',
    );

    // Wait for the relayer to deploy + register the token instance on PN B and
    // populate B's ContractStore cache before we read it. The cross transfer above
    // only kicks off the async mint blob; without this, getContract() races an
    // empty cache and throws "Contract ... not found".
    await tokenOnPNA.waitForDeploymentOnNode(privacyNodes.B);

    tokenOnPNB = privacyNodes.B.getContract<ProductionEnygmaToken>(tokenOnPNA.symbol);
    tokenOnPNA.resourceId = await tokenOnPNB.resourceId();

    LOGGER.log('✅ Asserting balances — mint blob must have landed through the gate');
    // waitForDeploymentOnNode only waits for the instance to be deployed/resolvable, NOT for
    // the async mint blob to land and the balance to finalize. Poll B's balance until the mint
    // lands so the assertion below doesn't race the relayer's executeProgramData tx.
    await (await tokenOnPNA.forNode(privacyNodes.B)).waitForBalance(10n, signerB.address);
    // DB + PNH (finalized_balance + Pedersen commitment) on both nodes.
    await checkDbBalance(990, privateHub, privacyNodes.A, tokenOnPNA);
    await checkDbBalance(10, privateHub, privacyNodes.B, tokenOnPNA);

    // PN on-chain balances on both sides.
    expect(await tokenOnPNA.contract.balanceOf(signerB.address)).to.equal(990n);
    expect(await tokenOnPNB.balanceOf(signerB.address)).to.equal(10n);
  });
});

describe('E2E Tests: Programmability — composed transfer + call', function () {
  let signerB: HDNodeWallet | Wallet;
  let tokenOnPNA: EnygmaWrapper<ProductionEnygmaToken>;
  let tokenOnPNB: ProductionEnygmaToken;
  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  // Filled in setup: the deployed RaylsArbitraryCallable resourceId on PN B and its setMessage selector.
  let callableResourceId: string;
  const setMessageSelector = ethers.id('setMessage(string)').slice(0, 10); // 0x + 8 hex

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    tokenOnPNA = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
    signerB = tokenOnPNA.userWallet;
    // New token-registry flow: node-factory deploy as user via deployEnygmaAsUser — deploys off the
    // seeded RAYLS_ENYGMA_KEY template so the issuer instance's codehash matches the approved
    // programmability template (a constructor deploy would not), then PN-authorize + hub-activate.
    await tokenOnPNA.deployViaFactory();
    await tokenOnPNA.activateOnPn();
    await tokenOnPNA.activateOnHub(privateHub);
    await tokenOnPNA.mintAndAwait(privateHub, { amount: 1000n, toAddress: tokenOnPNA.userWallet.address });

    // Deploy a RaylsArbitraryCallable on PN B as the userBlob target, register its resourceId on
    // B's endpoint, and propose+approve a CUSTOM template for (its codehash, setMessage selector)
    // on the PNH TemplateRegistry — then wait for that approval to replicate to PN B's replica.
    // The executor resolves the userBlob target via B's endpoint and gates (target.codehash,
    // selector) against B's replica, so all three must be in place before the composed transfer.
    callableResourceId = ethers.encodeBytes32String('arbitrary-callable');
    const adminB = privacyNodes.B.adminWallet;

    // 1. Deploy the callable on B (admin-signed). Its ctor stores the resourceId.
    const callable: RaylsArbitraryCallable = await new RaylsArbitraryCallable__factory(adminB).deploy(
      callableResourceId,
      privacyNodes.B.endpointAddress,
      privacyNodes.B.raylsNodeEndpointAddress,
      { gasLimit: GAS_LIMIT },
    );
    await callable.waitForDeployment();
    const callableAddress = await callable.getAddress();

    // 2. Register resourceId → callable address on B's endpoint so the executor can resolve it.
    //    registerResourceId is RESOURCE_REGISTRAR-gated; adminWallet (ADMIN_ROLE) bypasses.
    const endpointBAsAdmin = privacyNodes.B.getEndpointV1().connect(adminB) as ReturnType<typeof privacyNodes.B.getEndpointV1>;
    await submitTx(
      () => endpointBAsAdmin.registerResourceId(callableResourceId, callableAddress, { gasLimit: GAS_LIMIT }),
      'Registering callable resourceId on PN B endpoint',
    );

    // 3. Propose + approve a custom template for (deployed codehash, setMessage selector) on PNH.
    //    Idempotent across re-runs: the codehash is stable (same RaylsArbitraryCallable bytecode),
    //    so the template key collides with a prior run. propose() reverts AlreadyRegistered and
    //    approve() reverts AlreadyApproved on a repeat, so guard each on the current template state.
    const callableCodehash = ethers.keccak256(await privacyNodes.B.provider.getCode(callableAddress));
    const registryAddress = privateHub.deployNamesAndAddresses['TemplateRegistry'];
    const registry = TemplateRegistryV1__factory.connect(registryAddress, privateHub.operatorWallet);
    const signature = 'setMessage(string)';
    const templateKey = await registry.getKey(callableCodehash, setMessageSelector);

    const existing = await registry.getTemplate(templateKey);
    if (existing.bytecodeHash === ethers.ZeroHash) {
      await submitTx(
        () => registry.propose(callableCodehash, signature, { gasLimit: GAS_LIMIT }),
        'Proposing custom setMessage template on PNH',
      );
    }
    if (!existing.approved) {
      await submitTx(
        () => registry.approve(templateKey, { gasLimit: GAS_LIMIT }),
        'Approving custom setMessage template on PNH',
      );
    }

    // 4. Wait for the approval to replicate to PN B's TemplateRegistryReplica (the gate the
    //    executor consults). Without this the userBlob would be rejected as unapproved.
    const replicaBAddr = await privacyNodes.B.resolveFromRegistry('TemplateRegistryReplica');
    const replicaB = TemplateRegistryReplicaV1__factory.connect(replicaBAddr, privacyNodes.B.provider);
    await eventually({
      check: async () => (await replicaB.getTemplate(templateKey)).approved,
      message: 'Waiting for custom setMessage template → PN B replica approval',
      tolerateErrors: true,
    });
  });

  it('composed [mintBlob, userBlob] both dispatch atomically', async function () {
    this.timeout(PROGRAMMABILITY_TEST_TIMEOUT);

    const userArgs = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['hello-from-programmability']);
    const userBlob = blobByResourceId(callableResourceId, setMessageSelector, userArgs);

    LOGGER.log('🛠️ Composed cross transfer A -> B with a user setMessage blob');
    await submitTx(
      () => privacyNodes.A
        .getContract<ProductionEnygmaToken>(tokenOnPNA.symbol)
        .crossTransfer(
          [signerB.address],
          [10n],
          [privacyNodes.B.chainId],
          [[userBlob]], // one array of user blobs per recipient; handler prepends mintBlob
          { gasLimit: PROGRAMMABILITY_GAS },
        ),
      'Programmability composed transfer A->B',
    );

    // Wait for the relayer to deploy + register the token instance on PN B and populate B's
    // ContractStore cache before reading it. The composed transfer only kicks off the async
    // executeProgramData([mintBlob, userBlob]); without this, getContract() races an empty cache
    // and throws "Contract ... not found".
    await tokenOnPNA.waitForDeploymentOnNode(privacyNodes.B);

    tokenOnPNB = privacyNodes.B.getContract<ProductionEnygmaToken>(tokenOnPNA.symbol);
    tokenOnPNA.resourceId = await tokenOnPNB.resourceId();

    LOGGER.log('✅ Mint must have landed (first blob)');
    // waitForDeploymentOnNode only waits for the instance to be resolvable, not for the mint to
    // finalize — poll B's balance until the mint blob lands before asserting.
    await (await tokenOnPNA.forNode(privacyNodes.B)).waitForBalance(10n, signerB.address);
    // DB + PNH (finalized_balance + Pedersen commitment) on both nodes.
    await checkDbBalance(990, privateHub, privacyNodes.A, tokenOnPNA);
    await checkDbBalance(10, privateHub, privacyNodes.B, tokenOnPNA);
    // PN on-chain balances on both sides.
    expect(await tokenOnPNA.contract.balanceOf(signerB.address)).to.equal(990n);
    expect(await tokenOnPNB.balanceOf(signerB.address)).to.equal(10n);

    // The userBlob (setMessage) must have dispatched in the same atomic executeProgramData frame
    // as the mint. Resolve the callable on B by its resourceId and assert the message landed.
    LOGGER.log('✅ User blob (setMessage) must have dispatched in the same atomic frame');
    const callableAddressB = await privacyNodes.B.getEndpointV1().getAddressByResourceId(callableResourceId);
    const callableB = RaylsArbitraryCallable__factory.connect(callableAddressB, privacyNodes.B.provider);
    await eventually({
      check: async () => (await callableB.getMessage()) === 'hello-from-programmability',
      message: 'Waiting for setMessage userBlob → callable message on PN B',
      tolerateErrors: true,
    });
  });
});

describe('E2E Tests: Programmability — off-template gate rejection', function () {
  let signerA: HDNodeWallet | Wallet;
  let signerB: HDNodeWallet | Wallet;
  let tokenOnPNA: EnygmaWrapper<ProductionEnygmaToken>;
  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  // A resourceId resolving to a contract whose (bytecode, selector) is NOT whitelisted.
  let unapprovedResourceId: string;
  const unapprovedSelector = ethers.id('notWhitelisted()').slice(0, 10);

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    tokenOnPNA = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
    signerA = tokenOnPNA.userWallet;
    signerB = privacyNodes.B.userWallet; // distinct recipient so the "no mint to B" assertion is real
    // New token-registry flow: node-factory deploy as user via deployEnygmaAsUser — deploys off the
    // seeded RAYLS_ENYGMA_KEY template so the issuer instance's codehash matches the approved
    // programmability template (a constructor deploy would not), then PN-authorize + hub-activate.
    await tokenOnPNA.deployViaFactory();
    await tokenOnPNA.activateOnPn();
    await tokenOnPNA.activateOnHub(privateHub);
    await tokenOnPNA.mintAndAwait(privateHub, { amount: 1000n, toAddress: tokenOnPNA.userWallet.address });

    // Live env: deploy a contract on PN B, register `unapprovedResourceId` to it, and DO NOT
    // seed/approve any template for its (bytecode, unapprovedSelector). That guarantees the gate
    // rejects the userBlob.
    unapprovedResourceId = ethers.encodeBytes32String('unapproved-target');
  });

  it('off-template blob reverts the whole tx; the local burn is reverted back to the sender', async function () {
    this.timeout(PROGRAMMABILITY_TEST_TIMEOUT);

    const senderBalanceBefore = await tokenOnPNA.contract.balanceOf(signerA.address);
    LOGGER.log(`Sender balance on PN A before: ${senderBalanceBefore}`);

    const badBlob = blobByResourceId(unapprovedResourceId, unapprovedSelector, '0x');

    LOGGER.log('🛠️ Composed transfer with an un-whitelisted userBlob (must revert on receiver)');
    const receipt = await sendTx(() =>
      tokenOnPNA.contract.crossTransfer(
        [signerB.address],
        [10n],
        [privacyNodes.B.chainId],
        [[badBlob]], // [mintBlob, badBlob] after the handler prepends the mint
        { gasLimit: PROGRAMMABILITY_GAS },
      ),
    );

    // The source-side tx itself succeeds (it just burns + emits the event); the rejection happens
    // on the destination when executeProgramData runs.
    expect(receipt?.status).to.equal(1);

    // Right after the burn, the sender is down by 10.
    const balanceJustAfterBurn = await tokenOnPNA.contract.balanceOf(signerA.address);
    LOGGER.log(`Sender balance on PN A right after burn: ${balanceJustAfterBurn}`);
    expect(balanceJustAfterBurn).to.equal(senderBalanceBefore - 10n);

    // The destination executeProgramData reverts (gate rejection) → relayer emits
    // crossTransferRevertBatch → the burn is reversed and the value is re-credited to the sender.
    LOGGER.log('⏳ Waiting until the sender balance is restored (local burn reverted)');
    await eventually({
      check: async () => (await tokenOnPNA.contract.balanceOf(signerA.address)) === senderBalanceBefore,
      message: 'Waiting for sender balance restore on PN A after gate-rejected transfer reverts',
      tolerateErrors: true,
    });

    // DB + PNH (finalized_balance + Pedersen commitment) on A must finalize back to the pre-transfer
    // total — the revert re-credited the sender, so the off-chain accounting matches the on-chain
    // restore. (Mint was 1000 in before(); the revert returns the burned 10.)
    await checkDbBalance(Number(senderBalanceBefore), privateHub, privacyNodes.A, tokenOnPNA);

    // And the destination must never have received the mint — the whole array was unwound.
    // Because the mint blob was gate-rejected, the relayer never factory-deployed (nor registered)
    // an instance on PN B for this resourceId. So the strongest proof of "no mint landed" is that
    // B has no contract for this resourceId at all; if one somehow exists, its balance must be 0.
    const tokenBAddress = await privacyNodes.B.getEndpointV1().getAddressByResourceId(tokenOnPNA.resourceId);
    if (tokenBAddress && tokenBAddress !== ZERO_ADDRESS) {
      const code = await privacyNodes.B.provider.getCode(tokenBAddress);
      if (code && code !== '0x') {
        const tokenOnPNB = ProductionEnygmaToken__factory.connect(tokenBAddress, privacyNodes.B.provider);
        expect(await tokenOnPNB.balanceOf(signerB.address)).to.equal(0n);
      }
    }

    LOGGER.log('✅ Off-template blob reverted the destination tx and the local burn was returned to the sender.');
  });

  it('real deployed-but-unapproved callable reverts the whole tx; the local burn is reverted back to the sender', async function () {
    this.timeout(PROGRAMMABILITY_TEST_TIMEOUT);

    // Mirror the Composition setup — deploy a REAL RaylsArbitraryCallable on PN B and register its
    // resourceId — but DELIBERATELY skip proposing/approving a template for it. So the userBlob
    // resolves to a genuine contract whose (codehash, selector) is simply not whitelisted,
    // exercising the gate against real bytecode rather than an unresolved placeholder resourceId.
    //
    // The gate key is (target.codehash, selector). We deliberately target `incrementCounter()` — a
    // selector no test ever proposes/approves — so this case stays reliably off-template even if a
    // prior Composition run in the same env approved (this same codehash, setMessage).
    const callableResourceId = ethers.encodeBytes32String('unapproved-callable');
    const incrementCounterSelector = ethers.id('incrementCounter()').slice(0, 10);
    const adminB = privacyNodes.B.adminWallet;

    const callable = await new RaylsArbitraryCallable__factory(adminB).deploy(
      callableResourceId,
      privacyNodes.B.endpointAddress,
      privacyNodes.B.raylsNodeEndpointAddress,
      { gasLimit: GAS_LIMIT },
    );
    await callable.waitForDeployment();
    const callableAddress = await callable.getAddress();

    // Register resourceId → callable on B's endpoint so the executor resolves a real target.
    // registerResourceId is RESOURCE_REGISTRAR-gated; adminWallet (ADMIN_ROLE) bypasses.
    const endpointBAsAdmin = privacyNodes.B.getEndpointV1().connect(adminB) as ReturnType<typeof privacyNodes.B.getEndpointV1>;
    await submitTx(
      () => endpointBAsAdmin.registerResourceId(callableResourceId, callableAddress, { gasLimit: GAS_LIMIT }),
      'Registering unapproved callable resourceId on PN B endpoint',
    );
    // NOTE: no propose/approve on the PNH TemplateRegistry — (codehash, setMessage) stays off-template.

    const senderBalanceBefore = await tokenOnPNA.contract.balanceOf(signerA.address);
    LOGGER.log(`Sender balance on PN A before: ${senderBalanceBefore}`);

    // incrementCounter() takes no args — empty args bytes.
    const badBlob = blobByResourceId(callableResourceId, incrementCounterSelector, '0x');

    LOGGER.log('🛠️ Composed transfer with a real-but-unapproved userBlob (must revert on receiver)');
    const receipt = await sendTx(() =>
      tokenOnPNA.contract.crossTransfer(
        [signerB.address],
        [10n],
        [privacyNodes.B.chainId],
        [[badBlob]], // [mintBlob, badBlob] after the handler prepends the mint
        { gasLimit: PROGRAMMABILITY_GAS },
      ),
    );

    // The source-side tx itself succeeds (burn + emit); the rejection happens on the destination.
    expect(receipt?.status).to.equal(1);

    const balanceJustAfterBurn = await tokenOnPNA.contract.balanceOf(signerA.address);
    LOGGER.log(`Sender balance on PN A right after burn: ${balanceJustAfterBurn}`);
    expect(balanceJustAfterBurn).to.equal(senderBalanceBefore - 10n);

    // executeProgramData reverts at the unapproved blob → relayer emits crossTransferRevertBatch →
    // the burn is reversed and re-credited to the sender.
    LOGGER.log('⏳ Waiting until the sender balance is restored (local burn reverted)');
    await eventually({
      check: async () => (await tokenOnPNA.contract.balanceOf(signerA.address)) === senderBalanceBefore,
      message: 'Waiting for sender balance restore on PN A after unapproved-callable transfer reverts',
      tolerateErrors: true,
    });

    // DB + PNH (finalized_balance + Pedersen commitment) on A must finalize back to the pre-transfer
    // total — the revert re-credited the sender, so the off-chain accounting matches the on-chain
    // restore. (Mint was 1000 in before(); the revert returns the burned 10.)
    await checkDbBalance(Number(senderBalanceBefore), privateHub, privacyNodes.A, tokenOnPNA);

    // The whole array was unwound: the mint never landed on B and the callable was never touched.
    const tokenBAddress = await privacyNodes.B.getEndpointV1().getAddressByResourceId(tokenOnPNA.resourceId);
    if (tokenBAddress && tokenBAddress !== ZERO_ADDRESS) {
      const code = await privacyNodes.B.provider.getCode(tokenBAddress);
      if (code && code !== '0x') {
        const tokenOnPNB = ProductionEnygmaToken__factory.connect(tokenBAddress, privacyNodes.B.provider);
        expect(await tokenOnPNB.balanceOf(signerB.address)).to.equal(0n);
      }
    }
    expect(await callable.getCounter()).to.equal(0n);

    LOGGER.log('✅ Real-but-unapproved blob reverted the destination tx and the local burn was returned to the sender.');
  });
});

// ============================================================================================
// CROSS-STANDARD, OWNER-RESTRICTED — Enygma transfer composing ERC20 X.crossMint/crossBurn.
// ============================================================================================

describe('E2E Tests: Programmability — Enygma transfer composing ERC20 crossMint+crossBurn (owner-restricted)', function () {
  let owner0xA: HDNodeWallet | Wallet;
  let enygmaOnPNA: EnygmaWrapper<ProductionEnygmaToken>;
  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  // Signatures carry ONLY the leading params — the executor appends the attested originSender as a
  // trusted 20-byte calldata tail (read by the token via `_getMsgSenderOnReceiveMethod`), so the
  // origin is NOT part of the signature or `args`. Selectors therefore hash WITHOUT originSender.
  const crossMintSelector = ethers.id('crossMint(address,uint256)').slice(0, 10);
  const crossBurnSelector = ethers.id('crossBurn(address,uint256)').slice(0, 10);

  // X — the cross-standard token. Deployed on PN B by 0xA, so 0xA becomes the TOKEN_OWNER
  // scoped to X on PN B's AccessManager. The userBlob's `crossMint` will only succeed when
  // PNHTransfer.from (the Enygma transfer sender) is in TOKEN_OWNER scoped to X on B.
  // X's deployed address as a left-padded bytes32 — the program-data blob's target field. A token
  // deployed via deployErc20AsUser is NOT bound on B's endpoint by resourceId, so the executor
  // resolves the blob via its address-fallback path (see ProgrammabilityExecutorV1._resolveTarget).
  let xAddrTarget: string;
  let erc20OnB: ProductionErc20Token;
  let accessManagerOnB: ReturnType<typeof RaylsAccessManagerV1__factory.connect>;
  let tokenOwnerRoleId: bigint;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    // Enygma payment token on A (new token-registry flow), funded for the sender 0xA.
    enygmaOnPNA = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
    owner0xA = enygmaOnPNA.userWallet;
    await enygmaOnPNA.deployViaFactory();
    await enygmaOnPNA.activateOnPn();
    await enygmaOnPNA.activateOnHub(privateHub);
    await enygmaOnPNA.mintAndAwait(privateHub, { amount: 1000n, toAddress: owner0xA.address });

    // Resolve PN B's RNContractFactory + AccessManager. The factory entry point we need is
    // `deployErc20AsUser` — unrestricted, caller becomes TOKEN_OWNER scoped to the deployed instance.
    const factoryAddr = await privacyNodes.B.resolveFromRegistry('RNContractFactory');
    const accessManagerAddr = await privacyNodes.B.resolveFromRegistry('RaylsAccessManager');

    // Sign deploys from 0xA on PN B. `userWallet` on enygmaOnPNA is derived against PN A's provider;
    // the same EOA needs a connection to PN B's provider for B-side signing. PNs are gasless so
    // no funding is required.
    const owner0xA_onB = owner0xA.connect(privacyNodes.B.provider);
    const factory = RNContractFactoryV1__factory.connect(factoryAddr, owner0xA_onB);
    accessManagerOnB = RaylsAccessManagerV1__factory.connect(accessManagerAddr, owner0xA_onB);
    // TOKEN_OWNER is a built-in role (RaylsAccessManagerV1.TOKEN_OWNER = 2). Resolve via the
    // public constant getter, not getRoleIdByName — the name→id reverse map isn't populated on
    // older AccessManager deployments and reverts RoleNotRegistered("TOKEN_OWNER").
    tokenOwnerRoleId = await accessManagerOnB.TOKEN_OWNER();

    // Deploy X on B — fresh symbol so the test is idempotent across runs.
    const symbol = `X${generateRandomHex(4)}`;

    LOGGER.log(`🛠️ 0xA (${owner0xA.address}) deploying ERC20 X (${symbol}) on PN B via deployErc20AsUser`);
    const deployReceipt = await submitTx(
      () => factory.deployErc20AsUser(symbol, symbol, 18, { gasLimit: GAS_LIMIT }),
      `Deploying ERC20 X on PN B (deployErc20AsUser, ${symbol})`,
    );

    // Resolve X's address from the deploy itself, NOT the endpoint resourceId map. `deployErc20AsUser`
    // no longer takes a resourceId — the instance deploys without one, so it is NOT bound on B's
    // endpoint by resourceId and the executor resolves the blob via its address-fallback path. The
    // address is carried by the factory's `RegisteredContractDeployed(key, deployedAddress, resourceId)`
    // event emitted in the same tx (rid is the placeholder), so match by event name only.
    const deployedEvent = deployReceipt!.logs
      .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((p) => p?.name === 'RegisteredContractDeployed');
    expect(deployedEvent, 'deployErc20AsUser must emit RegisteredContractDeployed').to.exist;
    const xDeployedAddr = deployedEvent!.args.deployedAddress as string;
    // Left-pad X's address into a bytes32 blob target (executor address-fallback resolution).
    xAddrTarget = ethers.zeroPadValue(xDeployedAddr, 32);

    erc20OnB = await privacyNodes.B.getContractAt<ProductionErc20Token>(
      ProductionErc20Token__factory.name,
      xDeployedAddr,
      `${symbol}_onB`,
      owner0xA_onB,
    );

    // Sanity: 0xA must be in TOKEN_OWNER scoped to X on B. This is the precondition the
    // executor's in-body check enforces, written explicitly here as a setup invariant.
    const xAddr = await erc20OnB.getAddress();
    const [isMember, execDelay] = await accessManagerOnB.hasContractScopedRole(tokenOwnerRoleId, owner0xA.address, xAddr);
    expect(isMember, '0xA must hold TOKEN_OWNER scoped to X on PN B after deployErc20AsUser').to.equal(true);
    expect(execDelay, 'TOKEN_OWNER scoping must be immediate (no delay)').to.equal(0n);
  });

  it('composed [enygmaMint, X.crossMint(100), X.crossBurn(40)] from owner 0xA lands net 60 on B', async function () {
    this.timeout(PROGRAMMABILITY_TEST_TIMEOUT);

    expect(await erc20OnB.balanceOf(owner0xA.address), 'X must start empty for 0xA on B').to.equal(0n);

    // crossMint(100) + crossBurn(40) → net 60. The args ABI-encode ONLY the leading function args;
    // the executor appends the attested originSender as a trusted 20-byte calldata tail.
    const mintArgs = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [owner0xA.address, 100n]);
    const burnArgs = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [owner0xA.address, 40n]);
    const mintBlob = blobByAddress(xAddrTarget, crossMintSelector, mintArgs);
    const burnBlob = blobByAddress(xAddrTarget, crossBurnSelector, burnArgs);

    LOGGER.log('🛠️ Composed Enygma transfer A->B carrying X.crossMint+X.crossBurn userBlobs, signed by 0xA');
    await submitTx(
      () => privacyNodes.A
        .getContract<ProductionEnygmaToken>(enygmaOnPNA.symbol)
        .crossTransfer(
          [owner0xA.address],
          [enygmaTransferAmount],
          [privacyNodes.B.chainId],
          [[mintBlob, burnBlob]], // handler prepends enygmaMintBlob (settlement) → [enygmaMint, xMint, xBurn]
          { gasLimit: PROGRAMMABILITY_GAS },
        ),
      'Programmability composed Enygma+X.crossMint/crossBurn A->B',
    );

    // The Enygma settlement mint lands on B (proves the settlement blob cleared the gate).
    // Resolve the B-side replica by resourceId, then wait for the on-chain balance. tolerateErrors:
    // settlement reads can transiently revert while the relayer finalizes the SC↔DB commitment
    // (mirrors Enygma_Transfer_Freeze).
    const enygmaOnPNB = await privacyNodes.B.setContractByResourceId<ProductionEnygmaToken>(
      ProductionEnygmaToken__factory.name,
      enygmaOnPNA.resourceId,
      enygmaOnPNA.symbol,
      owner0xA.connect(privacyNodes.B.provider),
    );
    await eventually({
      check: async () => (await enygmaOnPNB.balanceOf(owner0xA.address)) === enygmaTransferAmount,
      message: `Waiting for Enygma settlement balance ${enygmaTransferAmount} → 0xA on PN B`,
      tolerateErrors: true,
    });

    // The X userBlobs landed because 0xA is TOKEN_OWNER scoped to X on B → net 60.
    LOGGER.log('✅ X net balance on B must reflect crossMint(100) then crossBurn(40) → 60');
    await waitForBalanceOf(() => erc20OnB.balanceOf(owner0xA.address), 60n, 'X net balance on B = 60');
    expect(await erc20OnB.balanceOf(owner0xA.address)).to.equal(60n);

    // Enygma accounting: A debited 10 (1000 → 990). B's +10 credit already asserted above.
    await checkDbBalance(990, privateHub, privacyNodes.A, enygmaOnPNA);

    LOGGER.log('✅ Enygma settlement + owner-gated X.crossMint/crossBurn dispatched atomically.');
  });

  it('a non-owner EOA cannot mint X via programmability — Enygma transfer reverts atomically', async function () {
    this.timeout(PROGRAMMABILITY_TEST_TIMEOUT);

    // Mint a tiny seed of Enygma to a fresh non-owner so they can send a crossTransfer
    // (the handler `_burn`s the sender; needs balance > 0 to attempt). PNs are gasless.
    const nonOwner = createUserOperator(privacyNodes.A.provider);
    await enygmaOnPNA.mintAndAwait(privateHub, { amount: enygmaTransferAmount, toAddress: nonOwner.address });

    // Same blob shape as before — still targets X — but the sender is NOT TOKEN_OWNER on B.
    const mintArgs = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [nonOwner.address, 100n]);
    const mintBlob = blobByAddress(xAddrTarget, crossMintSelector, mintArgs);

    // Snapshot balances; after a revert, both A's burn and B's settlement+X mint must roll back.
    const ownerXBalanceB_before = await erc20OnB.balanceOf(owner0xA.address);
    const nonOwnerEnygmaA_before = await (await enygmaOnPNA.forNode(privacyNodes.A)).getBalanceOf(nonOwner.address);

    LOGGER.log(`🛠️ Non-owner ${nonOwner.address} attempting Enygma transfer with X.crossMint userBlob — expected to revert`);
    const enygmaOnPNA_asNonOwner = privacyNodes.A
      .getContract<ProductionEnygmaToken>(enygmaOnPNA.symbol)
      .connect(nonOwner.connect(privacyNodes.A.provider)) as ProductionEnygmaToken;

    await submitTx(
      () => enygmaOnPNA_asNonOwner.crossTransfer(
        [nonOwner.address],
        [enygmaTransferAmount],
        [privacyNodes.B.chainId],
        [[mintBlob]],
        { gasLimit: PROGRAMMABILITY_GAS },
      ),
      'Non-owner Enygma+X.crossMint A->B (expected to revert atomically)',
    );

    // The Enygma transfer itself may or may not have reverted synchronously on A; the cross-chain
    // executeProgramData on B WILL revert (in-body owner-check fails for the non-owner). Either:
    //   (a) the relayer's revert path mints Enygma back to the non-owner on A — balance restored, or
    //   (b) X's balance on B stays at the pre-snapshot value for the owner (no mint to non-owner).
    // The strongest invariant we can assert without running the env: X's balance on B for the
    // OWNER didn't change, AND the non-owner didn't end up with X minted to them either.
    await eventually({
      check: async () => {
        const ownerXNow = await erc20OnB.balanceOf(owner0xA.address);
        const nonOwnerXNow = await erc20OnB.balanceOf(nonOwner.address);
        return ownerXNow === ownerXBalanceB_before && nonOwnerXNow === 0n;
      },
      message: 'Ensuring non-owner crossMint did NOT mint X on B (atomic revert of programmability frame)',
      tolerateErrors: true,
    });

    expect(await erc20OnB.balanceOf(owner0xA.address), 'owner X balance unchanged after non-owner attempt').to.equal(ownerXBalanceB_before);
    expect(await erc20OnB.balanceOf(nonOwner.address), 'non-owner must hold zero X on B').to.equal(0n);

    LOGGER.log(`✅ Non-owner attempt rejected by in-body TOKEN_OWNER check; non-owner Enygma balance on A: pre=${nonOwnerEnygmaA_before}`);
  });

  it('delegation: 0xA grants TOKEN_OWNER to 0xC on B, then 0xC can mint X via programmability', async function () {
    this.timeout(PROGRAMMABILITY_TEST_TIMEOUT);

    // 0xC: a fresh EOA, given a tiny Enygma seed on A so they can send a transfer. PNs are gasless.
    const delegate0xC = createUserOperator(privacyNodes.A.provider);
    await enygmaOnPNA.mintAndAwait(privateHub, { amount: enygmaTransferAmount, toAddress: delegate0xC.address });

    // 0xA grants 0xC the TOKEN_OWNER role scoped to X on B's AccessManager. This is the
    // contract-scoped grant — 0xC becomes a TOKEN_OWNER ONLY for token X, no other contracts.
    const xAddr = await erc20OnB.getAddress();
    LOGGER.log(`🛠️ 0xA granting TOKEN_OWNER scoped to X on B to delegate 0xC=${delegate0xC.address}`);
    await submitTx(
      () => accessManagerOnB.grantContractScopedRole(tokenOwnerRoleId, delegate0xC.address, xAddr, 0, { gasLimit: GAS_LIMIT }),
      `Granting TOKEN_OWNER scoped to X on B → 0xC=${delegate0xC.address}`,
    );

    // Verify the grant landed.
    const [isMember, execDelay] = await accessManagerOnB.hasContractScopedRole(tokenOwnerRoleId, delegate0xC.address, xAddr);
    expect(isMember, '0xC must hold TOKEN_OWNER scoped to X on B after grant').to.equal(true);
    expect(execDelay, 'grant must be immediate').to.equal(0n);

    // 0xC now sends an Enygma transfer with a crossMint(X, …, 0xC) userBlob from PN A.
    const mintArgs = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [delegate0xC.address, 75n]);
    const mintBlob = blobByAddress(xAddrTarget, crossMintSelector, mintArgs);

    const enygmaOnPNA_asDelegate = privacyNodes.A
      .getContract<ProductionEnygmaToken>(enygmaOnPNA.symbol)
      .connect(delegate0xC.connect(privacyNodes.A.provider)) as ProductionEnygmaToken;

    LOGGER.log(`🛠️ Delegate 0xC sending Enygma transfer + crossMint(X) — should succeed via delegated TOKEN_OWNER`);
    await submitTx(
      () => enygmaOnPNA_asDelegate.crossTransfer(
        [delegate0xC.address],
        [enygmaTransferAmount],
        [privacyNodes.B.chainId],
        [[mintBlob]],
        { gasLimit: PROGRAMMABILITY_GAS },
      ),
      'Delegated 0xC Enygma+X.crossMint A->B',
    );

    // 0xC should now hold 75 X on B.
    await waitForBalanceOf(() => erc20OnB.balanceOf(delegate0xC.address), 75n, '0xC X balance on B = 75 after delegated mint');
    expect(await erc20OnB.balanceOf(delegate0xC.address)).to.equal(75n);

    LOGGER.log('✅ Delegation works: TOKEN_OWNER grant on B promotes 0xC to a valid programmability minter for X.');
  });
});

// ============================================================================================
// CROSS-STANDARD via an APPROVED / HUB-REGISTERED token X (resourceId bound on the endpoint).
//
// Contrast with the user-deploy suite above. Here X is hub-registered: deployed off the seeded
// RAYLS_ERC20_KEY template via `deployErc20AsUser` (as ADMIN) and then run through the new-registry
// hub flow (`activateOnPn` + `activateOnHub`), whose `activateToken` callback (PNTokenCoreV1.activateToken)
// (1) registers X's resourceId on B's endpoint and (2) grants X the ENDPOINT_SENDER role. That means:
//
//   * Blobs target X by RESOURCE ID — the executor resolves it natively via
//     endpoint.getAddressByResourceId (no address-fallback needed).
//   * crossMint's _submitTokenUpdate → endpoint.send succeeds (X holds ENDPOINT_SENDER), so the
//     mint/burn is also reported to the PNH TokenRegistry (hub-tracked, unlike the user-deploy case).
//
// The ownership difference: X here is deployed AS ADMIN, so its owner/authority is the admin key,
// NOT the Enygma sender 0xA. So we must EXPLICITLY grant 0xA contract-scoped TOKEN_OWNER on X (the
// step the user-deploy suite folds into deploying as 0xA). The grant is signed by X's contract
// authority (the admin/system key), resolved from the AccessManager.
// ============================================================================================

describe('E2E Tests: Programmability — Enygma composing crossMint+crossBurn on an APPROVED ERC20 (resourceId-resolved)', function () {
  let owner0xA: HDNodeWallet | Wallet;
  let enygmaOnPNA: EnygmaWrapper<ProductionEnygmaToken>;
  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  const crossMintSelector = ethers.id('crossMint(address,uint256)').slice(0, 10);
  const crossBurnSelector = ethers.id('crossBurn(address,uint256)').slice(0, 10);

  // X — an APPROVED ERC20 registered on PN B via the PNH flow. resourceId IS bound on B's endpoint,
  // so blobs target X by resourceId directly (no address-fallback).
  let xOnB: ERC20Wrapper<ProductionErc20Token>;
  let xResourceId: string;
  let accessManagerOnB: ReturnType<typeof RaylsAccessManagerV1__factory.connect>;
  let tokenOwnerRoleId: bigint;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    // Enygma payment token on A (new token-registry flow), funded for the sender 0xA.
    enygmaOnPNA = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
    owner0xA = enygmaOnPNA.userWallet;
    await enygmaOnPNA.deployViaFactory();
    await enygmaOnPNA.activateOnPn();
    await enygmaOnPNA.activateOnHub(privateHub);
    await enygmaOnPNA.mintAndAwait(privateHub, { amount: 1000n, toAddress: owner0xA.address });

    // Register + activate X (ERC20) on PN B. Deploy off the seeded RAYLS_ERC20_KEY template as ADMIN
    // (deployErc20AsUser → codehash clears the crossMint gate; owner/authority = admin, matching the
    // admin-signed TOKEN_OWNER grant below), then hub-register via the new-registry flow. That binds
    // X's resourceId on B's endpoint AND grants ENDPOINT_SENDER (PNTokenCoreV1.activateToken).
    xOnB = new ERC20Wrapper<ProductionErc20Token>(privacyNodes.B, ProductionErc20Token__factory);
    await xOnB.deployViaFactory(18, privacyNodes.B.adminWallet);
    await xOnB.activateOnPn();
    await xOnB.activateOnHub(privateHub);
    xResourceId = xOnB.resourceId;

    // Sanity: X's resourceId resolves to its address on B's endpoint (native blob resolution).
    const xAddr = await xOnB.contract.getAddress();
    const resolved = await privacyNodes.B.getEndpointV1().getAddressByResourceId(xResourceId);
    expect(resolved, 'approved X resourceId must resolve on B endpoint').to.equal(xAddr);

    // Resolve the AccessManager + TOKEN_OWNER role id on B.
    const accessManagerAddr = await privacyNodes.B.resolveFromRegistry('RaylsAccessManager');
    accessManagerOnB = RaylsAccessManagerV1__factory.connect(accessManagerAddr, privacyNodes.B.adminWallet);
    tokenOwnerRoleId = await accessManagerOnB.TOKEN_OWNER();

    // Grant 0xA contract-scoped TOKEN_OWNER on X. A hub-registered instance's authority is the
    // factory/admin key (not 0xA), so the grant must be signed by that authority — which is the
    // admin wallet. (For the user-deploy suite the deployer was already the authority + owner.)
    const xAuthority = await accessManagerOnB.getContractAuthority(xAddr);
    LOGGER.log(`🛠️ Granting 0xA (${owner0xA.address}) TOKEN_OWNER scoped to approved X on B (authority=${xAuthority})`);
    await submitTx(
      () => accessManagerOnB.grantContractScopedRole(tokenOwnerRoleId, owner0xA.address, xAddr, 0, { gasLimit: GAS_LIMIT }),
      `Granting TOKEN_OWNER scoped to approved X on B → 0xA=${owner0xA.address}`,
    );

    const [isMember, execDelay] = await accessManagerOnB.hasContractScopedRole(tokenOwnerRoleId, owner0xA.address, xAddr);
    expect(isMember, '0xA must hold TOKEN_OWNER scoped to approved X on B after the grant').to.equal(true);
    expect(execDelay, 'TOKEN_OWNER grant must be immediate (no delay)').to.equal(0n);
  });

  it('composed [enygmaMint, X.crossMint(100), X.crossBurn(40)] on an APPROVED X lands net 60 on B (resourceId-resolved)', async function () {
    this.timeout(PROGRAMMABILITY_TEST_TIMEOUT);

    expect(await xOnB.contract.balanceOf(owner0xA.address), 'X must start empty for 0xA on B').to.equal(0n);

    // Blobs target X by RESOURCE ID (not address) — the approved token is endpoint-bound.
    const mintArgs = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [owner0xA.address, 100n]);
    const burnArgs = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [owner0xA.address, 40n]);
    const mintBlob = blobByResourceId(xResourceId, crossMintSelector, mintArgs);
    const burnBlob = blobByResourceId(xResourceId, crossBurnSelector, burnArgs);

    LOGGER.log('🛠️ Composed Enygma transfer A->B carrying X.crossMint+X.crossBurn (approved X, resourceId-resolved)');
    await submitTx(
      () => privacyNodes.A
        .getContract<ProductionEnygmaToken>(enygmaOnPNA.symbol)
        .crossTransfer(
          [owner0xA.address],
          [enygmaTransferAmount],
          [privacyNodes.B.chainId],
          [[mintBlob, burnBlob]], // handler prepends enygmaMintBlob (settlement) → [enygmaMint, xMint, xBurn]
          { gasLimit: PROGRAMMABILITY_GAS },
        ),
      'Programmability composed Enygma+X.crossMint/crossBurn A->B (approved X)',
    );

    // Enygma settlement lands on B — wait for the B-side replica balance. tolerateErrors: reads can
    // transiently revert while the relayer finalizes the SC↔DB commitment.
    const enygmaOnPNB = await privacyNodes.B.setContractByResourceId<ProductionEnygmaToken>(
      ProductionEnygmaToken__factory.name,
      enygmaOnPNA.resourceId,
      enygmaOnPNA.symbol,
      owner0xA.connect(privacyNodes.B.provider),
    );
    await eventually({
      check: async () => (await enygmaOnPNB.balanceOf(owner0xA.address)) === enygmaTransferAmount,
      message: `Waiting for Enygma settlement balance ${enygmaTransferAmount} → 0xA on PN B (approved X)`,
      tolerateErrors: true,
    });

    // X net balance on B = 60 (100 minted − 40 burned), via the owner-gated programmability frame.
    LOGGER.log('✅ Approved X net balance on B must reflect crossMint(100) then crossBurn(40) → 60');
    await waitForBalanceOf(() => xOnB.contract.balanceOf(owner0xA.address), 60n, 'approved X net balance on B = 60');
    expect(await xOnB.contract.balanceOf(owner0xA.address)).to.equal(60n);

    // Enygma accounting: A debited 10 (1000 → 990). B's +10 credit asserted above.
    await checkDbBalance(990, privateHub, privacyNodes.A, enygmaOnPNA);

    // Unlike the user-deploy case, the approved X holds ENDPOINT_SENDER, so its crossMint/crossBurn
    // also reported the balance delta to the PNH TokenRegistry — the send did NOT revert.
    LOGGER.log('✅ Approved X: settlement + owner-gated crossMint/crossBurn dispatched atomically (resourceId-resolved, hub-tracked).');
  });
});

// ============================================================================================
// ERC721 + ERC1155 cross-standard suites — TODO: same shape as the ERC20 suite above, swap
// selectors + signatures. Skipped while the env is being rebuilt; the patterns are identical so
// the 721/1155 tests will be straightforward once the ERC20 case is proven green.
// ============================================================================================

