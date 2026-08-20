/**
 * @title E2E SECURITY: SEC-002 — Reentrancy in the programmability dispatch path
 * @description Rewritten for the NEW programmability model. The original SEC-002 attacked the OLD
 *              in-handler callable model, where `crossMint(to, value, refId, callable[])` minted and
 *              then executed callables IN-HANDLER via `.call(payload)`; a malicious callable could
 *              re-enter `crossMint` to mint counterfeit tokens (CEI + reentrancy).
 *
 *              That signature and that execution path no longer exist. Programmability now runs
 *              through `ProgrammabilityExecutorV1.executeProgramData(EnygmaProgramData[], uint256,
 *              address)`, which `target.call`s each gated step. A malicious step target re-entering
 *              the token's settlement mint (`crossMintStandard`) is defended by TWO independent gates:
 *                1. `restricted` — the re-entrant caller (the exploit contract) does NOT hold
 *                   RELAYER, so the token's `restricted crossMintStandard` rejects it.
 *                2. `nonReentrant` — `executeProgramData` holds its lock for the whole frame.
 *
 *              This E2E composes an Enygma transfer A→B carrying a malicious userBlob that, when
 *              dispatched by PN-B's executor, attempts to re-enter and mint counterfeit tokens. The
 *              attack must be defeated and no counterfeit supply may appear on PN-B.
 *
 *              CANONICAL UNIT COVERAGE: the same defense is proven deterministically in the
 *              contracts repo at src/test/unit/security/SEC002_EnygmaHandler_Reentrancy.t.sol. This
 *              E2E variant exercises it through the LIVE relayer + executor wiring.
 *
 * STATUS: skipped pending live multi-node env validation. The new-model attack flow (deploy exploit
 *         on PN-B → register + seed its template → compose Enygma transfer carrying the exploit
 *         userBlob → drive through the relayer → assert the gates defeat it) is authored to the new
 *         API but has not been run against a running environment. Unskip once validated.
 */

import { ethers } from 'ethers';
import { expect } from 'chai';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { EnygmaWrapper } from '../../../src/entities/tokens/EnygmaWrapper';
import { eventually, submitTx } from '../../../src/utils/common';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
  RaylsAccessManagerV1__factory,
  SEC002_CrossMintExploit__factory,
  TemplateRegistryV1__factory,
  TemplateRegistryReplicaV1__factory,
} from '../../../typechain-types';
import { createUserOperator } from '../../../src/utils/wallet-factory';

// EUR amounts (18 decimals)
const LEGITIMATE_EUR = ethers.parseUnits('10000', 18);   // 10,000 EUR (authorized settlement)
const INFLATION_EUR = ethers.parseUnits('100000', 18);   // 100,000 EUR (counterfeit attempt)

// The exploit's re-entrant `attack()` (no declared params — the executor appends the attested origin
// as a trusted tail, which this exploit ignores). attack() re-enters the token's crossMintStandard.
const ATTACK_SIGNATURE = 'attack()';
const ATTACK_SELECTOR = ethers.id(ATTACK_SIGNATURE).slice(0, 10);

function formatEUR(amount: bigint): string {
  return ethers.formatUnits(amount, 18);
}

