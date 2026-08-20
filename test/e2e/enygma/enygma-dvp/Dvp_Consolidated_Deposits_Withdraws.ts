import { expect } from 'chai';
import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
  ProductionErc1155Dvp,
  ProductionErc1155Dvp__factory,
} from '../../../../typechain-types';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { eventually } from '../../../../src/utils/common';
import { shortHex } from '../../../../src/utils/formatters';
import { ERC1155Wrapper } from '../../../../src/entities/tokens/ERC1155Wrapper';
import { DEFAULT_TIMEOUT, LOGGER, SECOND } from '../../../../src/config/env-config';
import { waitForNumberOfBlocks } from '../../../../src/utils/network-utils';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';

describe('Dvp Consolidated Deposits and Withdraws', function () {
  const MINT_AMOUNT = BigInt(1000);
  const DEPOSIT_AMOUNT = BigInt(50);
  const ERC1155_ID = 1n;

  // Privacy Ledger setup
  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;

  before(async function () {
    const {initializedNodes,
      initializedPNH} = await initializePrivacyNodesAndPnh(1);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;
  });

  describe('Enygma Token Tests', function () {
    let enygmaToken: EnygmaWrapper<ProductionEnygmaToken>;

    beforeEach(async function () {
      this.timeout(DEFAULT_TIMEOUT*2);
      enygmaToken = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);
      const signerAddress = await enygmaToken.userWallet.getAddress();
      await enygmaToken.deployViaFactory();
      await enygmaToken.activateOnPn();
      await enygmaToken.activateOnHub(privateHub);
      await enygmaToken.mintAndAwait(privateHub, { amount: MINT_AMOUNT, toAddress: signerAddress });
    });

    it('should deposit & withdraw single amount from Dvp @smoke @dvp', async function () {
      // Setup: Deposit first
      await enygmaToken.depositEnygmaToDvp(
        DEPOSIT_AMOUNT,
        MINT_AMOUNT - DEPOSIT_AMOUNT,
        privateHub,
      );

      // Test: Withdraw
      await enygmaToken.withdrawEnygmaFromDvp(DEPOSIT_AMOUNT, privateHub);
    }).timeout(DEFAULT_TIMEOUT);

    it('should handle multiple deposits @regression @dvp @enygma', async function () {
      const numberOfDeposits = 2;

      // Deposit multiple times
      for (let i = 1; i <= numberOfDeposits; i++) {
        await enygmaToken.depositEnygmaToDvp(
          DEPOSIT_AMOUNT,
          BigInt(MINT_AMOUNT) - BigInt(DEPOSIT_AMOUNT) * BigInt(i),
          privateHub,
        );
      }
      await waitForNumberOfBlocks(3, privateHub.provider);

      // Withdraw total amount
      await enygmaToken.withdrawEnygmaFromDvp(
        BigInt(DEPOSIT_AMOUNT) * BigInt(numberOfDeposits),
        privateHub,
      );
    }).timeout(DEFAULT_TIMEOUT);

    it('should handle consolidation behavior with 11+ deposits @regression @dvp @enygma', async function () {
      const numberOfDeposits = 11;

        for (let i = 1; i <= numberOfDeposits; i++) {
          await enygmaToken.depositEnygmaToDvp(
            DEPOSIT_AMOUNT,
            BigInt(MINT_AMOUNT) - BigInt(DEPOSIT_AMOUNT) * BigInt(i),
            privateHub,
          );
        }

      // Withdraw total amount
      await enygmaToken.withdrawEnygmaFromDvp(
        BigInt(DEPOSIT_AMOUNT) * BigInt(10),
        privateHub,
      );

      await enygmaToken.withdrawEnygmaFromDvp(DEPOSIT_AMOUNT, privateHub);
    }).timeout(8 * 60 * 1000); // Increased timeout to 8 minutes

    it('should handle heavy consolidation with 22+ deposits @regression @dvp @enygma', async function () {
      const numberOfDeposits = 22;
      const depositAmount = BigInt(10);
      const totalMintAmount = BigInt(1000);

      // Deposit 22 times to trigger heavy consolidation
      for (let i = 1; i <= numberOfDeposits; i++) {
        await enygmaToken.depositEnygmaToDvp(
          depositAmount,
          BigInt(totalMintAmount )- BigInt(depositAmount) * BigInt(i),
          privateHub,
        );
      }

      await waitForNumberOfBlocks(3, privateHub.provider);

      // Withdraw all at once
      await enygmaToken.withdrawEnygmaFromDvp(
        BigInt(depositAmount) * BigInt(numberOfDeposits),
        privateHub,
      );
    }).timeout(20*60*1000); // Increased timeout to 20 minutes for heavy consolidation

    it('should handle partial withdrawals with change @regression @dvp @enygma', async function () {
      const totalDeposits = 3;
      let totalDepositAmount = BigInt(0);

      // Variable deposits (25, 50, 75)
      for (let i = 1; i <= totalDeposits; i++) {
        const variableDepositAmount = BigInt(25) * BigInt(i);
        totalDepositAmount += variableDepositAmount;

        await enygmaToken.depositEnygmaToDvp(
          variableDepositAmount,
          MINT_AMOUNT - totalDepositAmount,
          privateHub,
        );
      }

      // Partial withdrawal (130 out of 150)
      const partialWithdrawAmount = BigInt(130);
      const changeAmount = totalDepositAmount - partialWithdrawAmount;

      await waitForNumberOfBlocks(3, privateHub.provider);

      await enygmaToken.withdrawEnygmaFromDvp(
        partialWithdrawAmount,
        privateHub,
      );

      await waitForNumberOfBlocks(3, privateHub.provider);

      // Withdraw remaining change
      await enygmaToken.withdrawEnygmaFromDvp(changeAmount, privateHub);
    }).timeout(DEFAULT_TIMEOUT*2);
  });

  describe('ERC1155 Tests', function () {
    let erc1155: ERC1155Wrapper<ProductionErc1155Dvp>;

    beforeEach(async function () {
      this.timeout(DEFAULT_TIMEOUT);
      erc1155 = new ERC1155Wrapper(privacyNodes.A, ProductionErc1155Dvp__factory);
      await erc1155.deploy();
      await erc1155.activateOnPn();
      await erc1155.activateOnHub(privateHub);
      await erc1155.mintAndAwait(privateHub, { toAddress: erc1155.userWallet.address, tokenId: ERC1155_ID, amount: MINT_AMOUNT });
    });

    it('should withdraw ERC1155 tokens from Dvp @smoke @dvp @erc1155', async function () {
      LOGGER.optionalLog(`Starting ERC1155 deposit & withdraw test`);

      // Setup: Deposit first
      LOGGER.optionalLog(`Depositing ${DEPOSIT_AMOUNT} ERC1155 tokens into Dvp...`);
      await erc1155.depositNftToDvp(privateHub, ERC1155_ID, DEPOSIT_AMOUNT);
      await waitForNumberOfBlocks(3, privateHub.provider);
      LOGGER.optionalLog(`ERC1155 deposit transaction confirmed`);

      // Test: Withdraw
      LOGGER.optionalLog(`Withdrawing ${DEPOSIT_AMOUNT} ERC1155 tokens from Dvp...`);
      await erc1155.withdrawNftFromDvp(privateHub, ERC1155_ID, DEPOSIT_AMOUNT, erc1155.userWallet.address);
      await waitForNumberOfBlocks(3, privateHub.provider);
      LOGGER.optionalLog(`ERC1155 withdrawal transaction confirmed`);

      // Verify withdrawal — relayer round-trip (PL→CC→PL unlockFromDvp) needs extra time
      await eventually<boolean>({
        check: async () => {
          const locked = await erc1155.contract.lockedForDvp(erc1155.userWallet.address, ERC1155_ID);
          LOGGER.optionalLog(`[POLL] lockedForDvp=${locked} (expected=0)`);
          return locked === 0n;
        },
        interval: SECOND,
        attempts: (DEFAULT_TIMEOUT * 2) / SECOND,
        message: `Waiting for #${ERC1155_ID} lockedForDvp → 0 for ${shortHex(erc1155.userWallet.address)}`,
      });
      LOGGER.optionalLog(`ERC1155 deposit & withdraw test completed successfully`);
    }).timeout(DEFAULT_TIMEOUT * 2);

    it('should handle ERC1155 partial withdrawals with change @regression @dvp @erc1155', async function () {
      const totalDepositAmount = 100n;
      const withdrawAmount = 70n;
      const changeAmount = totalDepositAmount - withdrawAmount;

      LOGGER.optionalLog(`Starting ERC1155 partial withdrawal test`);
      LOGGER.optionalLog(`Total deposit: ${totalDepositAmount}, Withdraw: ${withdrawAmount}, Expected change: ${changeAmount}`);

      // Deposit total amount
      LOGGER.optionalLog(`Depositing ${totalDepositAmount} ERC1155 tokens into Dvp...`);
      await erc1155.depositNftToDvp(privateHub, ERC1155_ID, totalDepositAmount);
      await waitForNumberOfBlocks(3, privateHub.provider);
      LOGGER.optionalLog(`ERC1155 deposit transaction confirmed`);

      // Partial withdrawal
      LOGGER.optionalLog(`Performing partial withdrawal of ${withdrawAmount} ERC1155 tokens...`);
      await erc1155.withdrawNftFromDvp(privateHub, ERC1155_ID, withdrawAmount, erc1155.userWallet.address);
      await waitForNumberOfBlocks(3, privateHub.provider);
      LOGGER.optionalLog(`Partial withdrawal transaction confirmed`);

      // Verify partial withdrawal
      await eventually<boolean>({
        check: async (): Promise<boolean> => {
          const lb = await erc1155.contract.lockedForDvp(erc1155.userWallet.address, ERC1155_ID);
          LOGGER.optionalLog(`Locked balance after partial withdrawal: ${lb} (expected: ${changeAmount})`);
          return lb === BigInt(changeAmount);
        },
        interval: 1000,
        attempts: 300,
        message: `Waiting for #${ERC1155_ID} lockedForDvp → ${changeAmount} (partial withdraw ${withdrawAmount})`,
      });
      const lockedBalance2 = await erc1155.contract.lockedForDvp(erc1155.userWallet.address, ERC1155_ID);
      expect(lockedBalance2).to.equal(BigInt(changeAmount));

      // const erc1155Cc = await privateHub.getToken<DvpErc1155CC>("DvpErc1155CC",erc1155.resourceId,erc1155.symbol + 'CC');
      //
      // await eventually<boolean>({
      //   check: async (): Promise<boolean> => {
      //     const bal = await erc1155Cc.balanceOf(privateHub.dvpAddress, ERC1155_ID);
      //     LOGGER.optionalLog(`Dvp balance after partial withdrawal: ${bal} (expected: ${changeAmount})`);
      //     return bal === BigInt(changeAmount);
      //   },
      //   interval: 1000,
      //   attempts: 300,
      // });
      // const dvpBalance = await erc1155Cc.balanceOf(privateHub.dvpAddress, ERC1155_ID);
      // expect(dvpBalance).to.equal(BigInt(changeAmount));

      // Withdraw remaining change
      LOGGER.optionalLog(`Withdrawing remaining change of ${changeAmount} ERC1155 tokens...`);
      await erc1155.withdrawNftFromDvp(privateHub, ERC1155_ID, changeAmount, erc1155.userWallet.address);
      await waitForNumberOfBlocks(3, privateHub.provider);
      LOGGER.optionalLog(`Change withdrawal transaction confirmed`);

      // Verify complete withdrawal
      await eventually<boolean>({
        check: async (): Promise<boolean> => {
          const finalLockedBalance = await erc1155.contract.lockedForDvp(erc1155.userWallet.address, ERC1155_ID);
          LOGGER.optionalLog(`Final locked balance: ${finalLockedBalance} (expected: 0)`);
          return finalLockedBalance === BigInt(0);
        },
        interval: 1000,
        attempts: 300,
        message: `Waiting for #${ERC1155_ID} lockedForDvp → 0 (change ${changeAmount})`,
      });
      const finalLockedBalance = await erc1155.contract.lockedForDvp(erc1155.userWallet.address, ERC1155_ID);
      expect(finalLockedBalance).to.equal(BigInt(0));

      // await eventually<boolean>({
      //   check: async (): Promise<boolean> => {
      //     const finalDvpBalance = await erc1155Cc.balanceOf(privateHub.dvpAddress, ERC1155_ID);
      //     LOGGER.optionalLog(`Final Dvp balance: ${finalDvpBalance} (expected: 0)`);
      //     return finalDvpBalance === BigInt(0);
      //   },
      //   interval: 1000,
      //   attempts: 300,
      // });
      // const finalDvpBalance = await erc1155Cc.balanceOf(privateHub.dvpAddress, ERC1155_ID);
      // expect(finalDvpBalance).to.equal(BigInt(0));
      LOGGER.optionalLog(`ERC1155 partial withdrawal test completed successfully`);
    }).timeout(DEFAULT_TIMEOUT);
  });
});
