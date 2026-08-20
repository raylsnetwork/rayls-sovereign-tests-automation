import { expect } from 'chai';
import { ethers } from 'hardhat';
import {
  ProductionErc721Dvp,
  ProductionErc1155Dvp,
} from '../../../../typechain-types';
import { ERC721Wrapper } from '../../../../src/entities/tokens/ERC721Wrapper';
import { ERC1155Wrapper } from '../../../../src/entities/tokens/ERC1155Wrapper';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { DEFAULT_TIMEOUT, LOGGER } from '../../../../src/config/env-config';
import { eventually } from '../../../../src/utils/common';
import { shortHex } from '../../../../src/utils/formatters';
import { ProductionErc721Dvp__factory, ProductionErc1155Dvp__factory } from '../../../../typechain-types';
import { HDNodeWallet, Wallet } from 'ethers';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';

describe('Dvp Security Tests', function () {
  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let signerNotOwner: Wallet | HDNodeWallet;

  before(async function () {
    LOGGER.optionalLog(`Setting up Dvp Security Tests infrastructure`);
    const {initializedNodes,
      initializedPNH} = await initializePrivacyNodesAndPnh(1);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    signerNotOwner = Wallet.createRandom(privacyNodes.A.provider);
  });

  describe('ERC721 Security Tests', function () {
    let nft: ERC721Wrapper<ProductionErc721Dvp>;
    let tokenId: bigint;

    beforeEach(async function () {
      this.timeout(DEFAULT_TIMEOUT);
      LOGGER.optionalLog(`Setting up ERC721 security test prerequisites`);
      nft = new ERC721Wrapper(privacyNodes.A, ProductionErc721Dvp__factory);
      await nft.deploy();
      await nft.activateOnPn();
      await nft.activateOnHub(privateHub);
      tokenId = await nft.mintAndAwait(privateHub, { toAddress: nft.userWallet.address });
    });

    it('should prevent unauthorized deposit of ERC721 token @security @regression @dvp @erc721', async function () {
      await expect(nft.contract.connect(signerNotOwner).depositIntoDvp(tokenId)).to.be.revertedWith(
        'Token not owned by the sender'
      );
    }).timeout(15 * 60 * 1000);

    it('should allow authorized deposit of ERC721 token @security @regression @dvp @erc721', async function () {
      const depositERC721Tx = await nft.contract.depositIntoDvp(tokenId);
      await depositERC721Tx.wait(2);

      // Verify token is locked
      await eventually<boolean>({
        check: async (): Promise<boolean> => {
          return nft.contract.lockedForDvp(tokenId);
        },
        interval: 1000,
        attempts: 300,
        message: `Waiting for NFT #${tokenId} locked for DVP`,
      }),
      'ERC721 token not locked for the user';
    }).timeout(15 * 60 * 1000);

    it('should prevent transfer of locked ERC721 token @security @regression @dvp @erc721', async function () {
      // Ensure locked by depositing
      await (await nft.contract.depositIntoDvp(tokenId)).wait(2);
      await expect(
        nft.contract.transferFrom(nft.userWallet.address, signerNotOwner.address, tokenId)
      ).to.be.revertedWith('This token is locked in the Dvp');
    }).timeout(15 * 60 * 1000);

    it('should prevent unauthorized swap of ERC721 token @security @regression @dvp @erc721', async function () {
      await (await nft.contract.depositIntoDvp(tokenId)).wait(2);

      await expect(
        nft.contract.connect(signerNotOwner).swapWithDvpForEnygma(
          tokenId,
          1,
          ethers.encodeBytes32String(''),
          1234,
          ethers.encodeBytes32String(''),
          0
        )
      ).to.be.revertedWith('Token not owned by the sender');
    }).timeout(15 * 60 * 1000);

    it('should prevent unauthorized withdrawal of ERC721 token @security @regression @dvp @erc721', async function () {
      await (await nft.contract.depositIntoDvp(tokenId)).wait(2);

      await expect(nft.contract.connect(signerNotOwner).withdrawFromDvp(tokenId)).to.be.revertedWith(
        'Token not owned by the sender'
      );
    }).timeout(15 * 60 * 1000);
  });

  describe('ERC1155 Security Tests', function () {
    let erc1155: ERC1155Wrapper<ProductionErc1155Dvp>;
    const ERC1155_ID = 1n;
    const ERC1155_AMOUNT = 100n;

    beforeEach(async function () {
      this.timeout(DEFAULT_TIMEOUT);
      LOGGER.optionalLog(`Setting up ERC1155 security test prerequisites`);
      erc1155 = new ERC1155Wrapper(privacyNodes.A, ProductionErc1155Dvp__factory);
      await erc1155.deploy();
      await erc1155.activateOnPn();
      await erc1155.activateOnHub(privateHub);
      await erc1155.mintAndAwait(privateHub, { toAddress: erc1155.userWallet.address, tokenId: ERC1155_ID, amount: ERC1155_AMOUNT });
    });

    it('should prevent unauthorized deposit of ERC1155 token @security @regression @dvp @erc1155', async function () {
      await expect(
        erc1155.contract.connect(signerNotOwner).depositIntoDvp(ERC1155_ID, ERC1155_AMOUNT, '0x')
      ).to.be.revertedWith('Not enough unlocked tokens to deposit into Dvp');
    }).timeout(15 * 60 * 1000);

    it('should allow authorized deposit of ERC1155 token @security @regression @dvp @erc1155', async function () {
      const depositERC1155Tx = await erc1155.contract.depositIntoDvp(ERC1155_ID, ERC1155_AMOUNT, '0x');
      await depositERC1155Tx.wait(2);

      // Verify tokens are locked
      await eventually<boolean>({
        check: async (): Promise<boolean> => {
          const lockedAmount = await erc1155.contract.lockedForDvp(erc1155.userWallet.address, ERC1155_ID);
          return lockedAmount == BigInt(ERC1155_AMOUNT);
        },
        interval: 1000,
        attempts: 300,
        message: `Waiting for #${ERC1155_ID} lockedForDvp → ${ERC1155_AMOUNT} on ${shortHex(erc1155.userWallet.address)}`,
      });
    }).timeout(15 * 60 * 1000);

    it('should prevent transfer of locked ERC1155 tokens @security @regression @dvp @erc1155', async function () {
      // Ensure locked by depositing
      await (await erc1155.contract.depositIntoDvp(ERC1155_ID, ERC1155_AMOUNT, '0x')).wait(2);
      await expect(
        erc1155.contract.safeTransferFrom(erc1155.userWallet.address, signerNotOwner.address, ERC1155_ID, ERC1155_AMOUNT, '0x')
      ).to.be.revertedWith('Not enough unlocked tokens for operation');
    }).timeout(15 * 60 * 1000);

    it('should prevent unauthorized swap of ERC1155 tokens @security @regression @dvp @erc1155', async function () {
      await expect(
        erc1155.contract.connect(signerNotOwner).swapWithDvpForEnygma(
          ERC1155_ID,
          ERC1155_AMOUNT,
          '0x',
          1,
          ethers.encodeBytes32String(''),
          1234,
          ethers.encodeBytes32String(''),
          0
        )
      ).to.be.revertedWith('Not enough tokens locked to Dvp');
    }).timeout(15 * 60 * 1000);

    it('should prevent unauthorized withdrawal of ERC1155 tokens @security @regression @dvp @erc1155', async function () {
      await (await erc1155.contract.depositIntoDvp(ERC1155_ID, ERC1155_AMOUNT, '0x')).wait(2);

      await expect(
        erc1155.contract.connect(signerNotOwner).withdrawFromDvp(ERC1155_ID, ERC1155_AMOUNT, '0x')
      ).to.be.revertedWith('Not enough tokens locked in Dvp');
    }).timeout(15 * 60 * 1000);
  });
});
