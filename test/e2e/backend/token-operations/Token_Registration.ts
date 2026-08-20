import { OperatorController, UserController } from '../../../../src/api';
import {
  BACKEND_OPS_URL,
  BACKEND_OPERATOR_AUTH_KEY,
  BACKEND_USER_AUTH_KEY, LOGGER,
} from '../../../../src/config/env-config';
import { registerToken, updateTokenStatus } from '../../../../src/flows/backend/token-operations';
import { assert } from 'chai';
import { TokenStatus } from '../../../../src/enums/TokenStatus';
import { ERC721Wrapper } from '../../../../src/entities/tokens/ERC721Wrapper';
import { ERC1155Wrapper } from '../../../../src/entities/tokens/ERC1155Wrapper';
import {
  ProductionErc1155Token, ProductionErc1155Token__factory,
  ProductionErc721Token, ProductionErc721Token__factory,
  ProductionErc20Token,
  ProductionErc20Token__factory,
  ProductionEnygmaToken, ProductionEnygmaToken__factory,
} from '../../../../typechain-types';
import { ERC20Wrapper } from '../../../../src/entities/tokens/ERC20Wrapper';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { PrivacyNode } from '../../../../src/entities/PrivacyNode';
import {
  BackendTokenContext,
  DeployableTokenWrapper,
  setupBackendTokenContext,
} from './setup-token-context';

const tokenClasses: Array<{
  name: string;
  build: (node: PrivacyNode) => DeployableTokenWrapper;
}> = [
  { name: 'ERC20Wrapper',  build: (n) => new ERC20Wrapper<ProductionErc20Token>(n, ProductionErc20Token__factory) },
  { name: 'ERC721Wrapper', build: (n) => new ERC721Wrapper<ProductionErc721Token>(n, ProductionErc721Token__factory) },
  { name: 'ERC1155Wrapper', build: (n) => new ERC1155Wrapper<ProductionErc1155Token>(n, ProductionErc1155Token__factory) },
  { name: 'EnygmaWrapper', build: (n) => new EnygmaWrapper<ProductionEnygmaToken>(n, ProductionEnygmaToken__factory) },
];

tokenClasses.forEach(({ name, build }) => {
  describe('BaseTokenWrapper Operations @token-registration @smoke @hubless', function () {
    const userController = new UserController(BACKEND_OPS_URL, BACKEND_USER_AUTH_KEY);
    const operatorController = new OperatorController(BACKEND_OPS_URL, BACKEND_OPERATOR_AUTH_KEY);

    let ctx: BackendTokenContext<DeployableTokenWrapper>;

    beforeEach(`Deploy token on privacy ledger node`, async function () {
      ctx = await setupBackendTokenContext({
        wrapper: build,
        // Registration tests deploy only; balance/mint is not exercised here.
        title: this.currentTest?.fullTitle(),
      });
    });

    describe(`${name} token registration`, function () {

      [TokenStatus.AUTHORIZED, TokenStatus.UNAUTHORIZED].forEach(status => {
        it(`Should register and set token status = ${status}`, async function () {
          const registrationResponse = await registerToken(userController, ctx.tokenAddressInPLA);
          LOGGER.log(`Nonce for txs egister and set token status ${status} =>  ${await ctx.userOperator.getNonce()}`);
          // New token starts WAITING_APPROVAL; response keeps legacy `address`/`updated_at` and numeric `status`.
          assert.equal(registrationResponse.status, TokenStatus.WAITING_APPROVAL);

          await updateTokenStatus(operatorController, ctx.tokenAddressInPLA, status);
          LOGGER.log(`Nonce for txs egister and set token status ${status} =>  ${await ctx.userOperator.getNonce()}`);

          const updatedToken = await userController.pollUntilTokenStatusIsUpdated(ctx.tokenAddressInPLA, status);

          assert.equal(updatedToken.status, status);
        });
      });

      it(`Should walk the status lifecycle WAITING_APPROVAL → AUTHORIZED → UNAUTHORIZED`, async function () {
        const registrationResponse = await registerToken(userController, ctx.tokenAddressInPLA);
        assert.equal(registrationResponse.status, TokenStatus.WAITING_APPROVAL);

        // set-status accepts only AUTHORIZED (2) and UNAUTHORIZED (3); FROZEN is reached via the freeze route.
        for (const status of [TokenStatus.AUTHORIZED, TokenStatus.UNAUTHORIZED]) {
          await updateTokenStatus(operatorController, ctx.tokenAddressInPLA, status);
          const updatedToken = await userController.pollUntilTokenStatusIsUpdated(ctx.tokenAddressInPLA, status);
          assert.equal(updatedToken.status, status);
        }
      });
    });
  });
});
