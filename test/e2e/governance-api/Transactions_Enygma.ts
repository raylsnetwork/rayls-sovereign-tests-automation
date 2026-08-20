import { expect } from 'chai';
import { ethers } from 'hardhat';
import { EnygmaTokenExample, EnygmaTokenExample__factory } from '../../../typechain-types';
import { PrivateHub } from '../../../src/entities/PrivateHub';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../setup';
import { DEFAULT_TIMEOUT, GAS_LIMIT, GOVERNANCE_API_URL, LOGGER } from '../../../src/config/env-config';
import { EnygmaWrapper } from '../../../src/entities/tokens/EnygmaWrapper';
import { linearTransferEnygma } from '../../../src/flows/tokens/token-flows';
import { eventually, never, submitTx } from '../../../src/utils/common';
import { shortHex } from '../../../src/utils/formatters';
import { MessageType, Protocol, TransactionStatus } from '../../../src/types';
import GovernanceController from '../../../src/api/GovernanceController';
import {
  assertEnygmaBatchTransactionResponse,
  assertTransactionResponse,
  GOV_POLL_INTERVAL_MS,
  GOV_POLL_ATTEMPTS_MEDIUM,
  GOV_POLL_ATTEMPTS_LONG,
} from './governance-assertions';
import { sendBatchTransactions } from '../../test-utils/batch-transactions-helpers';
import { FaultInjector, FaultSession, FAULT_POINTS } from '../../../src/utils/fault-injector';
import { compose } from '../../../src/utils/docker-compose';