describe('E2E SECURITY: SEC-002 — Programmability reentrancy is blocked (EUR inflation)', function () {
  this.timeout(DEFAULT_TIMEOUT * 2);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  before(async function () {
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;
  });

  it('SEC-002-E2E-001: a malicious userBlob cannot re-enter to mint counterfeit EUR', async function () {
    LOGGER.log('\n═══════════════════════════════════════════════════════════════');
    LOGGER.log('   SEC-002: PROGRAMMABILITY REENTRANCY DEFENSE (executor-dispatched)');
    LOGGER.log('═══════════════════════════════════════════════════════════════');

    const attackerBeneficiary = '0x000000000000000000000000000000000000dEaD';

    // --- PHASE 1: Deploy Enygma EUR on PN-A, mint, cross-transfer to PL-B (creates LIVE handler) ---
    LOGGER.log('\n   PHASE 1: DEPLOY ENYGMA EUR & CROSS-CHAIN TRANSFER (creates LIVE handler on PN-B)');

    const enygma = new EnygmaWrapper<ProductionEnygmaToken>(privacyNodes.A, ProductionEnygmaToken__factory);
    const signerA = enygma.userWallet;
    const adminB = privacyNodes.B.adminWallet;
    const deployer = createUserOperator(privacyNodes.B.provider);
    await enygma.deployViaFactory();
    await enygma.activateOnPn();
    await enygma.activateOnHub(privateHub);
    await enygma.mintAndAwait(privateHub, { amount: LEGITIMATE_EUR, toAddress: signerA.address });

    await submitTx(
      () => privacyNodes.A
        .getContract<ProductionEnygmaToken>(enygma.symbol)
        .linearCrossTransfer(
          adminB.address,
          LEGITIMATE_EUR,
          privacyNodes.B.chainId,
          [], // plain transfer — provisions the LIVE handler on PN-B
          { gasLimit: GAS_LIMIT }
        ),
      'Provisioning the LIVE Enygma handler on PN-B'
    );

    await enygma.waitForDeploymentOnNode(privacyNodes.B);
    await eventually<boolean>({
      check: async () => (await privacyNodes.B
        .getContract<ProductionEnygmaToken>(enygma.symbol)
        .balanceOf(adminB.address)) === LEGITIMATE_EUR,
      message: `Checking settlement balance on chain ${privacyNodes.B.chainId}`,
    });

    const tokenOnB = privacyNodes.B.getContract<ProductionEnygmaToken>(enygma.symbol);
    const tokenBAddr = await tokenOnB.getAddress();
    LOGGER.log(`   LIVE Enygma handler on PN-B: ${tokenBAddr}`);

    // --- PHASE 2: Locate LIVE executor; deploy the exploit on PN-B and register its resourceId ---
    LOGGER.log('\n   PHASE 2: LOCATE LIVE EXECUTOR & DEPLOY EXPLOIT USERBLOB TARGET');

    const managerAddr = await privacyNodes.B.resolveFromRegistry('RaylsAccessManager');
    const manager = RaylsAccessManagerV1__factory.connect(managerAddr, adminB);
    const relayerRoleId = await manager.getRoleIdByName('RELAYER');

    // The LIVE ProgrammabilityExecutor on PN-B — the relayer dispatches userBlobs through it.
    const executorAddr = await privacyNodes.B.resolveFromRegistry('ProgrammabilityExecutor');
    LOGGER.log(`   LIVE ProgrammabilityExecutor: ${executorAddr}`);

    // Deploy the exploit. Its `attack()` re-enters the token's crossMintStandard to counterfeit.
    const exploit = await new SEC002_CrossMintExploit__factory(deployer).deploy(
      tokenBAddr,
      executorAddr,
      attackerBeneficiary,
      INFLATION_EUR,
      { gasLimit: GAS_LIMIT }
    );
    await exploit.waitForDeployment();
    const exploitAddr = await exploit.getAddress();
    LOGGER.log(`   Exploit userBlob target: ${exploitAddr}`);

    // The exploit is NOT granted RELAYER — that is the whole point: when attack() re-enters the
    // token's `restricted crossMintStandard`, the gate must reject it because it is not a relayer.
    const [exploitIsRelayer] = await manager.hasRole(relayerRoleId, exploitAddr);
    LOGGER.log(`   Exploit holds RELAYER (must be false): ${exploitIsRelayer}`);

    // Register the exploit's resourceId on B's endpoint so the executor can resolve the userBlob.
    const exploitResourceId = ethers.encodeBytes32String('sec002-exploit');
    const endpointBAsAdmin = privacyNodes.B.getEndpointV1().connect(adminB) as ReturnType<typeof privacyNodes.B.getEndpointV1>;
    await submitTx(
      () => endpointBAsAdmin.registerResourceId(exploitResourceId, exploitAddr, { gasLimit: GAS_LIMIT }),
      'Registering exploit resourceId on PN-B endpoint',
    );

    // --- PHASE 3: Seed the exploit's template so its userBlob clears the executor gate ---
    // The executor gates (target.codehash, selector) against the PN replica. To dispatch the exploit
    // userBlob at all (so we prove the INNER re-entry is what's blocked, not the gate), seed
    // (codehash, attack() selector) as an approved template on PNH and wait for it to replicate.
    LOGGER.log('\n   PHASE 3: SEED EXPLOIT TEMPLATE (so the userBlob reaches dispatch)');
    const exploitCodehash = ethers.keccak256(await privacyNodes.B.provider.getCode(exploitAddr));
    const registryAddress = privateHub.deployNamesAndAddresses['TemplateRegistry'];
    const registry = TemplateRegistryV1__factory.connect(registryAddress, privateHub.operatorWallet);
    const templateKey = await registry.getKey(exploitCodehash, ATTACK_SELECTOR);

    const existing = await registry.getTemplate(templateKey);
    if (existing.bytecodeHash === ethers.ZeroHash) {
      await submitTx(
        () => registry.propose(exploitCodehash, ATTACK_SIGNATURE, { gasLimit: GAS_LIMIT }),
        'Proposing exploit attack() template on PNH',
      );
    }
    if (!existing.approved) {
      await submitTx(
        () => registry.approve(templateKey, { gasLimit: GAS_LIMIT }),
        'Approving exploit attack() template on PNH',
      );
    }
    const replicaBAddr = await privacyNodes.B.resolveFromRegistry('TemplateRegistryReplica');
    const replicaB = TemplateRegistryReplicaV1__factory.connect(replicaBAddr, privacyNodes.B.provider);
    await eventually({
      check: async () => (await replicaB.getTemplate(templateKey)).approved,
      message: 'Waiting for exploit template → PN-B replica approval',
      tolerateErrors: true,
    });

    // --- PHASE 4: Compose an Enygma transfer A→B carrying [mintBlob(auto), exploitBlob] ---
    LOGGER.log('\n   PHASE 4: COMPOSE ENYGMA TRANSFER CARRYING THE EXPLOIT USERBLOB');

    const supplyBefore = await tokenOnB.totalSupply();
    LOGGER.log(`   PN-B supply before attack: ${formatEUR(supplyBefore)} EUR`);

    // Re-fund the sender so the composed transfer has value to settle.
    await enygma.mintAndAwait(privateHub, { amount: LEGITIMATE_EUR, toAddress: signerA.address });

    // The exploit userBlob targets the exploit by resourceId, selector attack(), empty args. The
    // handler auto-prepends the settlement mint blob → the relayer dispatches [mintBlob, exploitBlob]
    // via executeProgramData on PN-B. The exploit's attack() then attempts the counterfeit re-entry.
    const exploitBlob = {
      resourceId: exploitResourceId,
      contractAddress: ethers.ZeroAddress,
      selector: ATTACK_SELECTOR,
      args: '0x',
    };

    await submitTx(
      () => privacyNodes.A
        .getContract<ProductionEnygmaToken>(enygma.symbol)
        .crossTransfer(
          [adminB.address],
          [LEGITIMATE_EUR],
          [privacyNodes.B.chainId],
          [[exploitBlob]], // one userBlob array for the single recipient
          { gasLimit: GAS_LIMIT }
        ),
      'Composed Enygma transfer A→B carrying the SEC-002 exploit userBlob'
    );

    // --- PHASE 5: Measure impact — the re-entry must have been defeated ---
    LOGGER.log('\n   PHASE 5: MEASURE IMPACT');

    // Give the relayer time to dispatch executeProgramData on PN-B.
    await eventually<boolean>({
      check: async () => (await exploit.callCount()) > 0n,
      message: 'Waiting for the exploit userBlob to be dispatched on PN-B',
      tolerateErrors: true,
    });

    const reentrancySucceeded = await exploit.reentrancySucceeded();
    const reentrancyAttempted = await exploit.reentrancyAttempted();
    const supplyAfter = await tokenOnB.totalSupply();
    const beneficiaryBalance = await tokenOnB.balanceOf(attackerBeneficiary);

    LOGGER.log(`   Reentrancy attempted:  ${reentrancyAttempted}`);
    LOGGER.log(`   Reentrancy succeeded:  ${reentrancySucceeded} (must be false)`);
    LOGGER.log(`   PN-B supply after:     ${formatEUR(supplyAfter)} EUR`);
    LOGGER.log(`   Counterfeit beneficiary balance: ${formatEUR(beneficiaryBalance)} EUR (must be 0)`);

    // ASSERTIONS: the re-entry was attempted but DEFEATED by restricted/nonReentrant; no counterfeit.
    expect(reentrancySucceeded).to.equal(
      false,
      `VULNERABILITY SEC-002 CONFIRMED: a malicious userBlob re-entered to mint counterfeit EUR on ` +
      `PN-B's LIVE handler (${tokenBAddr}). The restricted + nonReentrant gates must defeat it.`
    );
    expect(beneficiaryBalance).to.equal(0n, 'no counterfeit EUR may be minted to the attacker beneficiary');
    expect(
      supplyAfter - supplyBefore <= LEGITIMATE_EUR,
      'PN-B supply must grow by at most the authorized settlement amount (no inflation)'
    ).to.equal(true);
  });
});
