# E2E Resilience / Chaos Tests

Tests in this directory exercise the relayer's recovery behaviour under failure: process
crashes, container restarts, simulated transient errors, induced sleeps, and external-service
outages. They use the relayer's runtime fault-injection framework (`faultinjector` package
in the relayer repo) and `docker compose` container manipulation.

> **Framework reference:** This README is the test-authoring guide. For the underlying
> framework's HTTP API surface, `FaultRule` schema, multi-arm semantics (equivalence
> classes, FIFO-oldest, `crash > panic > error` priority), and persistence model, see
> [`faultinjector/README.md`](../../../../../rayls-privacy-relayer-api/faultinjector/README.md)
> in the relayer-api repo.

A test passes if the system's invariants hold *despite* the injected fault — no double
spends, no token loss, no inflation, no stuck state. A test fails (loudly, with a state-rich
message) when an injected fault exposes a real exploit.

Tests run **in parallel by default** on the same relayer set. Each test owns its own
fault-injection session (created in `before()`, dropped in `after()`), so concurrent
arms and clears don't collide. Neighbour-tolerance is a test-authoring requirement —
see "Authoring contract" below.

---

## What belongs here

A test belongs in `resilience/` if it does any of:

- imports from `src/utils/fault-injector.ts` (arms a fault rule via the relayer's HTTP API),
- imports from `src/utils/docker-compose.ts` (starts/stops/restarts/kills a relayer container),
- otherwise simulates partial failure of a downstream system.

If a test only validates contract access control or reads on-chain state without inducing
a fault, it goes in `test/e2e/security/` (the parent directory), not here.

---

## Running the suite

```bash
# Full resilience suite
npm run test:resilience

# A single test file
npx hardhat test test/e2e/security/resilience/<TestFile>.ts

# A single test in a file
npx hardhat test test/e2e/security/resilience/<TestFile>.ts \
  --grep '<part of the it(...) name>'
```

`test:resilience` does *not* use `--bail` because we want to see all failures — each
file restores container state in its own cleanup hook (`after()`).

### Prerequisites

- `./start_dev.sh --clean 6` has been run; all 6 relayers (a..f) are healthy and authenticated
  (look for `Source private relayer service starting...` in each `relayer-X` log)
- All 6 fault-injection ports are reachable: `curl http://127.0.0.1:6660/sessions` should return
  `{"enabled":true,"sessions":[]}`
- `FAULT_INJECTION_ENABLED=true` is set in each `docker/development/local/.<X>.env` (default)

---

## Categories of tests you'll find here

- **Crash-recovery & idempotency** — arm a fault point inside the relayer, trigger a flow, crash the process at the cut point, restart, and assert that the post-recovery on-chain / DB state preserves the invariant (no inflation, no token loss, no stuck state).
- **Service-offline / double-spend** — stop a relayer container mid-flow using `compose.stop(...)` and assert that the offline window doesn't enable double-release / double-spend on the locked or escrowed assets.
- **Transient-error / slow-downstream** — arm `action: error` or `action: sleep` to simulate a flaky or slow backend (KOS, Proofs API, RPC) and assert the relayer's retry/timeout/circuit-breaker behaviour holds.
- **Error-class steering** — arm `action: error` with an `error_code` to drive a specific production branch (retry vs. revert vs. back-off) from a *single* cutpoint. See the subsection below.

The test file itself is the source of truth for *what* it asserts — read its top-of-file
docstring (see the authoring template below for the required shape). This README does
not maintain an inventory.

### Error-class steering with `error_code`

When the production code at a cutpoint *already* branches on error type (e.g. retry on
timeout, revert on permanent failure), instrumenting one cutpoint per branch is
unnecessary friction. Use `error_code` instead: each arm declares which class of error
the test wants production to see, and production switches on `faultinjector.CodeOf(err)`
to pick its branch.

```ts
import { FaultInjector, FAULT_POINTS } from '../../../../src/utils/fault-injector';

const fi = FaultInjector.forRelayer('A');
const session = await fi.newSession();

// Drive the retry branch.
await session.arm({
  point: FAULT_POINTS.EXECUTOR_BEFORE_EXECUTE,
  action: 'error',
  error_code: 'timeout',
  message: 'simulated transient backend timeout',
  one_shot: true,
});

// Trigger the relayer flow that hits the cutpoint, then verify which arm fired:
const { log } = await session.status();
const fired = log.find(e => e.point === FAULT_POINTS.EXECUTOR_BEFORE_EXECUTE);
expect(fired?.code).to.equal('timeout');
```

Two arms with different `error_code`s at the same point form distinct FIFO equivalence
classes — three Checks consume them in arm order. Within a single session, only one
rule can be armed per point (per-session semantics); use one session per arm when you
want them to coexist.

Production-side switch (in the relayer Go code) looks like:

```go
if err := faultinjector.Check(point); err != nil {
    switch faultinjector.CodeOf(err) {
    case "timeout":           // retry path
    case "permanent_failure": // revert path
    case "rate_limit":        // back off
    default:                  // unknown / no FI: bubble up
    }
    return err
}
```

For the full framework contract (equivalence-class keying, typed `*Error`,
`CodeOf` semantics), see
[`faultinjector/README.md`](../../../../../rayls-privacy-relayer-api/faultinjector/README.md)
in the relayer repo.

---

## Test-design contract

Every resilience test in this directory must satisfy these criteria. Write the assertion
*for the next reader* — they should be able to read just the failure message and understand
what's broken.

### 1. Failure message must be state-rich

Don't:
```typescript
expect(supplyAfter).to.equal(expectedSupply);
```

Do:
```typescript
expect(supplyAfter).to.equal(expectedSupply,
  `INFLATION: PL-B totalSupply is ${fmt(supplyAfter)} but expected ${fmt(expectedSupply)}. ` +
  `${fmt(supplyAfter - expectedSupply)} tokens were created from nothing due to ` +
  `source relayer crash-restart causing a double transferBatch() submission to CC.`,
);
```

The reader of the failure must know:
- **what invariant was violated** (inflation, double-spend, lost tokens, stuck state)
- **the actual vs expected state** (with units / formatting)
- **the chain of events** that caused it (which fault, which code path)
- **whose fault it is** if multiple components could be at fault (relayer? contract? CC?)

### 2. Two outcomes, both well-defined

Every test docstring should include:

```
TEST OUTCOME:
  - FAILS when vulnerability is present (<one-line description>)
  - PASSES when the fix is applied (<one-line description>)
```

This makes it obvious to anyone reading the test whether a current failure is "expected
because this bug isn't fixed yet" or "regression that needs immediate attention".

### 3. One session per test, mandatory teardown

Every test owns a `FaultSession`. Create it in `before()`, drop it in `after()`:

```typescript
let fi: FaultInjector;
let session: FaultSession;

before(async () => {
  fi = FaultInjector.forRelayer('A', '127.0.0.1');
  session = await fi.newSession();
});

after(async function () {
  try {
    // Restart the relayer if a fault took it down.
    if (!(await fi.isAlive())) {
      compose.start('relayer-a');
      await fi.waitUntilAlive(180_000);
    }
    // Drop the session — rules, log, metadata. `clear()` swallows 404 so it's idempotent.
    if (session) await session.clear();
  } catch { /* best-effort cleanup */ }
});
```

A session left behind is harmless (it'll be swept by the TTL after ~60 minutes), but
explicit teardown keeps the relayer's session table clean and makes test reruns faster.

### 4. Authoring contract — mandatory post-trigger liveness gate

Tests share a relayer with other tests running in parallel. A neighbour test may arm a
`crash` or `panic` rule on the same point your test is exercising — when your `sleep` or
`error` fires, the neighbour's terminal might fire on the same `Check()`. Take the
relayer being alive as a thing you must verify after every triggering action, not a
thing you assume:

```typescript
// Trigger the relayer flow.
await something();

// MANDATORY: confirm the relayer is alive before reading post-state.
await fi.waitUntilAlive(60_000);

// Or, bundling trigger-poll + liveness gate:
await session.assertLiveAfter(FAULT_POINTS.SOME_POINT, 60_000);
```

If your test's assertions genuinely cannot tolerate a parallel neighbour going down,
acknowledge that in a comment at the test's top of file — but the framework's
contract is "parallel-by-default", and there is no `@serial` opt-out for fault-injection
tests.

### 5. Assert the fault actually fired

Confirming the relayer is alive is not the same as confirming *your* fault fired. With
multi-arm semantics (different sessions arming the same point), a neighbour's terminal
may have fired and consumed the `Check()` while your `sleep`/`error` arm stayed armed.
After the trigger-and-liveness step, assert against the session's trigger log:

```typescript
// Did the armed point fire at least once in this session?
expect(await session.wasTriggered(FAULT_POINTS.SOME_POINT)).to.equal(true,
  `Expected fault at ${FAULT_POINTS.SOME_POINT} to fire — log: ` +
  JSON.stringify((await session.status()).log));

// Exact count (for tests that arm with max_count > 1).
expect(await session.triggerCount(FAULT_POINTS.SOME_POINT)).to.equal(2);

// Full log for richer assertions / debug output on failure.
const { log } = await session.status();
const events = log.filter(e => e.point === FAULT_POINTS.SOME_POINT);
```

Available on `FaultSession` (see [src/utils/fault-injector.ts](../../../../src/utils/fault-injector.ts)):

| API                                | Purpose                                                |
|------------------------------------|--------------------------------------------------------|
| `status()`                         | Full session snapshot — rules + log + metadata. The canonical read primitive; destructure `log` / `rules` from the result. |
| `wasTriggered(point)`              | Boolean: did this session see at least one fire?       |
| `triggerCount(point)`              | Exact fire count for this point in this session.       |
| `clearLog()`                       | Empty the log, keep rules armed.                       |
| `clearAllRules()` / `clearPoint(p)`| Disarm without dropping the session or its log.        |

### 6. Use the shared helpers

Don't inline `child_process` calls or build shell strings yourself. Use:

- `compose.{stop,start,restart,kill}(service)` from `src/utils/docker-compose.ts`
  (`start` resumes the existing container with `docker start` — resolved via `docker compose
  ps -aq` — and `restart` is `stop` + that `start`, so bringing a relayer back up neither
  walks its `depends_on` chain into the remote-only / one-shot AXYL nodes nor recreates it.
  Plain `docker compose start` aborts with `missing dependency axyl-base` in a hybrid
  local-relayer / remote-AXYL stack, and `docker compose up` would split the stack by
  rewriting the container's `config_files` label)
- `FaultInjector.forRelayer('A', '127.0.0.1')` from `src/utils/fault-injector.ts`
- `fi.newSession()` to obtain a `FaultSession`
- `fi.waitUntilAlive(timeoutMs)` or `session.assertLiveAfter(point, timeoutMs)` for the
  post-trigger readiness gate

When you find yourself wanting a new container-control primitive, add it to
`docker-compose.ts` (or to `FaultSession`/`FaultInjector`), not inline in the test.

### 7. Wallet funding

Use `raylsNodes.A.adminWallet.sendTransaction(...)` to fund random test wallets, **not**
`userWallet.sendTransaction(...)`. `userWallet` can run out of native ETH after a long
test session; `adminWallet` is the funded bootstrap signer that all tests share.

```typescript
const userA = createRandomWallet(raylsNodes.A.provider);
await (await raylsNodes.A.adminWallet.sendTransaction({
  to: userA.address,
  value: ethers.parseEther('5.0'),
})).wait();
```

---

## Crash-restart semantics — what survives `os.Exit`

Crash-recovery tests rely on the framework persisting rule state *before* `os.Exit(1)`.
The cycle is:

1. `Check(point)` evaluates the rule, decrements counters / consumes `one_shot`,
2. fsyncs the updated session table to `FAULT_INJECTION_PERSIST_PATH`,
3. *then* `os.Exit(1)`.

What this means for your test:

| Rule shape                       | After crash + restart                                                                   |
|----------------------------------|-----------------------------------------------------------------------------------------|
| `crash` + `one_shot: true`       | Consumed pre-exit. On restart the rule is gone, `Check()` returns nil, recovery path runs once. **This is what most crash-recovery tests want.** |
| `crash` + `max_count: N` (N>1)   | Decrements to N−1 pre-exit. The restarted relayer crashes again on the same point until the counter hits 0. Use for "survive K crashes in a row" scenarios. |
| `crash` with no counter          | Unlimited. The relayer crashes forever on the same point — only useful with manual `session.clearPoint()` mid-test. |
| Any rule without `FAULT_INJECTION_PERSIST_PATH` set | Lost on restart. Crash-recovery tests will not behave correctly. The relayer-side `.env` must define this path. |

The session itself also survives restart (it's in the same persisted table), so
`session.wasTriggered(point)` after the restart still reflects the pre-crash fire.

---

## Authoring template

Skeleton for a new fault-injection test:

```typescript
/**
 * @title E2E SECURITY: <one-line summary of the scenario>
 *
 * REPRODUCES THE EXPLOIT BY: <one-line description of the fault chain>
 *
 * TEST OUTCOME:
 *   - FAILS when vulnerability is present (<concrete observable consequence>)
 *   - PASSES when the fix is applied (<the invariant that should hold>)
 *
 * RELATED:
 *   <link to issue / Jira / commit>
 */

import { ethers } from 'ethers';
import { expect } from 'chai';
import { DEFAULT_TIMEOUT, GAS_LIMIT, LOGGER } from '../../../../src/config/env-config';
import { initializePrivacyNodesAndPnh, PrivacyNodeMap } from '../../../setup';
import { PrivateHub } from '../../../../src/entities/PrivateHub';
import { EnygmaWrapper } from '../../../../src/entities/tokens/EnygmaWrapper';
import { createRandomWallet } from '../../../../src/utils/common';
import { compose } from '../../../../src/utils/docker-compose';
import { FaultInjector, FaultSession, FAULT_POINTS } from '../../../../src/utils/fault-injector';

describe('E2E SECURITY: <Scenario Name>', function () {
  this.timeout(DEFAULT_TIMEOUT * 10);

  let raylsNodes: PrivacyNodeMap;
  let privateHub: PrivateHub;
  let fi: FaultInjector;
  let session: FaultSession;
  let userA: ethers.HDNodeWallet;

  before(async function () {
    const setup = await initializePrivacyNodesAndPnh(2);
    raylsNodes = setup.initializedNodes;
    privateHub = setup.initializedPNH;

    fi = FaultInjector.forRelayer('A', '127.0.0.1');
    expect(await fi.isAlive()).to.equal(true,
      'Fault-injection API on relayer-a must be reachable; ensure ' +
      'FAULT_INJECTION_ENABLED=true and port 6660 exposed.',
    );
    session = await fi.newSession();

    userA = createRandomWallet(raylsNodes.A.provider);
    await (await raylsNodes.A.adminWallet.sendTransaction({
      to: userA.address,
      value: ethers.parseEther('5.0'),
    })).wait();

    // ... deploy tokens, mint, set up known initial state ...
  });

  after(async function () {
    try {
      if (!(await fi.isAlive())) {
        compose.start('relayer-a');
        await fi.waitUntilAlive(180_000);
      }
      if (session) await session.clear();
    } catch { /* best-effort cleanup */ }
  });

  it('the invariant that must hold under fault X', async function () {
    // 1. Capture pre-state
    const supplyBefore = await token.totalSupply();
    const balanceBefore = await token.balanceOf(userA.address);
    LOGGER.log(`   PRE: supply=${fmt(supplyBefore)}, balance=${fmt(balanceBefore)}`);

    // 2. Arm the fault inside our session
    await session.arm({
      point: FAULT_POINTS.SOME_POINT,
      action: 'crash',
      one_shot: true,
    });

    // 3. Trigger the relayer flow
    await submitTx(
      () => token.connect(userA).<callTheActionThatHitsTheFault>(/* ... */),
      'Cross-transfer that will hit the armed fault',
    );

    // 4. Wait for the fault to fire (relayer goes down).
    await fi.waitForCrash();

    // 5. Restart and wait for the FI HTTP API to answer again.
    compose.restart('relayer-a');
    await fi.waitUntilAlive(180_000);

    // 6. Grace period for redelivery / async processing.
    await new Promise(r => setTimeout(r, 45_000));

    // 7. Capture post-state and assert the invariant.
    const supplyAfter = await token.totalSupply();
    const balanceAfter = await token.balanceOf(userA.address);
    LOGGER.log(`   POST: supply=${fmt(supplyAfter)}, balance=${fmt(balanceAfter)}`);

    expect(supplyAfter).to.equal(expectedSupply,
      `INFLATION: supply is ${fmt(supplyAfter)} but expected ${fmt(expectedSupply)}. ` +
      `${fmt(supplyAfter - expectedSupply)} tokens were created from nothing due to ` +
      `<the specific code path the fault exposed>.`,
    );
  });
});

function fmt(amount: bigint): string {
  return ethers.formatUnits(amount, 18);
}
```

