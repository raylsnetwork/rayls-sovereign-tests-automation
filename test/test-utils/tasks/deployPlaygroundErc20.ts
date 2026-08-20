import { task } from 'hardhat/config';
import { LOGGER } from '../../../src/config/env-config';

export const genRanHex = (size: number) => [...Array(size)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');

task('deployPlaygroundErc20', 'Deploys Playground Erc20 on the PN')
  .addParam('pn', 'The Privacy Node identification (ex: A, B, C, D)')
  .addOptionalParam('name', 'Token Name')
  .addOptionalParam('symbol', 'symbol')
  .setAction(async (taskArgs, hre) => {
    await hre.run('compile');
    LOGGER.log(`Deploying token on ${taskArgs.pn}...`);
    const randString = genRanHex(6);
    taskArgs.name = taskArgs.name || `Playground Erc20 ${randString}`;
    taskArgs.symbol = taskArgs.symbol || `PgErc20_${randString}`;
    const rpcUrl = process.env[`PRIVACY_NODE_${taskArgs.pn}_RPC_URL`];
    const provider = new hre.ethers.JsonRpcProvider(rpcUrl);
    const wallet = new hre.ethers.Wallet(process.env['PRIVATE_KEY_SYSTEM'] as string);
    const signer = new hre.ethers.NonceManager(wallet.connect(provider));

    const token = await hre.ethers.getContractFactory('PlaygroundErc20', signer);

    // Pre-authorize the predicted contract address before deployment
    // Note: We need to predict the address AFTER the authorization tx, so nonce + 1
    const signerNonce = await provider.getTransactionCount(wallet.address);
    const predictedAddress = hre.ethers.getCreateAddress({ from: wallet.address, nonce: signerNonce + 1 });
    const endpointAddress = process.env[`PRIVACY_NODE_${taskArgs.pn}_ENDPOINT_ADDRESS`] as string;
    const endpoint = await hre.ethers.getContractAt('EndpointV1', endpointAddress, signer);
    const managerAddr = await endpoint.authority();
    const manager = await hre.ethers.getContractAt('RaylsAccessManagerV1', managerAddr, signer);
    const roleId = await manager.getRoleIdByName('ENDPOINT_SENDER');
    const authTx = await manager.grantRole(roleId, predictedAddress, 0);
    await authTx.wait();

    const tokenPN = await token.connect(signer).deploy(taskArgs.name, taskArgs.symbol, endpointAddress, process.env[`PRIVACY_NODE_${taskArgs.pn}_RAYLS_NODE_ENDPOINT_ADDRESS`] as string, process.env[`PRIVACY_NODE_${taskArgs.pn}_RAYLS_NODE_USER_GOVERNANCE`] as string, { gasLimit: 5000000 });

    await tokenPN.waitForDeployment();

    const tokenAddress = await tokenPN.getAddress();
    LOGGER.log(`Token Deployed At Address ${tokenAddress}`);

    // Register the token via the on-chain TokenRegistryReplica
    const deploymentProxyRegistryAddress = process.env[`PRIVACY_NODE_${taskArgs.pn}_DEPLOYMENT_PROXY_REGISTRY`] as string;
    const deploymentRegistry = await hre.ethers.getContractAt('DeploymentProxyRegistryV1', deploymentProxyRegistryAddress, signer);
    const registrarAddr = await deploymentRegistry.getContract('TokenRegistryReplica');
    const registrar = await hre.ethers.getContractAt('TokenRegistryReplicaV1', registrarAddr, signer);
    await (await registrar.registerToken(tokenAddress, 1, false, { gasLimit: 5000000 })).wait();

    LOGGER.log(`Token Registration Submitted, wait until relayer retrieves the generated resource`);
    LOGGER.log('');
    LOGGER.log("To check if it's registered, please use the following command:");
    LOGGER.log(`\$ npx hardhat checkTokenResourceId --pn ${taskArgs.pn} --token-address ${await tokenPN.getAddress()}`);

    return tokenPN;
  });