describe('E2E Tests: Enygma Transfer Flow -> Assert Governance API', function () {
  this.retries(0);

  let signerA: string;
  let signerB: string;
  let signerC: string;

  let tokenOnPLA: EnygmaWrapper<EnygmaTokenExample>;

  let privacyNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let transferAmount: number;
  let transferInitiatedAt: number;

  // Destination-failure injection on relayer-B. Under 3.0.1, Enygma destinations deploy
  // canonical factory bytecode (ProductionEnygmaToken) with no issuer addressToFail revert
  // trap, so a transfer to addressToFail now mints successfully. To reproduce a genuine
  // destination failure (which must stay PENDING + net-zero) these tests arm the relayer
  // FI cut-point FAIL_MINT on relayer-B, routing the dest mint onto the existing
  // RevertDestTransferBatch path (source re-credited, dest mint reverted). Arming relayer-B
  // affects only B-destined transfers (each relayer handles only batches for its own PL).
  let faultB: FaultInjector;
  let sessionB: FaultSession;

  const govController = new GovernanceController(GOVERNANCE_API_URL);
  const initialMintAmount = 1000n;

  before(async function () {
    this.timeout(DEFAULT_TIMEOUT);

    const { initializedNodes, initializedPNH } = await initializePrivacyNodesAndPnh(3);
    privacyNodes = initializedNodes;
    privateHub = initializedPNH;

    tokenOnPLA = new EnygmaWrapper(privacyNodes.A, EnygmaTokenExample__factory);
    await tokenOnPLA.deployViaFactory();
    await tokenOnPLA.activateOnPn();
    await tokenOnPLA.activateOnHub(privateHub);

    signerA = tokenOnPLA.userWallet.address;
    signerB = privacyNodes.B.userWallet.address;
    signerC = privacyNodes.C.userWallet.address;

    await tokenOnPLA.mintAndAwait(privateHub, { amount: initialMintAmount, toAddress: signerA });

    faultB = FaultInjector.forRelayer('B', '127.0.0.1');
    expect(await faultB.isAlive()).to.equal(true,
      'Fault injection API must be reachable on relayer-B (port 6661). Ensure FAULT_INJECTION_ENABLED=true in .B.env and the FI port is exposed.');
    sessionB = await faultB.newSession();
  });

  after(async function () {
    this.timeout(DEFAULT_TIMEOUT);
    try {
      // Safety net: a leaked FAIL_MINT rule would fail every later B-destined transfer in
      // the suite. action:'error' never crashes the relayer, but restore + clear defensively.
      if (faultB && !(await faultB.isAlive())) {
        compose.start('relayer-b');
        await faultB.waitUntilAlive(180_000);
      }
      if (sessionB) await sessionB.clear();
    } catch { /* best-effort cleanup */ }
  });

  it('Cross transfer A -> B shows as Executed', async function () {
    transferInitiatedAt = Math.floor(Date.now() / 1000);
    transferAmount = 10;

    // Send to the same userWallet address on B so linearTransferEnygma's balance
    // check (balanceOf(enygma.userWallet)) passes on the destination node.
    await linearTransferEnygma(
      {
        destinationAddress: signerA,
        amount: BigInt(transferAmount),
        destinationChainId: privacyNodes.B.chainId,
        programData: [], // plain transfer (no programmability)
      },
      2,
      BigInt(transferAmount),
      privateHub,
      privacyNodes.A,
      privacyNodes.B,
      tokenOnPLA
    );

    const listItem = await govController.waitForTransaction({
      messageType: MessageType.ENYGMA,
      fromAddress: signerA,
      sourceChainId: privacyNodes.A.chainId,
      resourceId: tokenOnPLA.resourceId.replace(/^0x/, ''),
      initiatedAfter: transferInitiatedAt,
    }, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_MEDIUM);

    expect(listItem.idType).to.equal('batch_id');
    const batchId = listItem.id;

    const batchResult = await govController.getEnygmaBatchTransactions(batchId);
    expect(batchResult.data).to.have.length.greaterThan(0);
    const batchTx = batchResult.data[0];

    LOGGER.log(`Batch transaction found: messageId=${batchTx.messageId}, amount=${batchTx.amount}`);
    assertEnygmaBatchTransactionResponse(batchTx, {
      sourceChainId: privacyNodes.A.chainId,
      destinationChainId: privacyNodes.B.chainId,
      sourceAddress: signerA,
      destinationAddress: signerA,
      tokenSymbol: tokenOnPLA.symbol,
      amount: transferAmount,
    });

    const transactionDetail = await govController.waitForTransactionStatus(batchTx.messageId, TransactionStatus.EXECUTED, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_MEDIUM);

    LOGGER.log(`Transaction detail: status=${transactionDetail.status}, protocol=${transactionDetail.protocol}, amount=${transactionDetail.amount}`);
    await assertTransactionResponse(transactionDetail, tokenOnPLA, {
      sourceChainId: privacyNodes.A.chainId,
      destinationChainId: privacyNodes.B.chainId,
      messageType: MessageType.ENYGMA,
      status: TransactionStatus.EXECUTED,
      sourceAddress: signerA,
      destinationAddress: signerA,
      messageId: batchTx.messageId,
      amount: transferAmount,
      protocol: Protocol.ENYGMA,
    }, privateHub);

    LOGGER.log(`Asserting Balances table: A=${initialMintAmount - BigInt(transferAmount)}, B=${transferAmount}`);
    await govController.waitForCirculatingSupply(
      tokenOnPLA.resourceId,
      [
        { participantId: String(privacyNodes.A.chainId), balance: String(initialMintAmount - BigInt(transferAmount)) },
        { participantId: String(privacyNodes.B.chainId), balance: String(transferAmount) },
      ],
      GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_MEDIUM,
    );
  }).timeout(5 * 60 * 1000);

  it('Cross transfer A -> B shows as Pending when destination fails', async function () {
    transferInitiatedAt = Math.floor(Date.now() / 1000);
    const addressToFail = await tokenOnPLA.contract.addressToFail();

    // Force relayer-B's destination mint for this transfer onto the revert path so it stays
    // PENDING + net-zero (reproduces the removed issuer addressToFail trap). max_count:0
    // (not one_shot) so the rule persists until explicitly cleared below — one_shot is
    // auto-consumed on fire, which would make the later clearPoint 404.
    await sessionB.arm({
      point: FAULT_POINTS.FAIL_MINT,
      action: 'error',
      message: 'enygma destination-failure injection (governance pending test)',
      max_count: 0,
    });

    // Plain transfer (no programmability) → empty userProgramData. The FI rule armed above forces
    // relayer-B's destination mint to revert, so this stays PENDING + net-zero.
    await submitTx(
      () => tokenOnPLA.contract.linearCrossTransfer(
        addressToFail,
        1n,
        privacyNodes.B.chainId,
        [],
        { gasLimit: GAS_LIMIT },
      ),
      'linearCrossTransfer to addressToFail (destination fails → PENDING)',
    );

    const listItem = await govController.waitForTransaction({
      messageType: MessageType.ENYGMA,
      fromAddress: signerA,
      sourceChainId: privacyNodes.A.chainId,
      resourceId: tokenOnPLA.resourceId.replace(/^0x/, ''),
      initiatedAfter: transferInitiatedAt,
    }, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_MEDIUM);

    expect(listItem.idType).to.equal('batch_id');
    const batchId = listItem.id;

    const batchResult = await govController.getEnygmaBatchTransactions(batchId);
    expect(batchResult.data).to.have.length.greaterThan(0);
    const batchTx = batchResult.data[0];

    LOGGER.log(`Batch transaction found: messageId=${batchTx.messageId}, amount=${batchTx.amount}`);
    assertEnygmaBatchTransactionResponse(batchTx, {
      sourceChainId: privacyNodes.A.chainId,
      destinationChainId: privacyNodes.B.chainId,
      sourceAddress: signerA,
      destinationAddress: addressToFail,
      tokenSymbol: tokenOnPLA.symbol,
      amount: 1,
    });

    // Negative wait: expect the transaction to NEVER reach EXECUTED within the settlement window.
    await never({
      check: async () => {
        const statusDetail = await govController.getTransactionByMessageId(batchTx.messageId);
        return statusDetail.status === TransactionStatus.EXECUTED;
      },
      interval: GOV_POLL_INTERVAL_MS,
      attempts: GOV_POLL_ATTEMPTS_MEDIUM,
      message: `Watching tx ${shortHex(batchTx.messageId)} (must stay non-EXECUTED, settlement window)`,
    });

    const transactionDetail = await govController.getTransactionByMessageId(batchTx.messageId);

    LOGGER.log(`Transaction detail: status=${transactionDetail.status}, protocol=${transactionDetail.protocol}, amount=${transactionDetail.amount}`);
    await assertTransactionResponse(transactionDetail, tokenOnPLA, {
      sourceChainId: privacyNodes.A.chainId,
      destinationChainId: privacyNodes.B.chainId,
      messageType: MessageType.ENYGMA,
      status: TransactionStatus.PENDING,
      sourceAddress: signerA,
      destinationAddress: addressToFail,
      messageId: batchTx.messageId,
      amount: 1,
      protocol: Protocol.ENYGMA,
    }, privateHub);

    expect(await sessionB.wasTriggered(FAULT_POINTS.FAIL_MINT)).to.equal(true,
      'FAIL_MINT should have fired on relayer-B for the B-destined transfer');
    await sessionB.clearPoint(FAULT_POINTS.FAIL_MINT);
    expect(await faultB.isAlive()).to.equal(true, 'relayer-B must remain alive after the fault window');
  }).timeout(5 * 60 * 1000);

  it('Single batch to B and C shows as Executed', async function () {
    const transferInitiatedAt = Math.floor(Date.now() / 1000);

    await sendBatchTransactions(
      1,
      [signerB, signerC],
      [1, 2],
      [privacyNodes.B.chainId, privacyNodes.C.chainId],
      [[], []],
      privacyNodes.A,
      tokenOnPLA,
    );

    const listItem = await eventually({
      check: async () => {
        const result = await govController.getTransactions({
          messageType: MessageType.ENYGMA,
          fromAddress: signerA,
          sourceChainId: privacyNodes.A.chainId,
          resourceId: tokenOnPLA.resourceId.replace(/^0x/, ''),
          initiatedAfter: transferInitiatedAt,
          limit: '10',
        });

        return result.data.length >= 2 ? result.data : undefined;
      },
      interval: 3000,
      attempts: 20,
      message: 'Waiting for 2 batch entries in Gov API',
    });

    // Fetch 1 transaction from each batch and collect them
    const batchTxs = (
      await Promise.all(
        listItem.map(async (item) => {
          const batch = await govController.getEnygmaBatchTransactions(item.id);
          return batch.data[0];
        }),
      )
    ).filter(Boolean);

    expect(batchTxs).to.have.length(2);

    LOGGER.log(`Found ${batchTxs.length} batch transactions (one per destination chain)`);

    for (const batchTx of batchTxs) {
      const expectedReceiver =
        batchTx.destinationChainId === privacyNodes.B.chainId ? signerB : signerC;
      const expectedAmount =
        batchTx.destinationChainId === privacyNodes.B.chainId ? 1 : 2;

      LOGGER.log(`Asserting batch transaction: messageId=${batchTx.messageId}, destinationChainId=${batchTx.destinationChainId}, amount=${batchTx.amount}`);
      assertEnygmaBatchTransactionResponse(batchTx, {
        sourceChainId: privacyNodes.A.chainId,
        destinationChainId: batchTx.destinationChainId,
        sourceAddress: signerA,
        destinationAddress: expectedReceiver,
        tokenSymbol: tokenOnPLA.symbol,
        amount: expectedAmount,
      });

      // Wait until the transaction is fully executed.
      const transactionDetail = await govController.waitForTransactionStatus(batchTx.messageId, TransactionStatus.EXECUTED, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_MEDIUM);

      LOGGER.log(`Transaction detail: status=${transactionDetail.status}, protocol=${transactionDetail.protocol}, amount=${transactionDetail.amount}`);
      await assertTransactionResponse(transactionDetail, tokenOnPLA, {
        sourceChainId: privacyNodes.A.chainId,
        destinationChainId: batchTx.destinationChainId,
        messageType: MessageType.ENYGMA,
        status: TransactionStatus.EXECUTED,
        sourceAddress: signerA,
        destinationAddress: expectedReceiver,
        messageId: batchTx.messageId,
        amount: expectedAmount,
        protocol: Protocol.ENYGMA,
      }, privateHub);
    }

    // Test 1: A→B(10) executed → A=990, B=10
    // Test 2: A→B(1) PENDING + B→A(1) revert → both no-op (flagger detects revert pair)
    // Test 3: batch A→B(1)+A→C(2) executed → A=987, B=11, C=2
    LOGGER.log('Asserting Balances table after batch: A=987, B=11, C=2');
    await govController.waitForCirculatingSupply(
      tokenOnPLA.resourceId,
      [
        { participantId: String(privacyNodes.A.chainId), balance: '987' },
        { participantId: String(privacyNodes.B.chainId), balance: '11' },
        { participantId: String(privacyNodes.C.chainId), balance: '2' },
      ],
      GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_LONG,
    );
  }).timeout(5 * 60 * 1000);

  it('Single batch to B (addressToFail) shows as Pending, C shows as Executed', async function () {
    const transferInitiatedAt = Math.floor(Date.now() / 1000);
    const addressToFail = await tokenOnPLA.contract.addressToFail();

    // Fail only the B-destined leg (arm relayer-B only); C is handled by relayer-C and
    // executes normally. max_count:0 (cleared explicitly below) — one_shot would be
    // auto-consumed on fire and make clearPoint 404.
    await sessionB.arm({
      point: FAULT_POINTS.FAIL_MINT,
      action: 'error',
      message: 'enygma destination-failure injection (B leg of B+C batch)',
      max_count: 0,
    });

    await sendBatchTransactions(
      1,
      [addressToFail, signerC],
      [1, 2],
      [privacyNodes.B.chainId, privacyNodes.C.chainId],
      [[], []],
      privacyNodes.A,
      tokenOnPLA,
    );

    const listItem = await eventually({
      check: async () => {
        const result = await govController.getTransactions({
          messageType: MessageType.ENYGMA,
          fromAddress: signerA,
          sourceChainId: privacyNodes.A.chainId,
          resourceId: tokenOnPLA.resourceId.replace(/^0x/, ''),
          initiatedAfter: transferInitiatedAt,
          limit: '10',
        });

        return result.data.length >= 2 ? result.data : undefined;
      },
      interval: 3000,
      attempts: 20,
      message: 'Waiting for 2 batch entries in Gov API',
    });

    const batchTxs = (
      await Promise.all(
        listItem.map(async (item) => {
          const batch = await govController.getEnygmaBatchTransactions(item.id);
          return batch.data[0];
        }),
      )
    ).filter(Boolean);

    expect(batchTxs).to.have.length(2);

    LOGGER.log(`Found ${batchTxs.length} batch transactions (one per destination chain)`);

    const batchTxB = batchTxs.find((tx) => tx.destinationChainId === privacyNodes.B.chainId)!;
    const batchTxC = batchTxs.find((tx) => tx.destinationChainId === privacyNodes.C.chainId)!;

    expect(batchTxB, 'Expected a batch tx destined to B').to.exist;
    expect(batchTxC, 'Expected a batch tx destined to C').to.exist;

    // Assert batch response fields for B
    LOGGER.log(`Asserting B batch transaction: messageId=${batchTxB.messageId}, destinationAddress=${batchTxB.destinationAddress}`);
    assertEnygmaBatchTransactionResponse(batchTxB, {
      sourceChainId: privacyNodes.A.chainId,
      destinationChainId: privacyNodes.B.chainId,
      sourceAddress: signerA,
      destinationAddress: addressToFail,
      tokenSymbol: tokenOnPLA.symbol,
      amount: 1,
    });

    // Assert batch response fields for C
    LOGGER.log(`Asserting C batch transaction: messageId=${batchTxC.messageId}, destinationAddress=${batchTxC.destinationAddress}`);
    assertEnygmaBatchTransactionResponse(batchTxC, {
      sourceChainId: privacyNodes.A.chainId,
      destinationChainId: privacyNodes.C.chainId,
      sourceAddress: signerA,
      destinationAddress: signerC,
      tokenSymbol: tokenOnPLA.symbol,
      amount: 2,
    });

    // Negative wait: B must stay Pending (crossMint reverts on destination, EnygmaTransferCompleted never arrives).
    await never({
      check: async () => {
        const statusDetail = await govController.getTransactionByMessageId(batchTxB.messageId);
        return statusDetail.status === TransactionStatus.EXECUTED;
      },
      interval: GOV_POLL_INTERVAL_MS,
      attempts: GOV_POLL_ATTEMPTS_MEDIUM,
      message: `Watching tx B ${shortHex(batchTxB.messageId)} (must stay PENDING, crossMint reverted)`,
    });

    const transactionDetailB = await govController.getTransactionByMessageId(batchTxB.messageId);
    LOGGER.log(`B transaction detail: status=${transactionDetailB.status}, protocol=${transactionDetailB.protocol}`);
    await assertTransactionResponse(transactionDetailB, tokenOnPLA, {
      sourceChainId: privacyNodes.A.chainId,
      destinationChainId: privacyNodes.B.chainId,
      messageType: MessageType.ENYGMA,
      status: TransactionStatus.PENDING,
      sourceAddress: signerA,
      destinationAddress: addressToFail,
      messageId: batchTxB.messageId,
      amount: 1,
      protocol: Protocol.ENYGMA,
    }, privateHub);

    // C must reach Executed (valid address, crossMint succeeds)
    const transactionDetailC = await govController.waitForTransactionStatus(batchTxC.messageId, TransactionStatus.EXECUTED, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_MEDIUM);

    LOGGER.log(`C transaction detail: status=${transactionDetailC.status}, protocol=${transactionDetailC.protocol}`);
    await assertTransactionResponse(transactionDetailC, tokenOnPLA, {
      sourceChainId: privacyNodes.A.chainId,
      destinationChainId: privacyNodes.C.chainId,
      messageType: MessageType.ENYGMA,
      status: TransactionStatus.EXECUTED,
      sourceAddress: signerA,
      destinationAddress: signerC,
      messageId: batchTxC.messageId,
      amount: 2,
      protocol: Protocol.ENYGMA,
    }, privateHub);

    expect(await sessionB.wasTriggered(FAULT_POINTS.FAIL_MINT)).to.equal(true,
      'FAIL_MINT should have fired on relayer-B for the B leg');
    await sessionB.clearPoint(FAULT_POINTS.FAIL_MINT);
    expect(await faultB.isAlive()).to.equal(true, 'relayer-B must remain alive after the fault window');
  }).timeout(5 * 60 * 1000);

  it('Multiple batches A -> B all show as Executed', async function () {
    transferInitiatedAt = Math.floor(Date.now() / 1000);
    const batchCount = 2;
    const amountPerBatch = 1;
    // Known receiver address so we can assert destinationAddress on each batch
    const receiverAddress = ethers.Wallet.createRandom().address;

    await sendBatchTransactions(
      batchCount,
      [receiverAddress],
      [amountPerBatch],
      [privacyNodes.B.chainId],
      [[]],
      privacyNodes.A,
      tokenOnPLA,
    );

    const listItem = await eventually({
      check: async () => {
        const result = await govController.getTransactions({
          messageType: MessageType.ENYGMA,
          fromAddress: signerA,
          sourceChainId: privacyNodes.A.chainId,
          resourceId: tokenOnPLA.resourceId.replace(/^0x/, ''),
          initiatedAfter: transferInitiatedAt,
          limit: String(batchCount + 5),
        });
        if (!result.data.length) return undefined;
        const individualTxs = await govController.getEnygmaBatchTransactions(result.data[0].id);
        return individualTxs.data.length >= batchCount ? individualTxs.data : undefined;
      },
      interval: 3000,
      attempts: 20,
      message: `Waiting for ${batchCount} batch txs in Gov API`,
    });

    LOGGER.log(`Found ${listItem.length} batch transactions`);

    for (const batchTx of listItem) {
      LOGGER.log(`Asserting batch transaction: messageId=${batchTx.messageId}, amount=${batchTx.amount}`);
      assertEnygmaBatchTransactionResponse(batchTx, {
        sourceChainId: privacyNodes.A.chainId,
        destinationChainId: privacyNodes.B.chainId,
        sourceAddress: signerA,
        destinationAddress: receiverAddress,
        tokenSymbol: tokenOnPLA.symbol,
        amount: amountPerBatch,
      });

      // Wait until the transaction is fully executed.
      const transactionDetail = await govController.waitForTransactionStatus(batchTx.messageId, TransactionStatus.EXECUTED, GOV_POLL_INTERVAL_MS, GOV_POLL_ATTEMPTS_MEDIUM);

      LOGGER.log(`Transaction detail: status=${transactionDetail.status}, protocol=${transactionDetail.protocol}, amount=${transactionDetail.amount}`);
      await assertTransactionResponse(transactionDetail, tokenOnPLA, {
        sourceChainId: privacyNodes.A.chainId,
        destinationChainId: privacyNodes.B.chainId,
        messageType: MessageType.ENYGMA,
        status: TransactionStatus.EXECUTED,
        sourceAddress: signerA,
        destinationAddress: receiverAddress,
        messageId: batchTx.messageId,
        amount: amountPerBatch,
        protocol: Protocol.ENYGMA,
      }, privateHub);
    }
  }).timeout(5 * 60 * 1000);

  it('Multiple batches A -> B all show as Pending when destination fails', async function () {
    const transferInitiatedAt = Math.floor(Date.now() / 1000);
    const batchCount = 2;
    const amountPerBatch = 1;
    const addressToFail = await tokenOnPLA.contract.addressToFail();

    // Fail every B-destined batch. max_count:0 (unlimited) because batchCount separate
    // batches each reach the dest-mint loop; cleared after the assertions below. Each
    // batch's revert path is terminal (MarkConfirmed), so there is no redelivery loop.
    await sessionB.arm({
      point: FAULT_POINTS.FAIL_MINT,
      action: 'error',
      message: 'enygma destination-failure injection (multi-batch pending test)',
      max_count: 0,
    });

    await sendBatchTransactions(
      batchCount,
      [addressToFail],
      [amountPerBatch],
      [privacyNodes.B.chainId],
      [[]],
      privacyNodes.A,
      tokenOnPLA,
    );

    const listItem = await eventually({
      check: async () => {
        const result = await govController.getTransactions({
          messageType: MessageType.ENYGMA,
          fromAddress: signerA,
          sourceChainId: privacyNodes.A.chainId,
          resourceId: tokenOnPLA.resourceId.replace(/^0x/, ''),
          initiatedAfter: transferInitiatedAt,
          limit: String(batchCount + 5),
        });
        if (!result.data.length) return undefined;
        const individualTxs = await govController.getEnygmaBatchTransactions(result.data[0].id);
        return individualTxs.data.length >= batchCount ? individualTxs.data : undefined;
      },
      interval: 3000,
      attempts: 20,
      message: `Waiting for ${batchCount} batch txs in Gov API`,
    });

    LOGGER.log(`Found ${listItem.length} batch transactions`);

    for (const batchTx of listItem) {
      LOGGER.log(`Asserting batch transaction: messageId=${batchTx.messageId}, amount=${batchTx.amount}`);
      assertEnygmaBatchTransactionResponse(batchTx, {
        sourceChainId: privacyNodes.A.chainId,
        destinationChainId: privacyNodes.B.chainId,
        sourceAddress: signerA,
        destinationAddress: addressToFail,
        tokenSymbol: tokenOnPLA.symbol,
        amount: amountPerBatch,
      });

      // Negative wait: confirm no transaction becomes Executed within the settlement window.
      await never({
        check: async () => {
          const statusDetail = await govController.getTransactionByMessageId(batchTx.messageId);
          return statusDetail.status === TransactionStatus.EXECUTED;
        },
        interval: GOV_POLL_INTERVAL_MS,
        attempts: GOV_POLL_ATTEMPTS_MEDIUM,
        message: `Watching tx ${shortHex(batchTx.messageId)} (must stay non-EXECUTED, settlement window)`,
      });

      const transactionDetail = await govController.getTransactionByMessageId(batchTx.messageId);

      LOGGER.log(`Transaction detail: status=${transactionDetail.status}, protocol=${transactionDetail.protocol}, amount=${transactionDetail.amount}`);
      await assertTransactionResponse(transactionDetail, tokenOnPLA, {
        sourceChainId: privacyNodes.A.chainId,
        destinationChainId: privacyNodes.B.chainId,
        messageType: MessageType.ENYGMA,
        status: TransactionStatus.PENDING,
        sourceAddress: signerA,
        destinationAddress: addressToFail,
        messageId: batchTx.messageId,
        amount: amountPerBatch,
        protocol: Protocol.ENYGMA,
      }, privateHub);
    }

    expect(await sessionB.wasTriggered(FAULT_POINTS.FAIL_MINT)).to.equal(true,
      'FAIL_MINT should have fired on relayer-B for the B-destined batches');
    await sessionB.clearPoint(FAULT_POINTS.FAIL_MINT);
    expect(await faultB.isAlive()).to.equal(true, 'relayer-B must remain alive after the fault window');
  }).timeout(5 * 60 * 1000);
});
