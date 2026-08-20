import hre from 'hardhat';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import {
  EndpointV1,
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
  EnygmaV1,
  DvpTeleport,
} from '../../../../typechain-types';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { DEFAULT_TIMEOUT, LOGGER } from '../../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { eventually } from '../../../../src/utils/common';
import { shortHex } from '../../../../src/utils/formatters';
import { TransactionBuilder } from '../../../test-utils/transaction-builder';
import { TransactionSender } from '../../../test-utils/transaction-sender';

describe('Enygma Dvp multi-operation batch test', function () {
  this.timeout(30 * 60 * 1000)
  let privacyNodes: PrivacyNodeMap;

  let privateHub : PrivateHub;
  let dvpTeleport: DvpTeleport;
  let tokenOnPNA: EnygmaWrapper<ProductionEnygmaToken>;
  let endpointB: EndpointV1;
  let tokenOnPNB: ProductionEnygmaToken;

  let TxBuilder : TransactionBuilder;
  let TxSender = TransactionSender;
  let tokenAddressA: string;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const {initializedNodes, initializedPNH} = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes
    privateHub = initializedPNH;

    tokenOnPNA = new EnygmaWrapper(privacyNodes.A, ProductionEnygmaToken__factory);

    // New token-registry flow: node-factory deploy as user (seeded codehash clears the
    // programmability gate), then PN-authorize + hub-activate (the Enygma override also rebinds
    // the PNH-side EnygmaV1 by resourceId, which the DVP path relies on).
    await tokenOnPNA.deployViaFactory();
    await tokenOnPNA.activateOnPn();
    await tokenOnPNA.activateOnHub(privateHub);
    tokenAddressA = tokenOnPNA.address[privacyNodes.A.chainId];
    dvpTeleport = privateHub.getContract<DvpTeleport>('DvpTeleport');
    endpointB = privacyNodes.B.getEndpointV1();
  });

  it("Should send multi-operation enygma transactions in one batch", async function () {
    // Send the initial transaction (to deploy on PN B)
    LOGGER.info(`Sending initial transaction...`);

    const initialBlockNumber = await privateHub.provider.getBlockNumber();
    const initialBalance = await tokenOnPNA.contract.balanceOf(tokenOnPNA.userWallet.address)
    const initialNonce = await privacyNodes.A.provider.getTransactionCount(tokenOnPNA.userWallet.address);

    const txCount = 10;
    const mintAmount = 1000;
    const burnAmount = 1;
    const transferAmount = 1;
    const depositAmount = 10;
    const withdrawAmount = 10;

    const mintNonce = initialNonce;
    const burnNonce = mintNonce + txCount;
    const transferNonce = burnNonce + txCount;
    const depositNonce = transferNonce + txCount;
    const withdrawNonce = depositNonce + txCount;

    TxBuilder = new TransactionBuilder(ProductionEnygmaToken__factory.abi,tokenAddressA,
      tokenOnPNA.userWallet.privateKey, Number(privacyNodes.A.chainId));

    const mints = await TxBuilder.signBatch(txCount, "mint",[tokenOnPNA.userWallet.address, mintAmount], mintNonce);
    const burns = await TxBuilder.signBatch(txCount, "burn", [tokenOnPNA.userWallet.address, burnAmount], burnNonce);
    const transfers = await TxBuilder.signBatch(txCount,"crossTransfer",[[tokenOnPNA.userWallet.address], [transferAmount], [privacyNodes.B.chainId], [[]]], transferNonce);
    const deposits = await TxBuilder.signBatch(txCount, "depositToDvp",[depositAmount], depositNonce);
    const withdraws = await TxBuilder.signBatch(txCount, "callWithdrawFromDvp",[withdrawAmount], withdrawNonce);

    await Promise.all([
      TxSender.sendBatchRawTransactions(mints,privacyNodes.A.rpcUrl,"Mints"),
    TxSender.sendBatchRawTransactions(burns,privacyNodes.A.rpcUrl,"Burns"),
    TxSender.sendBatchRawTransactions(transfers,privacyNodes.A.rpcUrl,"Transfers"),
    TxSender.sendBatchRawTransactions(deposits,privacyNodes.A.rpcUrl,"Deposits"),
    TxSender.sendBatchRawTransactions(withdraws,privacyNodes.A.rpcUrl,"Withdraws")])

    const totalMint = mintAmount * txCount;
    const totalBurn = burnAmount * txCount;
    const totalDeposit = depositAmount * txCount;
    const totalTransfer = transferAmount * txCount;
    const totalWithdraw = withdrawAmount * txCount;
    const change = totalMint - totalBurn - totalDeposit - totalTransfer;
    LOGGER.info(`totalMint: ${totalMint}, totalBurn: ${totalBurn}, totalDeposit: ${totalDeposit}, totalTransfer: ${totalTransfer}, totalWithdraw: ${totalWithdraw}`);

    try {
      LOGGER.info(`Waiting for transactions on PN A to be executed...`);
      await eventually<boolean>({
        check: async (): Promise<boolean> => {
          const balanceOnPnA = await tokenOnPNA.contract.balanceOf(tokenOnPNA.userWallet.address);
          return balanceOnPnA == BigInt(initialBalance) + BigInt(change);
        },
        interval: 1000,
        attempts: 300,
        message: `Waiting for DVP MultiOp PN A balance → ${BigInt(initialBalance) + BigInt(change)} for ${shortHex(tokenOnPNA.userWallet.address)} (${txCount} txs)`,
        tolerateErrors: true,
      });

      LOGGER.info(`Waiting for token on PN B to be deployed...`);
      await eventually<boolean>({
        check: async (): Promise<boolean> => {
          // Try to get the token address on PN B
          const tokenOnPNBAddress = await endpointB.getAddressByResourceId(tokenOnPNA.resourceId);
          if (tokenOnPNBAddress == '0x0000000000000000000000000000000000000000') return false;

          tokenOnPNB = await hre.ethers.getContractAt('ProductionEnygmaToken', tokenOnPNBAddress, tokenOnPNA.userWallet.connect(privacyNodes.B.provider));

          const balanceOnPnBOne = await tokenOnPNB.balanceOf(tokenOnPNA.userWallet.address);

          return balanceOnPnBOne == BigInt(totalTransfer);
        },
        interval: 1000,
        attempts: 300,
        message: `Waiting for DVP MultiOp PN B balance → ${totalTransfer} for ${shortHex(tokenOnPNA.userWallet.address)} (rid=${shortHex(tokenOnPNA.resourceId)})`,
        tolerateErrors: true,
      });

      LOGGER.info(`Waiting for token to be deposited...`);
      // Get the EnygmaV1 contract address on private hub for event filtering
      const enygmaAddressOnCC = privateHub
        .getPNHContract<EnygmaV1>(tokenOnPNA.symbol)

      await eventually<boolean>({
        check: async (): Promise<boolean> => {
          const commitmentsFilter = dvpTeleport.filters.Commitments(enygmaAddressOnCC);
          const currentBlockNumber = await privateHub.provider.getBlockNumber();

          const logs = await dvpTeleport.queryFilter(
            commitmentsFilter,
            Math.max(0, initialBlockNumber - 10),
            currentBlockNumber
          );

          // Count commitment events since we started
          // Event signature: Commitments(address indexed tokenAddress, uint256 tokenType, uint256 indexed treeNumber, uint256[] commitments)
          // args[0] = tokenAddress, args[1] = tokenType, args[2] = treeNumber, args[3] = commitments
          const relevantCommitments = logs.filter((log: any) => {
            return log.args && log.args[3] && log.args[3].length > 0;
          });

          // Sum the number of commitments across all events (each event can include multiple commitments)
          const depositsCompletedByEvents = relevantCommitments.reduce((sum: number, log: any) => {
            const commitments = Array.isArray(log.args[3]) ? log.args[3] : [];
            return sum + commitments.length;
          }, 0);

          LOGGER.info(`Confirmed deposits: ${depositsCompletedByEvents}/${txCount}`);
          return depositsCompletedByEvents == txCount;
        },
        interval: 1000,
        attempts: 300,
        message: `Waiting for DvpTeleport Commitments → ${txCount} deposits`,
      });

      LOGGER.info(`Waiting for token to be withdrawn...`);
      await eventually<boolean>({
        check: async (): Promise<boolean> => {
          const balanceOnPnA = await tokenOnPNA.contract.balanceOf(tokenOnPNA.userWallet.address);
          const withdrawn = balanceOnPnA - BigInt(initialBalance) - BigInt(change);
          const withdrawalCount = Number(withdrawn) / withdrawAmount;
          LOGGER.info(`Confirmed withdrawals: ${withdrawalCount}/${txCount}`);
          return withdrawn == BigInt(totalWithdraw);
        },
        interval: 1000,
        attempts: 300,
        message: `Waiting for DVP MultiOp withdrawn → ${totalWithdraw} on PN A for ${shortHex(tokenOnPNA.userWallet.address)}`,
      });

    } catch (error) {
      LOGGER.error(`${error}`);
      throw error;
    }
  });
});
