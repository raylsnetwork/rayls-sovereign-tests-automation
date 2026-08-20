import { BaseContract } from 'ethers';
import { EnygmaTokenExample } from '../../../typechain-types';
import { PrivateHub } from '../../entities/PrivateHub';
import { PrivacyNode } from '../../entities/PrivacyNode';
import { LOGGER } from '../../config/env-config';
import { EnygmaWrapper } from '../../entities/tokens/EnygmaWrapper';
import { EnygmaCrossTransfer, EnygmaLinearTransfer } from '../../types';
import { eventually, submitTx } from '../../utils/common';
import { shortHex } from '../../utils/formatters';

export async function shouldCrossTransferEnygma(
  transfer: EnygmaCrossTransfer,
  transferNumber: number,
  expectedBalances: { [chainId: string]: bigint },
  privateHub: PrivateHub,
  source: PrivacyNode,
  destinations: PrivacyNode[],
  enygma: EnygmaWrapper<BaseContract>,
) {
    // Initialize any uninitialized destination nodes
    for (const destination of destinations) {
      if (!destination.endpointAddress) {
        await destination.initialize();
      }
    }

    LOGGER.data(`Transfering ${transfer.amounts} tokens to ${transfer.destinationAddresses} on ${transfer.destinationChainIds}...`);
    await submitTx(
      () => source
        .getContract<EnygmaTokenExample>(enygma.symbol)
        .crossTransfer(
          transfer.destinationAddresses,
          transfer.amounts,
          transfer.destinationChainIds,
          transfer.programData,
          { gasLimit: 5000000 }
        ),
      `Transferring to destination (Transfer #${transferNumber})`
    );

    for (const destination of destinations) {
      await enygma.waitForDeploymentOnNode(destination);

      await eventually<boolean>({
        check: async () => {
          const balance = await destination
            .getContract<EnygmaTokenExample>(enygma.symbol)
            .balanceOf(await enygma.userWallet.getAddress());

          return BigInt(expectedBalances[destination.chainId]) === balance;
        },
        message: `Waiting for ${enygma.symbol} balance → ${expectedBalances[destination.chainId]} on chain ${destination.chainId}`,
      });
    }
}


export async function linearTransferEnygma(
  transfer: EnygmaLinearTransfer,
  transferNumber: number,
  expectedBalance: bigint,
  privateHub: PrivateHub,
  source: PrivacyNode,
  destination: PrivacyNode,
  enygma: EnygmaWrapper<BaseContract>,
) {

  LOGGER.data(`Transfering ${transfer.amount} tokens to ${transfer.destinationAddress} on ${transfer.destinationChainId}...`);
  const receipt = await submitTx(
    () => source
      .getContract<EnygmaTokenExample>(enygma.symbol)
      .linearCrossTransfer(
        transfer.destinationAddress,
        transfer.amount,
        transfer.destinationChainId,
        transfer.programData,
        { gasLimit: 5000000 }
      ),
    `Transferring to destination (Transfer #${transferNumber})`
  );

    await enygma.waitForDeploymentOnNode(destination);

    await eventually<boolean>({
      check: async () => {
        const balance = await destination
          .getContract<EnygmaTokenExample>(enygma.symbol)
          .balanceOf(await enygma.userWallet.getAddress());

        return BigInt(expectedBalance) === balance;
      },
      message: `Waiting for ${enygma.symbol} balance → ${expectedBalance} for ${shortHex(transfer.destinationAddress)} on chain ${destination.chainId}`,
    });

    return receipt;
}