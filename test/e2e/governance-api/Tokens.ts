import {
  ProductionEnygmaToken,
  ProductionEnygmaToken__factory,
  ProductionErc1155Token,
  ProductionErc1155Token__factory,
  ProductionErc721Token,
  ProductionErc721Token__factory,
  ProductionErc20Token,
  ProductionErc20Token__factory,
  TokenRegistryV1,
} from '../../../typechain-types';
import { expect } from 'chai';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { eventually, sendTx } from '../../../src/utils/common';
import { GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_SHORT, GOV_POLL_ATTEMPTS_LONG, GOV_POLL_ATTEMPTS_TX } from './governance-assertions';
import { TokenERCStandard, TokenStatus } from '../../../src/types';
import { ERC20Wrapper } from '../../../src/entities/tokens/ERC20Wrapper';
import { ERC721Wrapper } from '../../../src/entities/tokens/ERC721Wrapper';
import { ERC1155Wrapper } from '../../../src/entities/tokens/ERC1155Wrapper';
import { EnygmaWrapper } from '../../../src/entities/tokens/EnygmaWrapper';
import GovernanceController from '../../../src/api/GovernanceController';
import { DEFAULT_TIMEOUT, GAS_LIMIT, GOVERNANCE_API_URL } from '../../../src/config/env-config';

let response: any;
let tokensArray: any;

describe('E2E Tests: Tokens Deploy Flow -> Assert Governance API', function () {
  let privacyNodes: PrivacyNodeMap;
  const GovController = new GovernanceController(GOVERNANCE_API_URL);
  let privateHub : PrivateHub;

  let tokenERC20 : ERC20Wrapper<ProductionErc20Token>;
  let nft : ERC721Wrapper<ProductionErc721Token>;
  let tokenERC1155 : ERC1155Wrapper<ProductionErc1155Token>;
  let enygmaToken: EnygmaWrapper<ProductionEnygmaToken>;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const {initializedNodes, initializedPNH} = await initializePrivacyNodesAndPnh(4);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;
  });

  it('Should deploy, authorize and register ERC20 on PL-A and assert the response body for the token deployed @smoke', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    tokenERC20 = new ERC20Wrapper(privacyNodes.A, ProductionErc20Token__factory);
    await tokenERC20.deploy();
    await tokenERC20.activateOnPn();
    await tokenERC20.activateOnHub(privateHub);
    // ProductionErc20Token has no constructor premint → mint so the issuer chain appears in circulatingSupply.
    await tokenERC20.mintAndAwait(privateHub, { toAddress: tokenERC20.userWallet.address, amount: 2_000_000n * 10n ** 18n });

    await eventually<boolean>({
      check: async () => {
        response = await GovController.getTokens({ name: tokenERC20.name });
        tokensArray = response.data;
        const tok = tokensArray[0];
        return (
          tok?.status === TokenStatus.Active &&
          Array.isArray(tok?.circulatingSupply) &&
          tok.circulatingSupply.some(
            (cs: any) => cs.participantId === String(privacyNodes.A.chainId),
          )
        );
      },
      interval: GOV_POLL_INTERVAL_MS,
      attempts: GOV_POLL_ATTEMPTS_SHORT,
      message: `Waiting for Gov API ERC20 ${tokenERC20.name} → Active with circulatingSupply (chain=${privacyNodes.A.chainId})`,
    });

    const tokenObject = tokensArray[0];
    expect(String(tokenObject.issuerId)).to.equal(String(privacyNodes.A.chainId));
    expect(tokenObject.status).to.equal(TokenStatus.Active);
    expect(tokenObject.ercStandard).to.equal(TokenERCStandard.ERC20);
    expect(tokenObject.name).to.equal(tokenERC20.name);
    expect(tokenObject.symbol).to.equal(tokenERC20.symbol);

    // Issuer chain (A) must appear in circulatingSupply (ERC20 mints an initial supply on deploy)
    expect(tokenObject.circulatingSupply.map((cs: any) => cs.participantId))
      .to.include(String(privacyNodes.A.chainId));

  });

  it('Should deploy, authorize and register ERC721 on PL-B and assert the response body for the token deployed', async function () {
    this.timeout(DEFAULT_TIMEOUT);
    nft = new ERC721Wrapper(privacyNodes.B,ProductionErc721Token__factory);
    await nft.deploy();
    await nft.activateOnPn();
    await nft.activateOnHub(privateHub);

    await eventually<boolean>({
      check: async () => {
        response = await GovController.getTokens({ name: nft.name });
        tokensArray = response.data;
        return tokensArray[0]?.status === TokenStatus.Active;
      },
      interval: GOV_POLL_INTERVAL_MS,
      attempts: GOV_POLL_ATTEMPTS_SHORT,
      message: `Waiting for Gov API ERC721 ${nft.name} → Active`,
    });

    const tokenObject = tokensArray[0];
    expect(String(tokenObject.issuerId)).to.equal(String(privacyNodes.B.chainId));
    expect(tokenObject.status).to.equal(TokenStatus.Active);
    expect(tokenObject.ercStandard).to.equal(TokenERCStandard.ERC721);
    expect(tokenObject.name).to.equal(nft.name);
    expect(tokenObject.symbol).to.equal(nft.symbol);

    // ERC721 has no fungible supply — circulatingSupply is empty until tokens are minted/transferred
    expect(tokenObject.circulatingSupply).to.be.an('array');

  });

  it('Should deploy, authorize and register ERC1155 on PL-C and assert the response body for the token deployed', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    tokenERC1155 = new ERC1155Wrapper(privacyNodes.C,ProductionErc1155Token__factory);
    await tokenERC1155.deploy();
    await tokenERC1155.activateOnPn();
    await tokenERC1155.activateOnHub(privateHub);

    await eventually<boolean>({
      check: async () => {
        response = await GovController.getTokens({ name: tokenERC1155.name });
        tokensArray = response.data;
        return tokensArray[0]?.status === TokenStatus.Active;
      },
      interval: GOV_POLL_INTERVAL_MS,
      attempts: GOV_POLL_ATTEMPTS_SHORT,
      message: `Waiting for Gov API ERC1155 ${tokenERC1155.name} → Active`,
    });

    const tokenObject = tokensArray[0];
    expect(String(tokenObject.name)).to.equal(String(tokenERC1155.name));
    expect(String(tokenObject.issuerId)).to.equal(String(privacyNodes.C.chainId));
    expect(tokenObject.status).to.equal(TokenStatus.Active);
    expect(tokenObject.ercStandard).to.equal(TokenERCStandard.ERC1155);

    // ERC1155 has no initial supply — circulatingSupply is empty until tokens are minted/transferred
    expect(tokenObject.circulatingSupply).to.be.an('array');

  });

  it('Should deploy, authorize and register EnygmaToken on PL-D and assert the response body for the token deployed', async function () {
    this.timeout(DEFAULT_TIMEOUT);

    enygmaToken = new EnygmaWrapper(privacyNodes.D,ProductionEnygmaToken__factory);
    await enygmaToken.deployViaFactory();
    await enygmaToken.activateOnPn();
    await enygmaToken.activateOnHub(privateHub);

    await eventually<boolean>({
      check: async () => {
        response = await GovController.getTokens({ name: enygmaToken.name });
        tokensArray = response.data;
        return tokensArray[0]?.status === TokenStatus.Active;
      },
      interval: GOV_POLL_INTERVAL_MS,
      attempts: GOV_POLL_ATTEMPTS_SHORT,
      message: `Waiting for Gov API Enygma ${enygmaToken.name} → Active`,
    });

    const tokenObject = tokensArray[0];
    expect(String(tokenObject.issuerId)).to.equal(String(privacyNodes.D.chainId));
    expect(tokenObject.status).to.equal(TokenStatus.Active);
    expect(tokenObject.ercStandard).to.equal(TokenERCStandard.Enygma);
    expect(tokenObject.name).to.equal(enygmaToken.name);
    expect(tokenObject.symbol).to.equal(enygmaToken.symbol);

    // Enygma tokens have no initial mint, so circulatingSupply is empty until transfers occur
    expect(tokenObject.circulatingSupply).to.be.an('array');

  });
});

