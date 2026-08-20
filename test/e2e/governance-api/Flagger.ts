// NOTE: Teleport is only the vehicle for a live non-teleport feature — migrate to Enygma/DVP on removal; do not delete this test.
import { parseUnits } from 'ethers';
import { expect } from 'chai';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { ERC20Wrapper } from '../../../src/entities/tokens/ERC20Wrapper';
import GovernanceController from '../../../src/api/GovernanceController';
import { DEFAULT_TIMEOUT, GOVERNANCE_API_URL, LOGGER } from '../../../src/config/env-config';
import { GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_LONG, GOV_POLL_ATTEMPTS_TX } from './governance-assertions';
import { TokenExample, TokenExample__factory } from '../../../typechain-types';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { getMessageId, submitTx } from '../../../src/utils/common';

describe('E2E Tests: Flagger - Transaction processor flags transactions with negative balance', function () {
  this.retries(0);

  let privacyNodes: PrivacyNodeMap = {};
  let privateHub: PrivateHub;
  let ERC20: ERC20Wrapper<TokenExample>;

  const GovController = new GovernanceController(GOVERNANCE_API_URL);
  const DEFAULT_MINTED_AMOUNT = parseUnits('2000000', 18);

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(2);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    ERC20 = new ERC20Wrapper(privacyNodes.A, TokenExample__factory);
    await ERC20.deploy();
    await ERC20.activateOnPn();
    await ERC20.activateOnHub(privateHub);
  });

  it('Should flag a transfer when source node used fakeMint to bypass PNH balance tracking @smoke', async function () {
    // Mint 10 tokens via the proper mint() (PNH is notified and tracks the balance increase)
    // PNH tracked balance = DEFAULT_MINTED_AMOUNT + 10
    await ERC20.mintAndAwait(privateHub, {
      toAddress: ERC20.userWallet.address,
      amount: parseUnits('10', 18),
    });

    // fakeMint 1 token (increases on-chain ERC20 balance but does NOT notify PNH)
    // On-chain ERC20: DEFAULT_MINTED_AMOUNT + 11 | PNH tracked: DEFAULT_MINTED_AMOUNT + 10
    await submitTx(
      () => ERC20.contract.fakeMint(ERC20.userWallet.address, parseUnits('1', 18)),
      'fakeMint: mint 1 token without notifying PNH'
    );

    // Transfer the full on-chain balance
    // PNH sees DEFAULT_MINTED_AMOUNT + 10 - (DEFAULT_MINTED_AMOUNT + 11) = -1
    const transferAmount = DEFAULT_MINTED_AMOUNT + parseUnits('11', 18);
    const receipt = await submitTx(
      () => ERC20.contract.teleportAtomic(
        privacyNodes.B.userWallet.address,
        transferAmount,
        privacyNodes.B.chainId
      ),
      'Teleport beyond PNH-tracked balance (fakeMint fraud)'
    );

    // Derive the messageId straight from the teleport receipt's MessageDispatched event
    // and poll the tx detail endpoint by that key — no dependence on governance `created_at`
    // list indexing order or idType=transaction_id (mint) rows leaking through.
    const endpointIface = privacyNodes.A.getEndpointV1().interface;
    const messageIdHex = await getMessageId(receipt, privacyNodes.A.endpointAddress, endpointIface);
    const messageId = messageIdHex.replace(/^0x/, '');
    const transactionDetail = await GovController.waitForTransactionByMessageId(messageId, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_TX);
    await GovController.waitForFlaggedByTransactionId(transactionDetail.id, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_LONG);
  }).timeout(DEFAULT_TIMEOUT);

  it('Should flag a burn that causes negative balance', async function () {
    // After test 1 the governance balance for A is DEFAULT_MINTED_AMOUNT + 10e18.
    // To make the burn negative we need to burn more than that entire tracked balance.
    // fakeMint first so the on-chain balance is large enough to accept the burn.
    const burnAmount = DEFAULT_MINTED_AMOUNT + parseUnits('11', 18);
    await submitTx(
      () => ERC20.contract.fakeMint(ERC20.userWallet.address, burnAmount),
      'fakeMint: inflate on-chain balance without notifying PNH'
    );

    // Burn exceeds PNH-tracked balance (DEFAULT_MINTED_AMOUNT + 10e18) by 1e18 → goes negative
    const burnInitiatedAt = Math.floor(Date.now() / 1000);
    await submitTx(
      () => ERC20.contract.burn(ERC20.userWallet.address, burnAmount),
      'Burn beyond PNH-tracked balance (fakeMint fraud)'
    );

    // Burns and mints are not exposed on the transactions endpoint due to business rules.
    // Therefore, we rely solely on the timestamp filter, as transactionId cannot be used here.
    const flaggedRecord = await GovController.waitForFlaggedSince(burnInitiatedAt, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_LONG);
    expect(flaggedRecord.id, 'flagged record should have an id').to.be.a('string').and.not.be.empty;
    expect(flaggedRecord.transactionId, 'flagged record should have a transactionId').to.be.a('string').and.not.be.empty;
  }).timeout(DEFAULT_TIMEOUT);

  it('Should not update the Balances table when a transfer is flagged @smoke', async function () {
    // After tests 1 and 2 both frauds were flagged and balances left unchanged.
    // A's governance balance = DEFAULT_MINTED_AMOUNT + mintAndAwait(10e18) from test 1.
    // B's governance balance = 0 (no valid transfers to B).
    const expectedBalanceA = DEFAULT_MINTED_AMOUNT + parseUnits('10', 18);
    const expectedBalanceB = 0n;

    // fakeMint enough on-chain to attempt the fraudulent teleport (exceeds A's PNH-tracked balance by 1e18)
    const fraudAmount = DEFAULT_MINTED_AMOUNT + parseUnits('11', 18);
    await submitTx(
      () => ERC20.contract.fakeMint(ERC20.userWallet.address, fraudAmount),
      'fakeMint: inflate on-chain balance without notifying PNH'
    );

    const receipt = await submitTx(
      () => ERC20.contract.teleportAtomic(
        privacyNodes.B.userWallet.address,
        fraudAmount,
        privacyNodes.B.chainId,
      ),
      'Teleport beyond PNH-tracked balance (fakeMint fraud)'
    );

    // Derive the messageId from the teleport receipt and poll the tx detail endpoint by that
    // key — deterministic discovery, no getTransactions/`created_at` list race.
    const endpointIface = privacyNodes.A.getEndpointV1().interface;
    const messageIdHex = await getMessageId(receipt, privacyNodes.A.endpointAddress, endpointIface);
    const messageId = messageIdHex.replace(/^0x/, '');
    const transactionDetail = await GovController.waitForTransactionByMessageId(messageId, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_TX);
    await GovController.waitForFlaggedByTransactionId(transactionDetail.id, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_LONG);

    // Assert the Balances table was NOT updated: A's balance unchanged, B received nothing
    LOGGER.log(`Asserting Balances table unchanged after flagged transfer: A=${expectedBalanceA}, B=${expectedBalanceB}`);
    await GovController.waitForCirculatingSupply(
      ERC20.resourceId,
      [
        { participantId: String(privacyNodes.A.chainId), balance: String(expectedBalanceA) },
        { participantId: String(privacyNodes.B.chainId), balance: String(expectedBalanceB) },
      ],
      GOV_POLL_INTERVAL_MS,
      GOV_POLL_ATTEMPTS_LONG,
    );
  }).timeout(DEFAULT_TIMEOUT);
});
