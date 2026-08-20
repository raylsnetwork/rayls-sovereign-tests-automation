/**
 * @title E2E SECURITY: SEC-002 Option C — Large-Balance Exfiltration (rewritten for the new model)
 *
 * @description Original variant: counterfeit EUR from crossMint() reentrancy on PN-B was exfiltrated
 *              cross-chain at large scale, probing the PNH supply-reconciliation / CC bypass.
 *
 *              Under the NEW programmability model the in-handler callable path is gone. The attack
 *              is a malicious userBlob dispatched by PN-B's `executeProgramData`, whose `attack()`
 *              re-enters the token's `restricted crossMintStandard` to counterfeit a large balance.
 *              The re-entry is defeated by `restricted` (the exploit is not a RELAYER) and
 *              `nonReentrant`, so no counterfeit supply is created and there is nothing to exfiltrate
 *              — the downstream CC-bypass / supply-reconciliation concern never arises.
 *
 *              CANONICAL UNIT COVERAGE: src/test/unit/security/SEC002_EnygmaHandler_Reentrancy.t.sol
 *              (`test_SEC002_crossMintExploit_contract_is_defeated`).
 *
 * STATUS: skipped pending live multi-node env validation — authored to the new API, not yet run
 *         against a running environment. Unskip once validated.
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
  SEC002_CrossMintExploit__factory,
  TemplateRegistryV1__factory,
  TemplateRegistryReplicaV1__factory,
} from '../../../typechain-types';
import { createUserOperator } from '../../../src/utils/wallet-factory';

const INITIAL_EUR = ethers.parseUnits('100000', 18);     // 100,000 EUR legitimate float
const COUNTERFEIT_EUR = ethers.parseUnits('500000', 18); // 500,000 EUR counterfeit attempt (large)

const ATTACK_SIGNATURE = 'attack()';
const ATTACK_SELECTOR = ethers.id(ATTACK_SIGNATURE).slice(0, 10);

function formatEUR(amount: bigint): string {
  return ethers.formatUnits(amount, 18);
}

describe('E2E SECURITY: SEC-002 Option C — Large-balance exfiltration is blocked', function () {
  this.timeout(DEFAULT_TIMEOUT * 2);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  before(async function () {
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;
  });

  it('SEC-002-E2E-C: a large counterfeit re-entry is defeated; no supply inflation or exfil', async function () {
    LOGGER.log('\n═══ SEC-002 Option C: LARGE-BALANCE EXFIL (executor-dispatched) ═══');

    const beneficiary = '0x000000000000000000000000000000000000dEaD';

    // --- PHASE 1: provision the LIVE Enygma handler on PN-B with a large legitimate float ---
    const enygma = new EnygmaWrapper<ProductionEnygmaToken>(privacyNodes.A, ProductionEnygmaToken__factory);
    const signerA = enygma.userWallet;
    const adminB = privacyNodes.B.adminWallet;
    const deployer = createUserOperator(privacyNodes.B.provider);
    await enygma.deployViaFactory();
    await enygma.activateOnPn();
    await enygma.activateOnHub(privateHub);
    await enygma.mintAndAwait(privateHub, { amount: INITIAL_EUR, toAddress: signerA.address });

    await submitTx(
      () => privacyNodes.A
        .getContract<ProductionEnygmaToken>(enygma.symbol)
        .linearCrossTransfer(adminB.address, INITIAL_EUR, privacyNodes.B.chainId, [], { gasLimit: GAS_LIMIT }),
      'Provisioning the LIVE Enygma handler on PN-B'
    );
    await enygma.waitForDeploymentOnNode(privacyNodes.B);
    await eventually<boolean>({
      check: async () => (await privacyNodes.B.getContract<ProductionEnygmaToken>(enygma.symbol).balanceOf(adminB.address)) === INITIAL_EUR,
      message: `Checking settlement balance on chain ${privacyNodes.B.chainId}`,
    });

    const tokenOnB = privacyNodes.B.getContract<ProductionEnygmaToken>(enygma.symbol);
    const tokenBAddr = await tokenOnB.getAddress();

    // --- PHASE 2: deploy the exploit on PN-B; register its resourceId ---
    const executorAddr = await privacyNodes.B.resolveFromRegistry('ProgrammabilityExecutor');
    const exploit = await new SEC002_CrossMintExploit__factory(deployer).deploy(
      tokenBAddr, executorAddr, beneficiary, COUNTERFEIT_EUR, { gasLimit: GAS_LIMIT }
    );
    await exploit.waitForDeployment();
    const exploitAddr = await exploit.getAddress();
    LOGGER.log(`   Large-balance exploit: ${exploitAddr}`);

    const exploitResourceId = ethers.encodeBytes32String('sec002-exfil-large');
    const endpointBAsAdmin = privacyNodes.B.getEndpointV1().connect(adminB) as ReturnType<typeof privacyNodes.B.getEndpointV1>;
    await submitTx(
      () => endpointBAsAdmin.registerResourceId(exploitResourceId, exploitAddr, { gasLimit: GAS_LIMIT }),
      'Registering exploit resourceId on PN-B endpoint',
    );

    // --- PHASE 3: seed the exploit's (codehash, attack()) template + wait for replica ---
    const exploitCodehash = ethers.keccak256(await privacyNodes.B.provider.getCode(exploitAddr));
    const registry = TemplateRegistryV1__factory.connect(privateHub.deployNamesAndAddresses['TemplateRegistry'], privateHub.operatorWallet);
    const templateKey = await registry.getKey(exploitCodehash, ATTACK_SELECTOR);
    const existing = await registry.getTemplate(templateKey);
    if (existing.bytecodeHash === ethers.ZeroHash) {
      await submitTx(() => registry.propose(exploitCodehash, ATTACK_SIGNATURE, { gasLimit: GAS_LIMIT }), 'Proposing exploit template on PNH');
    }
    if (!existing.approved) {
      await submitTx(() => registry.approve(templateKey, { gasLimit: GAS_LIMIT }), 'Approving exploit template on PNH');
    }
    const replicaB = TemplateRegistryReplicaV1__factory.connect(await privacyNodes.B.resolveFromRegistry('TemplateRegistryReplica'), privacyNodes.B.provider);
    await eventually({
      check: async () => (await replicaB.getTemplate(templateKey)).approved,
      message: 'Waiting for exploit template → PN-B replica approval',
      tolerateErrors: true,
    });

    // --- PHASE 4: compose the Enygma transfer carrying the exploit userBlob ---
    const supplyBefore = await tokenOnB.totalSupply();
    await enygma.mintAndAwait(privateHub, { amount: INITIAL_EUR, toAddress: signerA.address });

    const exploitBlob = { resourceId: exploitResourceId, contractAddress: ethers.ZeroAddress, selector: ATTACK_SELECTOR, args: '0x' };
    await submitTx(
      () => privacyNodes.A
        .getContract<ProductionEnygmaToken>(enygma.symbol)
        .crossTransfer([adminB.address], [INITIAL_EUR], [privacyNodes.B.chainId], [[exploitBlob]], { gasLimit: GAS_LIMIT }),
      'Composed Enygma transfer A→B carrying the large-balance exfil userBlob'
    );

    // --- PHASE 5: assert the large counterfeit re-entry was defeated ---
    await eventually<boolean>({
      check: async () => (await exploit.callCount()) > 0n,
      message: 'Waiting for the exploit userBlob to be dispatched on PN-B',
      tolerateErrors: true,
    });

    const reentrancySucceeded = await exploit.reentrancySucceeded();
    const supplyAfter = await tokenOnB.totalSupply();
    const beneficiaryBalance = await tokenOnB.balanceOf(beneficiary);

    LOGGER.log(`   Reentrancy succeeded:  ${reentrancySucceeded} (must be false)`);
    LOGGER.log(`   PN-B supply delta:     ${formatEUR(supplyAfter - supplyBefore)} EUR`);
    LOGGER.log(`   Counterfeit beneficiary balance: ${formatEUR(beneficiaryBalance)} EUR (must be 0)`);

    expect(reentrancySucceeded).to.equal(false, 'restricted/nonReentrant must defeat the large counterfeit mint');
    expect(beneficiaryBalance).to.equal(0n, 'no counterfeit EUR may be minted to the attacker beneficiary');
    expect(
      supplyAfter - supplyBefore <= INITIAL_EUR,
      'PN-B supply must grow by at most the authorized settlement amount (no inflation)'
    ).to.equal(true);
  });
});
