/**
 * @deprecated Decommissioning Teleport (vanilla, atomic).
 */
import { ethers } from 'ethers';
import { expect } from 'chai';
import {
  EndpointV1,
  PublicChainERC20,
  PublicChainERC20__factory,
  ProductionErc20Token,
  ProductionErc20Token__factory,
} from '../../typechain-types';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER, ZERO_ADDRESS, PUBLIC_CHAIN_RPC_URL} from '../../src/config/env-config';
import { PrivateHub } from '../../src/entities/PrivateHub';
import { ERC20Wrapper } from '../../src/entities/tokens/ERC20Wrapper';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../setup';
import { eventually, sendTx, submitTx } from '../../src/utils/common';
import { shortHex } from '../../src/utils/formatters';
import { getProvider } from '../../src/utils/network-utils';

describe('E2E Tests: Erc20 Private to Public Chain @decommissioned', function () {
  const INITIAL_AMOUNT = 1000n;
  const TRANSFER_A_TO_B = 500;
  const TRANSFER_B_TO_PUBLIC = 200;
  const PUBLIC_CHAIN_ID = process.env.PUBLIC_CHAIN_ID || '7331';

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let token: ERC20Wrapper<ProductionErc20Token>;
  let tokenOnB: ERC20Wrapper<ProductionErc20Token>;

  let user: {
    userId: string;
    publicAddress: string;
    privateAddress: string;
    publicPrivateKey: string;
    privatePrivateKey: string;
  };

  const calculateBalance = async () => ({
    A: {
      userWallet: await privacyNodes.A.getContract<ProductionErc20Token>(token.symbol).balanceOf(
        token.userWallet.address
      )
    },
    B: {
      userWallet: await privacyNodes.B.getContract<ProductionErc20Token>(token.symbol).balanceOf(
        token.userWallet.address
      ),
      user: token.address[privacyNodes.B.chainId] && user
        ? await privacyNodes.B.getContract<ProductionErc20Token>(token.symbol).balanceOf(user.privateAddress)
        : BigInt(0)
    }
  });

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privateHub = initializedPNH;
    privacyNodes = initializedNodes;
    token = new ERC20Wrapper(privacyNodes.A, ProductionErc20Token__factory);

    LOGGER.info('Starting ERC20 Private to Public Chain E2E Test');

    // Flow #1 (hub) on A, non-factory: constructor-deploy the production token (userWallet = owner),
    // register + authorize on the PN registry, then submit to the hub + operator-approve so the
    // token is hub-active and can teleport A→B.
    await token.deploy();
    await token.activateOnPn(); // PN authorization — shared prerequisite
    await token.activateOnHub(privateHub);  // hub leg → hub-active, can teleport A→B
    await token.mintAndAwait(privateHub, { toAddress: token.userWallet.address, amount: INITIAL_AMOUNT });
  });

  it('Should deploy and hub-activate token on A', async function () {
    // Flow #1 hub activation happens in `before`; assert the issuer instance was deployed.
    expect(token.address[privacyNodes.A.chainId]).to.not.equal(ZERO_ADDRESS);
  }).timeout(DEFAULT_TIMEOUT);

  it('Should teleport tokens from A to B', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    LOGGER.info('Teleporting tokens from A to B...');

    await submitTx(
      () => token.contract.teleport(
        token.userWallet.address,
        TRANSFER_A_TO_B,
        privacyNodes.B.chainId,
        { gasLimit: GAS_LIMIT }
      ),
      `Teleporting ${TRANSFER_A_TO_B} to ${privacyNodes.B.chainId}...`
    );

    // Wait for automatic contract deployment on B
    await eventually<boolean>({
      check: async () => {
        const tokenAddress = await privacyNodes.B.getContract<EndpointV1>('EndpointV1')
          .getAddressByResourceId(token.resourceId);

        if (tokenAddress === ZERO_ADDRESS) return false;

        token.address[privacyNodes.B.chainId] = tokenAddress;
        await privacyNodes.B.getContractAt('ProductionErc20Token', tokenAddress, token.symbol);

        return true;
      },
      message: `Checking contract deployed on chain ${privacyNodes.B.chainId}`,
    });

    // Verify balances
    await eventually<boolean>({
      check: async () => {
        const balance = await calculateBalance();
        return balance.B.userWallet === BigInt(TRANSFER_A_TO_B);
      },
      message: `Checking balance on B`,
    });

    const balance = await calculateBalance();
    LOGGER.info(`Tokens transferred: A balance = ${balance.A.userWallet}, B balance = ${balance.B.userWallet}`);
  }).timeout(DEFAULT_TIMEOUT);

  it('Should setup user and transfer tokens to user on B', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    // PRIVACY_NODE_OPERATOR: createUser, approveUser. BANK_EMPLOYEE: addAddressPair.
    const userGovAsOperator = await privacyNodes.B.getUserGovernance();
    const userGovAsBankEmployee = await privacyNodes.B.getContractAt(
      'RNUserGovernanceV1', privacyNodes.B.raylsNodeUserGovernance,
      'RNUserGovernanceV1', privacyNodes.B.bankEmployeeWallet,
    ) as any;

    const userId = ethers.keccak256(ethers.randomBytes(32));
    const publicWallet = ethers.Wallet.createRandom();
    const privateWallet = ethers.Wallet.createRandom();

    LOGGER.info('Creating user with public/private address pairs...');
    await sendTx(() => userGovAsOperator.createUser(userId), 'createUser');
    await sendTx(
      () => userGovAsBankEmployee.addAddressPair(userId, publicWallet.address, privateWallet.address),
      'addAddressPair'
    );

    user = {
      userId,
      publicAddress: publicWallet.address,
      privateAddress: privateWallet.address,
      publicPrivateKey: publicWallet.privateKey,
      privatePrivateKey: privateWallet.privateKey,
    };

    LOGGER.info('Approving user...');
    await sendTx(() => userGovAsOperator.approveUser(userId), 'approveUser');

    // Transfer tokens from userWallet (who received the teleport) to user's private address
    LOGGER.info(`Transferring ${TRANSFER_B_TO_PUBLIC} tokens to user on B...`);
    const userOnB = token.userWallet.connect(privacyNodes.B.provider);
    const transferTx = await privacyNodes.B.getContract<ProductionErc20Token>(token.symbol)
      .connect(userOnB)
      .transfer(
        user.privateAddress,
        TRANSFER_B_TO_PUBLIC,
        { gasLimit: GAS_LIMIT }
      );
    await transferTx.wait();

    const userBalance = await privacyNodes.B.getContract<ProductionErc20Token>(token.symbol).balanceOf(user.privateAddress);
    expect(userBalance).to.equal(BigInt(TRANSFER_B_TO_PUBLIC));
    LOGGER.info(`User balance on B: ${userBalance}`);
  }).timeout(DEFAULT_TIMEOUT);

  it('Should register and activate token on PN registry (public-chain flow) on B', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    tokenOnB = await token.forNode(privacyNodes.B);

    // B is already PN-AUTHORIZED via the hub activateToken callback (it received the A→B teleport),
    // so it must NOT call activateOnPn() — just run the public-chain leg. activateOnPublicChain()
    // does submitToPublicChain internally, so no separate submit call is needed.
    LOGGER.info('Activating token on public chain (B)...');
    const publicTokenAddress = await tokenOnB.activateOnPublicChain();
    LOGGER.info(`Token activated on public chain at: ${publicTokenAddress}`);
  }).timeout(DEFAULT_TIMEOUT);

  it('Should transfer tokens from B to public chain', async function () {
    this.timeout(DEFAULT_TIMEOUT * 2);

    LOGGER.info('Starting transfer from B to public chain...');
    const publicTokenAddress = await tokenOnB.getPublicAddress();

    // Send tokens from user's private wallet on B to public chain
    LOGGER.info('Sending tokens to public chain...');
    const userSigner = new ethers.Wallet(user.privatePrivateKey, privacyNodes.B.provider);
    await sendTx(
      () => privacyNodes.B.getContract<ProductionErc20Token>(token.symbol)
        .connect(userSigner)
        .teleportToPublicChain(user.publicAddress, TRANSFER_B_TO_PUBLIC, PUBLIC_CHAIN_ID, { gasLimit: GAS_LIMIT }),
      'teleportToPublicChain'
    );
    LOGGER.info('Tokens sent to public chain');

    // Verify public chain balance
    LOGGER.info('Verifying balances...');
    const publicProvider = getProvider(PUBLIC_CHAIN_RPC_URL);
    const publicToken: PublicChainERC20 = PublicChainERC20__factory.connect(publicTokenAddress, publicProvider);

    await eventually<boolean>({
      check: async () => {
        const bal = await publicToken.balanceOf(user.publicAddress);
        return bal === BigInt(TRANSFER_B_TO_PUBLIC);
      },
      interval: 3000,
      attempts: 30,
      message: `Waiting for public balance → ${TRANSFER_B_TO_PUBLIC} for ${shortHex(user.publicAddress)}`,
    });
    LOGGER.info('Balance verification completed successfully!');
  }).timeout(DEFAULT_TIMEOUT * 2);
});