describe('E2E Tests: Tokens Freeze/Unfreeze Flow -> Assert Governance API', function () {
  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let tokenRegistry: TokenRegistryV1;
  let freezeTokenExample: ERC20Wrapper<ProductionErc20Token>;

  const GovController = new GovernanceController(GOVERNANCE_API_URL);

  let tokenRIDNormalized: string;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    tokenRegistry = await privateHub.getTokenRegistryAsCompliance();

    freezeTokenExample = new ERC20Wrapper(privacyNodes.A, ProductionErc20Token__factory);
    await freezeTokenExample.deploy();
    await freezeTokenExample.activateOnPn();
    await freezeTokenExample.activateOnHub(privateHub);

    tokenRIDNormalized = freezeTokenExample.resourceId.replace(/^0x/i, '')

    await eventually<boolean>({
      check: async () => {
        const response = await GovController.getTokens({ name: freezeTokenExample.name });
        return response.data[0]?.status === TokenStatus.Active;
      },
      interval: GOV_POLL_INTERVAL_MS,
      attempts: GOV_POLL_ATTEMPTS_LONG,
      message: `Waiting for Gov API freeze test token ${freezeTokenExample.name} → Active`,
    });
  });

  afterEach(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    const chainIds = [privacyNodes.A.chainId, privacyNodes.B.chainId];
    const frozenChainIds = (
      await Promise.all(chainIds.map(async (chainId) => (
        await tokenRegistry.isTokenFrozenForParticipant(freezeTokenExample.resourceId, chainId) ? chainId : null
      )))
    ).filter((chainId): chainId is string => chainId !== null);

    if (frozenChainIds.length > 0) {
      await sendTx(() => tokenRegistry.unfreezeToken(freezeTokenExample.resourceId, frozenChainIds, { gasLimit: GAS_LIMIT }), 'afterEach unfreeze');
    }
  });

  it('Should freeze token for one participant (A) and assert frozenChainIds contains only A', async function () {
    await sendTx(() => tokenRegistry.freezeToken(freezeTokenExample.resourceId, [privacyNodes.A.chainId], { gasLimit: GAS_LIMIT }), 'freeze A');

    const tokenById = await eventually({
      check: async () => {
        const token = await GovController.getTokenByResourceId(tokenRIDNormalized);
        return token.frozenChainIds?.length === 1 ? token : undefined;
      },
      interval: GOV_POLL_INTERVAL_MS,
      attempts: GOV_POLL_ATTEMPTS_TX,
      message: 'Waiting for frozenChainIds length=1 (getTokenByResourceId)',
    });

    expect(tokenById.frozenChainIds).to.have.lengthOf(1);
    expect(tokenById.frozenChainIds).to.include(String(privacyNodes.A.chainId));

    const tokenByName = await GovController.getTokens({ name: freezeTokenExample.name });
    expect(tokenByName.data[0]?.frozenChainIds).to.include(String(privacyNodes.A.chainId));
  }).timeout(15 * 60 * 1000);

  it('Should freeze token for two participants (A and B) and assert frozenChainIds contains A and B', async function () {
    await sendTx(() => tokenRegistry.freezeToken(freezeTokenExample.resourceId, [privacyNodes.A.chainId, privacyNodes.B.chainId], { gasLimit: GAS_LIMIT }), 'freeze A+B');

    const tokenById = await eventually({
      check: async () => {
        const token = await GovController.getTokenByResourceId(tokenRIDNormalized);
        return token.frozenChainIds?.length === 2 ? token : undefined;
      },
      interval: GOV_POLL_INTERVAL_MS,
      attempts: GOV_POLL_ATTEMPTS_TX,
      message: 'Waiting for frozenChainIds length=2 (getTokenByResourceId)',
    });

    expect(tokenById.frozenChainIds).to.have.lengthOf(2);
    expect(tokenById.frozenChainIds).to.include(String(privacyNodes.A.chainId));
    expect(tokenById.frozenChainIds).to.include(String(privacyNodes.B.chainId));

    const tokenByName = await GovController.getTokens({ name: freezeTokenExample.name });
    expect(tokenByName.data[0]?.frozenChainIds).to.include(String(privacyNodes.A.chainId));
    expect(tokenByName.data[0]?.frozenChainIds).to.include(String(privacyNodes.B.chainId));
  }).timeout(15 * 60 * 1000);

  it('Should freeze then unfreeze token for A and B, and assert frozenChainIds is empty', async function () {
    await sendTx(() => tokenRegistry.freezeToken(freezeTokenExample.resourceId, [privacyNodes.A.chainId, privacyNodes.B.chainId], { gasLimit: GAS_LIMIT }), 'freeze A+B');
    await sendTx(() => tokenRegistry.unfreezeToken(freezeTokenExample.resourceId, [privacyNodes.A.chainId, privacyNodes.B.chainId], { gasLimit: GAS_LIMIT }), 'unfreeze A+B');

    await eventually({
      check: async () => {
        const token = await GovController.getTokenByResourceId(tokenRIDNormalized);
        return token.frozenChainIds?.length === 0 ? token : undefined;
      },
      interval: GOV_POLL_INTERVAL_MS,
      attempts: GOV_POLL_ATTEMPTS_TX,
      message: 'Waiting for frozenChainIds empty (getTokenByResourceId)',
    });

    const tokenByName = await GovController.getTokens({ name: freezeTokenExample.name });
    expect(tokenByName.data[0]?.frozenChainIds).to.be.empty;
  }).timeout(15 * 60 * 1000);

  it('Should freeze token for A and B, unfreeze only A, and assert frozenChainIds contains only B', async function () {
    await sendTx(() => tokenRegistry.freezeToken(freezeTokenExample.resourceId, [privacyNodes.A.chainId, privacyNodes.B.chainId], { gasLimit: GAS_LIMIT }), 'freeze A+B');
    await sendTx(() => tokenRegistry.unfreezeToken(freezeTokenExample.resourceId, [privacyNodes.A.chainId], { gasLimit: GAS_LIMIT }), 'unfreeze A');

    const tokenById = await eventually({
      check: async () => {
        const token = await GovController.getTokenByResourceId(tokenRIDNormalized);
        return token.frozenChainIds?.length === 1 ? token : undefined;
      },
      interval: GOV_POLL_INTERVAL_MS,
      attempts: GOV_POLL_ATTEMPTS_TX,
      message: 'Waiting for frozenChainIds length=1 (getTokenByResourceId)',
    });

    expect(tokenById.frozenChainIds).to.have.lengthOf(1);
    expect(tokenById.frozenChainIds).to.include(String(privacyNodes.B.chainId));

    const tokenByName = await GovController.getTokens({ name: freezeTokenExample.name });
    expect(tokenByName.data[0]?.frozenChainIds).to.have.lengthOf(1);
    expect(tokenByName.data[0]?.frozenChainIds).to.include(String(privacyNodes.B.chainId));
  }).timeout(15 * 60 * 1000);
});
