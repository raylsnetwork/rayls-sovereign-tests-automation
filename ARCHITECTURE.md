# Architecture — rayls-sovereign-tests-automation

E2E test automation for the Rayls privacy protocol. Tests validate cross-chain token operations, DVP swaps, Enygma (zero-knowledge) payments, governance API, security exploits, and backend API workflows across a multi-chain EVM system.

> **Doc sync rule:** Any significant change to files, entities, primitives, test suites, env vars, scripts, or public conventions MUST update both this file AND `CLAUDE.md` in the same PR. Treat docs drift as a regression. Full checklist in `CLAUDE.md` → "Documentation Sync (MANDATORY)".

---

## System Under Test

Rayls is a multi-chain privacy protocol with two node types:

- **Private Hub (PNH)** — central hub (formerly "Commit Chain" / CC). Coordinates cross-chain teleports, DVP swaps, token registry, participant storage, and Enygma ZK proofs. Config key: `'PNH'`.
- **Privacy Nodes (PN-A…F)** — up to 6 independent EVM chains (formerly "Privacy Ledgers" / PL). Each holds private token state (ERC20/721/1155/Enygma). Tokens move between PNs via the PNH.

> **Naming:** Upstream contracts were renamed in v2.6.4: CommitChain→PrivateHub, PL→PN. All TypeScript classes, variables, and imports now use the new glossary: `PrivateHub`, `PrivacyNode`, `PrivacyNodeManager`, `privateHub`, `privacyNodes`, `pnA`/`pnB`/etc.

```
                  ┌────────────────┐
     ┌───────────►│  Private Hub   │◄───────────┐
     │            │  (PNH)         │             │
     │            └──┬───┬───┬─────┘             │
     │               │   │   │                   │
  ┌──┴──┐    ┌──────┘   │   └──────┐    ┌───────┴┐
  │ PN-A│    │ PN-B     │    PN-C  │    │  PN-D  │
  └─────┘    └──────────┘    └─────┘    └────────┘
```

Each PN has:
- JSON-RPC endpoint (EVM)
- PostgreSQL (Enygma state)
- Deployed smart contracts (Endpoint, Governance, Token standards)
- Relayer (bridges PNH ↔ PN messages)

---

## Repository Structure

```
rayls-sovereign-tests-automation/
├── src/                          # Core library (entities, API clients, utils)
│   ├── config/env-config.ts      # All env-loaded config (RPCs, chain IDs, keys, timeouts, PNH/PN)
│   ├── entities/                 # Domain entities
│   │   ├── PrivacyNode.ts         # Base node (PN). Singleton per node key
│   │   ├── PrivateHub.ts         # PNH entity. Extends PrivacyNode. Singleton
│   │   ├── ContractStore.ts      # Per-node contract cache + deploy w/ retry
│   │   ├── PrivacyNodeManager.ts # Generates transfer scenarios from PARTICIPANTS env
│   │   ├── TokenRegistrar.ts     # Token registration lifecycle (submit→approve→activate)
│   │   ├── Logger.ts             # ANSI logger with parallel-safe loading spinners
│   │   └── tokens/               # Token wrappers (one per standard)
│   │       ├── BaseTokenWrapper.ts    # Generic base: deploy, mint, transfer, forNode(); PN prerequisite (activateOnPn) + pure legs activateOnHub / activateOnPublicChain
│   │       ├── ERC20Wrapper.ts        # ERC20-specific: default mint amounts, public chain
│   │       ├── ERC721Wrapper.ts       # NFT: token ID tracking, DVP deposit/withdraw, DB deposit confirmation
│   │       ├── ERC1155Wrapper.ts      # Multi-edition: batch tracking, PNH mint relay, DVP lock checks
│   │       ├── EnygmaWrapper.ts       # ZK token: Merkle commitments, DB checks, DVP ops
│   │       └── interfaces/            # IBaseTokenWrapper, IMintArgs, IVerificationArgs
│   ├── api/                      # Axios REST clients for Ops Service
│   │   ├── BaseController.ts     # Axios wrapper with auth + error interceptor
│   │   ├── GovernanceController.ts    # /audit/* endpoints
│   │   ├── UserController.ts          # /api/user/* endpoints
│   │   ├── OperatorController.ts      # /api/operator/* endpoints
│   │   ├── endpoints/            # Path constant objects
│   │   ├── interfaces/           # Controller interfaces
│   │   └── models/               # Request/response shapes
│   ├── enums/                    # TokenStandards, TokenStatus (privacyNodeStatus semantics), FreezeLayer, SubmitTarget, ParticipantStatus, OnboardingStatus
│   ├── exceptions-and-errors/     # Blockchain error classification
│   │   ├── backend-error.ts      # BackendError (API error wrapper)
│   │   └── block-chain-exceptions.ts  # NonceError, ReplacementTransactionError, ReceiptTimeoutError, isNonceError()
│   ├── flows/                    # Multi-step orchestration
│   │   ├── backend/              # API token-ops + user-onboarding.ts (onboardUser/updateOnboardingStatus/discoverUserId)
│   │   └── tokens/token-flows.ts # Cross-transfer and linear-transfer flows
│   ├── types/                    # DvpSwapParams, TransactionTypes, TokenTypes
│   └── utils/
│       ├── common.ts             # eventually, never, retry, sendTx, submitTx (see "Async Primitives")
│       ├── db-utils.ts           # DB helpers (cleanEnygmaDb, checkBalance, dvpDeposit)
│       ├── network-utils.ts      # getProvider, getSigner, encodeFunctionCall
│       ├── generators.ts         # generateRandomHash, randomBigInt, randomSuffix
│       ├── formatters.ts         # formatFactoryName (strips __factory suffix), shortHex (truncates hex for log/spinner messages)
│       ├── wallet-factory.ts     # createUserOperator — HD wallet derivation
│       └── transfer-callables-utils.ts  # EnygmaCrossTransferCallable builders
├── test/
│   ├── setup.ts                  # Mocha bootstrap: BigInt chai plugin, node/PNH initializers
│   ├── test-data.ts              # Shared test constants (BIGINT, TOKEN_LOCK_REQUEST)
│   ├── test-utils/               # Test helpers and orchestrators
│   │   ├── helpers.ts            # dvpEnygmaAndNftDeploy, sendMultipleTransfers
│   │   ├── batch-transactions-helpers.ts  # Batch sign+send via JSON-RPC
│   │   ├── transaction-builder.ts / transaction-sender.ts  # Raw tx signing + batch RPC
│   │   ├── freeze-helpers.ts        # Hub freeze/unfreeze (TokenRegistryV1) + PNTokenRegistryV1 sync poll; PN-layer freeze (freezeOnPn/unfreezeOnPn/cleanupPnFrozenTokens); public-chain freeze (freezeOnPublicChain/unfreezeOnPublicChain/cleanupPublicFrozenTokens)
│   │   ├── mesh-helpers.ts          # Performance: TPS reporting, parallel balance waits
│   │   └── tasks/                   # Hardhat CLI tasks (deploy, approve, freeze)
│   ├── e2e/                      # E2E test suites (see Test Suites below)
│   └── performance/              # TPS and throughput benchmarks
├── contracts/remote/             # Solidity sources (synced from upstream repos, v2.6.4+)
├── typechain-types/              # Auto-generated ethers-v6 TypeChain bindings
├── scripts/                      # CI/CD, parallel runners, environment setup
│   ├── runners/
│   │   ├── base-parallel-runner.js    # File-level parallel test runner
│   │   ├── e2e-parallel-runner.js     # E2E: parallel + @serial handling
│   │   └── smoke-parallel-runner.js   # Smoke test runner
│   ├── run-e2e-tests.sh          # Test execution wrapper
│   ├── wait-for-participants.ts  # Polls PNH until all PNs are registered
│   ├── sync-contracts-local.sh   # Syncs Solidity from local sibling repos
│   └── ...                       # Docker + local sync helpers
├── hardhat.config.ts             # Solidity 0.8.24, 20+ networks, Mocha + mochawesome
├── CLAUDE.md                     # AI assistant instructions
└── TESTING.md                    # Local testing guide
```

---

## Core Entities

### PrivacyNode (`src/entities/PrivacyNode.ts`)

Represents a Privacy Node (formerly Privacy Ledger / RaylsNode). **Singleton** per node key (`A`–`F`).

| Property | Description |
|---|---|
| `provider` | `ethers.JsonRpcProvider` (pollingInterval=200ms) |
| `adminOperator` | System wallet (`PRIVATE_KEY_SYSTEM`). Used for governance, infra ops |
| `userOperator` | Random HD wallet. Legacy — prefer `createUserOperator()` in tests |
| `contractStore` | `ContractStore` — per-node contract cache |
| `chainId` | Hex chain ID string |
| `endpointAddress` | `EndpointV1` contract address |
| `raylsNodeEndpointAddress` | `RNEndpoint` contract address |

Key methods:
- `getInstance(node)` — singleton factory, calls `initialize()` on first access
- `initialize()` — resolves `EndpointV1` and `RNEndpoint` addresses from `DeploymentProxyRegistry`
- `addAuthorizedAddresses(addresses)` — authorizes contracts on the Endpoint
- `getPnTokenRegistry(signer?)` — PN-side `PNTokenRegistryV1` (addr via `endpoint.getTokenRegistry()`); pass `adminWallet` for the `restricted` register/approve/submit selectors (AccessManager ADMIN bypass)
- `getPnTokenFreezeManager(signer?)` — the `PNTokenFreezeManagerV1` module behind the facade (addr via `registry.getTokenFreezeManager()`); carries the per-participant frozen map + the `TokenFreezeManagerV1__TokenFrozenForParticipant` revert (not on token/facade ABIs); pass `adminWallet` for the `restricted` getter
- `setContractByResourceId(factory, resourceId, key, signer)` — polls Endpoint for cross-chain deployed contract address
- `getContractAt(factoryName, address, key)` — connects and caches a contract
- `deploy(factory, key, ...args)` — deploys with nonce retry

### PrivateHub (`src/entities/PrivateHub.ts`)

Extends `PrivacyNode`. **Singleton**. Represents the Private Hub (formerly CommitChain). Config key: `'PNH'`.

On `initialize()`:
1. Connects to `DeploymentProxyRegistryV1`
2. Calls `getAllContracts()` → builds address map
3. Iterates `PNH_CONTRACT_WIRING` (table at top of `PrivateHub.ts`) — each row maps `{ name, factory, cacheKey, addressField }` and the loop wires `ResourceRegistryV1`, `TeleportV1`, `EndpointV1`, `TokenRegistryV1`, `TokenCoreV1`, `Proofs`, `ParticipantStorageV1`, `Dvp`, `DvpTeleport`. Adding a new PNH contract = add a row + declare its address field on the class.
4. Special-case: `EnygmaPNEvents` (legacy alias `EnygmaCCEvents`, optional)

Key methods:
- `waitForSwapCompleted(sharedId, blockNumber)` — polls DVP SwapCompleted event via `eventually`
- `getTokenFromRegistry(symbol)` — looks up token in PNH `TokenRegistryV1`
- `updateTokenStatus(resourceId, status)` — updates token state on PNH
- `getPNHContract(key)` — retrieves contract cached with `'PNH'` suffix
- `setContractByResourceId(factory, resourceId, key)` — resolves token address on PNH endpoint, caches with `'PNH'` suffix

### ContractStore (`src/entities/ContractStore.ts`)

Per-node in-memory `Map<string, BaseContract>` cache.

- `getFactory(factoryRef, signer)` — creates a typed factory with given signer
- `deploy(factory, key, ...args)` — deploys with nonce retry, caches result
- `connectAt(factoryName, address, key, signer)` — connects to existing contract
- `get(key)` / `set(key, contract)` / `has(key)` — cache access

### Token Wrappers (`src/entities/tokens/`)

All extend `BaseTokenWrapper<T>`. Each wraps a specific token standard.

```
BaseTokenWrapper<T extends BaseContract>
├── ERC20Wrapper         — standard fungible token
├── ERC721Wrapper        — NFT with token ID tracking
├── ERC1155Wrapper       — multi-edition NFT with batch operations
└── EnygmaWrapper        — ZK privacy token with Merkle commitments
```

Key inherited patterns:
- **`forNode(node)`** — clones wrapper for a different PN (cross-chain assertions). Never mutates original.
- **`deployContract(cacheKey, args)`** — deploys via ContractStore
- **`mintAndAwait(cc, args)`** — waits for balance on target PN. Only `EnygmaWrapper` uses `cc` (PNH DB/commitment checks); ERC20/721/1155 mint PN-locally and accept `cc: PrivateHub | undefined` (pass `undefined` when hub-free). **`whenPrivacyNodeActive`-gated**: `mint`/`burn`/`transfer`/`approve` revert `RaylsApp__PrivacyNodeNotActive` unless `privacyNodeStatus==AUTHORIZED` locally → run mint/transfer **after** `activateOnPn()` (contract suites) or ops-api register+approve (backend — `setupBackendTokenContext` deploy-only, `setupTokenForUser` mints post-authorize). Single-node backend setup (`setupBackendTokenContext`) is hub-free: `initializePrivacyNodes(1)` (which also grants the node operator/bank roles), no PrivateHub (the CrossNode hub leg brings its own via `activateTokenOnHubViaBackend`).
- **`activateOnPn()` + `activateOnHub(cc)`** — explicit two-step hub registration after `deploy()`/`deployViaFactory()`. `activateOnPn()` = PN prerequisite (register + authorize); `activateOnHub(cc)` = pure hub leg (was the `TokenRegistration` class + `registerAndApproveToken` composite). Used by teleport suites, the un-seeded holdouts `Erc20BatchTeleport`/`Erc721DvpOverrideExample`, and the Backend-API token-lock flow (`setupBackendTokenContext`, `Token_Lock_*`; registers via Operator API by PL address). A constructor-deployed `*Example` is valid: it **self-IDs its standard via `GetERCStandard()`** (base handlers return base `SharedObjects.ErcStandard`; `*Example` overrides → `*Test`), so the Test ordinal propagates end-to-end (`registerToken` → `submitToHub`/`addToken` → `ResourceManager._keyForTemplate`) and node B auto-deploys the matching `RAYLS_*_TEST_KEY` bytecode (preserves `addressToFail`/`receiveTeleportAtomic`). Backend flow uses `Production*__factory` (base standard).
- **`deployViaFactory(decimals?, signer?)`** — node-factory deploy-as-user (on `EnygmaWrapper`/`ERC20Wrapper`) off *seeded* bytecode so extcodehash matches the PNH-approved template; plumbing in `BaseTokenWrapper.getRnFactory`+`connectFactoryDeployed` (parses `RegisteredContractDeployed.deployedAddress`). Both route through generic `RNContractFactoryV1.deployRegisteredAsUser(key, userArgs)`, inferring the key from the `factory` ref: Enygma `EnygmaTokenExample__factory`→`RAYLS_ENYGMA_TEST_KEY`, else (`ProductionEnygmaToken__factory`) `RAYLS_ENYGMA_KEY`; ERC20 `TokenExample__factory`→`RAYLS_ERC20_TEST_KEY`, else (`ProductionErc20Token__factory`) `RAYLS_ERC20_KEY` (`Erc20BatchTeleport__factory` → throws, no seeded bytecode). `signer` defaults to `userWallet` (TOKEN_OWNER = deployer EOA via `_pendingOwnerOverride`, mint via `this.contract`); pass `adminWallet` for admin-owned (aux ERC20 X in `Enygma_Programmability.ts`). Every Enygma cross-transfer rides the codehash-gated `crossMintStandard`, so a constructor-`deploy()` instance works A→B but reverts **`ProgramData__UnapprovedTemplate`** on B→A; seeded deploy fixes it. `deployRegisteredAsUser` is **not `restricted`** (permissionless) and does NOT auto-register on the hub → run `activateOnPn()` + `activateOnHub(cc)` after (the hub `activateToken` callback assigns the resourceId via `RaylsApp.setResourceId`; the Enygma subclass overrides `activateOnHub` to rebind `EnygmaV1`). Requires the `TOKEN_CREATOR → PN TokenCore` grant + seeded bytecode carrying `GetERCStandard`. `deploy()` is valid only for a send-only/source example (keeps `EnygmaTokenExample.addressToFail`); receivers of cross-mints require `deployViaFactory`.
- **Enygma example-on-the-wire** — `deployViaFactory` on `EnygmaTokenExample__factory` selects seeded **`RAYLS_ENYGMA_TEST_KEY`**: the instance exposes `addressToFail` and self-IDs as `EnygmaTest`, so `ResourceManager._keyForTemplate` makes node B auto-deploy the same example whose `crossMintStandard` carries the native `addressToFail` revert trap (transfer to `addressToFail` reverts at dest → tx PENDING + net-zero, no relayer FI). Used by `test/e2e/governance-api/Transactions_Enygma.ts`. **Requires** `RAYLS_ENYGMA_TEST_KEY` seeded on the PNH `TemplateRegistry` (extend `seed-standard-templates`; prod seeds only `RAYLS_ENYGMA_KEY`), else forward mint on B + dest-failure re-credit on A revert `ProgramData__UnapprovedTemplate`.
- **`waitForBalance(expected, args)`** — polls until balance matches
- **`transfer(args)`** — wrapped in `sendTx` for nonce retry

#### Public-chain activation (PNTokenRegistryV1)

`PNTokenRegistryV1` (PN-side UUPS facade over `PNTokenCoreV1` + `PNTokenFreezeManagerV1`) tracks three
independent per-token status machines — `privacyNodeStatus`, `hubStatus`, `publicChainStatus` — so a token can
be Hub- (private cross-chain) and/or Public-chain-active independently. Two flows (both constructor-deploy):

1. **Hub** (private cross-chain, `test/e2e/ERC20_Private_To_Public.ts` — teleport A→B then bridge B→public):
   `deploy()` → `activateOnPn()` (`registerToken(addr)` → `updatePrivacyNodeStatus(addr, AUTHORIZED)`; once, not
   idempotent) → `activateOnHub(privateHub)` (`submitToHub(addr)` → PNH assigns resourceId via
   `getTokenFromRegistry` → `privateHub.updateTokenStatus(rid)` operator-approve → relayer `activateToken`
   callback sets `hubStatus=AUTHORIZED` + the PN token's `resourceId`; waits `resourceId() != ZERO_HASH`).
   `activateOnHub` needs PN AUTHORIZED and does NOT run the PN step — call `activateOnPn()` first; subclasses
   (Enygma/721/1155) override it to append PNH wiring after the resourceId is set. `Token_Lock_CrossNode` suites
   use `activateTokenOnHubViaBackend` (`setup-token-context.ts`): PN authorize (register+approve) via ops-api,
   hub leg via contract `activateOnHub` (ops-api `submit {target:hub}` reverts on-chain — the `submitToHub`
   messaging body, not a role).
2. **Public** (private↔public, `public-chain/` suites): `deploy()` → `activateOnPn()` (a receiver already
   PN-AUTHORIZED via the hub callback SKIPS this → calls `activateOnPublicChain()` directly) →
   `activateOnPublicChain()` (needs PN AUTHORIZED; returns the public addr; internally `submitToPublicChain()`
   → `publicChainStatus=PENDING_DEPLOYMENT` (idempotent) → `getPublicAddress()` (waits
   `getPublicChainStatus(addr)==DEPLOYED`, reads `getTokenByAddress(addr).publicTokenAddress`) →
   `waitForPublicTokenAuthorized(pub)` (closes the relayer auth race); the three blocks stay individually
   callable). Leaves `hubStatus=UNDEFINED`.

Facade selectors are `restricted`: `registerToken`→`TOKEN_CREATOR` (contract factory only),
`updatePrivacyNodeStatus`/`submitToPublicChain`→`PN_TOKEN_REGISTRY_ADMIN` (`initialOwner`),
`updatePublicTokenAddress`→`RELAYER`. Sign register/approve/submit as `adminWallet` (system key =
`initialOwner` = ADMIN); `RaylsAccessManager.canCall` short-circuits true for ADMIN on any selector, so no
per-selector grant is needed.

---

## Wallet Strategy

| Wallet | Creation | Used For |
|---|---|---|
| `adminOperator` | `new Wallet(PRIVATE_KEY_SYSTEM)` on each node | Governance, infra, `addAuthorizedAddresses`, `RelayAuthorizationRegistry` |
| Per-wrapper `userOperator` | `createUserOperator(provider)` in `BaseTokenWrapper` constructor | Token deployment, minting, transfers within wrapper |
| Per-test local deployer | `createUserOperator(provider)` in test `before()` | Test-specific contract deployment (ArbitraryMessage, BatchTransfer) |

`createUserOperator()` (`src/utils/wallet-factory.ts`) derives random HD child wallets from `PRIVATE_KEY_SYSTEM` seed. Each call picks a random BIP32 child index — unique wallet per invocation.

**Rule:** Tests needing a custom deployer should create their own via `createUserOperator()` and use `contractStore.getFactory()` / `contractStore.deploy()` directly. Don't rely on `PrivacyNode.userOperator`.

---

## Async Primitives

All async waiting, polling, retrying and on-chain submissions go through the primitives in `src/utils/common.ts`. Bespoke `for/while/setTimeout` loops and `try/catch/log/rethrow` retry wrappers are anti-patterns — they were removed across the codebase and must not come back.

### The four primitives

| Intent | Function | Throws on exhaustion? |
|---|---|---|
| Positive wait — "wait for X to become Y" | `eventually({ check, message, interval?, attempts?, tolerateErrors? })` | yes, with `message` + last error/value |
| Temporal invariant — "X must NOT happen for N seconds" | `never({ check, message, interval?, attempts?, tolerateErrors? })` | yes, when check fires |
| Idempotent retry — transient backend/nonce errors | `retry(fn, { attempts?, delayMs?, retryIf?, onRetry? })` | yes, with last error |
| Contract write | `submitTx(txFactory, message)` | yes |

Lower-level `sendTx(txFactory, label)` exists for raw PN sends; most callers want `submitTx` (handles nonce retry + displaced-tx recovery + receipt wait + spinner).

### Rules

- **`message` is mandatory** on `eventually` / `never` — action-oriented ("Waiting for chains [X,Y] freeze → true"), front-loading discriminators (chainId, replica addr, resourceId) for readable parallel spinners; hex → `shortHex(s)` (`src/utils/formatters.ts`).
- Set `tolerateErrors: true` when `check()` can throw transients — do NOT wrap in `try { … } catch { return undefined }`.
- `eventually` / `never` throw on exhaustion — no dead `if (!result) throw …`. Log retries via `retry({ onRetry })`, NOT `try/catch/log/rethrow`.
- Never `.wait()` a `submitTx` result (it already waits); never `await contract.method(); await tx.wait()` directly (bypasses nonce retry).

### Logging

All logging in `src/` and `test/` goes through `LOGGER` (`src/config/env-config.ts` exports the singleton instance of `Logger` from `src/entities/Logger.ts`). API: `.log` / `.info` / `.success` / `.error` / `.data` / `.scenario` / `.load`+`.loadSuccess`+`.loadError` / `.optionalLog`. **All methods take a single string** — convert multi-arg `console.log(a, b, c)` to template strings. LOGGER has NO `.warn` — map to `.error`.

`console.*` is forbidden in `src/` / `test/` except: `src/entities/Logger.ts` (the implementation), `scripts/runners/*.js` (outside mocha process), `test/performance/reporters/generateHtmlReport.ts` (standalone CLI).

### Removed primitives — do NOT reintroduce

`pollCondition`, `pollAndReturnObject`, `PrivateHub.waitUntil`, `PrivateHub.wait`, `waitUntil`. If `eventually` / `never` / `retry` / `submitTx` can't express your case, raise it before adding a new helper.

`EnygmaWrapper.deployTestViaFactory()` — collapsed into `deployViaFactory()`, which now infers `RAYLS_ENYGMA_TEST_KEY` vs `RAYLS_ENYGMA_KEY` from the wrapper's `factory` ref (`EnygmaTokenExample__factory` vs `ProductionEnygmaToken__factory`) and always routes through `RNContractFactoryV1.deployRegisteredAsUser`.

**Removed token-governance surface (replaced by `PNTokenRegistryV1`):** `PrivacyNode.getTokenRegistryReplica()`, `getTokenGovernance()`, `addTokenToGovernance()`, `approveTokenInGovernance()`; `BaseTokenWrapper.getPublicAddressWithRetries()`; the token-setup methods `registerAndApproveOnPn()` (→ `activateOnPn()`), `registerAndApproveOnHub()`/`activateHub()` (→ `activateOnHub()`), `activatePublicChain()` (→ `activateOnPublicChain()`), and the composite `registerAndApproveToken()` (hub flow is now the explicit `activateOnPn()` + `activateOnHub()` pair); the `TokenRegistration` class + `IRegistrableToken` interface (`src/entities/TokenRegistration.ts`); the contracts `TokenRegistryReplicaV1` / `RNTokenGovernanceV1` (+ `RNTokenGovernanceV1.getPublicAddressByPrivateAddress`, `EndpointV1.getTokenRegistryReplica`); the freeze error `TokenIsFrozenForParticipant` (→ `RaylsApp__HubNotActive` source/both, `TokenFreezeManagerV1__TokenFrozenForParticipant` dest-only). Use `getPnTokenRegistry(signer?)` + `activateOnPn` (prerequisite) + `activateOnHub`/`activateOnPublicChain` (legs) — see "Public-chain activation (PNTokenRegistryV1)".

### Other tx-related helpers

| Context | Function | Location |
|---|---|---|
| Batch sends (perf tests) | `sendBatchTransactions()` | `test/test-utils/batch-transactions-helpers.ts` |
| Raw signed tx + JSON-RPC batch | `transaction-builder.ts` / `transaction-sender.ts` | `test/test-utils/` |

---

## Test Suites

### E2E Tests (`test/e2e/`)

| Suite | Directory | What It Tests |
|---|---|---|
| **Token Teleports** ⚠️ _DEPRECATED_ | `e2e/ERC20.ts`, `ERC721.ts`, `ERC1155.ts` | Vanilla, atomic (burn-based), revert, lock enforcement, third-party transfer. **Decommissioning Teleport (vanilla, atomic); superseded by Enygma/DVP.** |
| **Enygma Payments** | `e2e/enygma/enygma-payment/` | Cross-transfers (1→N), linear, batch, freeze, edge cases, DB resync |
| **Enygma DVP** | `e2e/enygma/enygma-dvp/` | ERC721↔Enygma swaps, ERC1155↔Enygma, consolidated deposits/withdraws, cancellation, disagreement, freeze |
| **Batch Transfers** | `e2e/BatchTransfers.ts` | Batch cross-chain message delivery (V1–V5 + many messages) |
| **Arbitrary Messages** | `e2e/ArbitraryMessages.ts` | Custom callable cross-chain delivery |
| **Public Chain** ⚠️ _DEPRECATED_ | `e2e/public-chain/` | ERC20/721/1155 burn-to-public-chain teleport, public balance verification. **Decommissioning Teleport (vanilla, atomic); superseded by Enygma/DVP.** |
| **Governance API** | `e2e/governance-api/` | Transaction, participant, token queries via REST API |
| **Ops Service API** | `e2e/backend/` | User onboarding, token registration, token teleport (legacy "token lock"; per-standard split: ERC20/721/1155, address → path, response `tx_hash`), teleport validation, cross-node teleport flows |
| **Security** | `e2e/security/` | Reentrancy, exfiltration, auth bypass, freeze exploits, receive-teleport exploits |
| **Double-Spend** | `e2e/security/double-spend/` | Atomic-B offline double-spend exploits (ERC20/721/1155) — tests unlock() access control |
| **Freeze** | `e2e/FreezeTokens.ts`, `e2e/public-chain/*_Public_Chain.ts`, `e2e/enygma/enygma-payment/Enygma_Transfer_Freeze.ts` | 3 layers. **Hub** (`TokenRegistryV1.freezeToken`, synced to each PN's `PNTokenRegistryV1`) → teleport reverts `RaylsApp__HubNotActive` (source/both) or `TokenFreezeManagerV1__TokenFrozenForParticipant` (dest-only). **PN** (`PNTokenRegistryV1.freezeOnPrivacyNode`, local) → `RaylsApp__PrivacyNodeFrozen` (ERC20/721/1155 in `FreezeTokens.ts`, Enygma in `Enygma_Transfer_Freeze.ts`). **Public** (`PNTokenRegistryV1.freezeOnPublicChain`, local) → `teleportToPublicChain` reverts `RaylsApp__PublicChainNotActive` (`public-chain/` suites) |

### Performance Tests (`test/performance/`)

Atomic mesh throughput, Enygma TPS, PN-to-Public-Chain benchmarks. Separate from E2E.

### Test Setup (`test/setup.ts`)

Required by Mocha. Provides:
- **BigInt Chai plugin** — auto-coerces `BigInt` in `expect().to.equal()`
- `initializePrivacyNodes(n)` — creates `n` PN singletons (A, B, C…) **and grants each node's standard
  PN roles** (`PRIVACY_NODE_OPERATOR` then `BANK_EMPLOYEE`; idempotent guard-then-skip, so warm calls are
  read-only). PN-local only; does **not** wait for participant propagation. Hubless suites (public-chain,
  factory-ACL, backend single-node, the PN-only security tests) call this directly — no need to re-grant.
- `initializePrivateHub()` — creates PNH singleton
- `initializePrivacyNodesAndPnh(n)` — both in one call; runs `waitForParticipantsOnReplicas`
  (the PNH→PN participant-readiness gate) + grants the PNH network-operator/compliance roles (the PN
  operator/bank grants already happened inside `initializePrivacyNodes`). Hub-oriented suites use this.

---

## Parallel Execution

File-level parallelism via `scripts/runners/base-parallel-runner.js`:

1. Collects test files from globs or npm script names
2. Splits files across `PARALLEL_WORKERS` Hardhat processes (round-robin)
3. Staggers worker startup by `WORKER_STAGGER_MS` to reduce PNH nonce contention
4. Each worker gets `MOCHA_WORKER_ID` env var
5. `@serial`-tagged files run sequentially after all parallel workers finish
6. Merges per-worker mochawesome JSON reports

Timeout scaling:
- `DEFAULT_TIMEOUT` = 4 min (doubled when `PARALLEL_WORKERS > 1` via `TIMEOUT_MULTIPLIER`)
- `BEFORE_HOOK_TIMEOUT(n)` scales by number of setup cycles
- Mocha global timeout: 80s (overridden per-test with `.timeout()`)

---

## Configuration

### Environment (`src/config/env-config.ts`)

Builds node-keyed dictionaries. PNH is configured explicitly; PN nodes (`A`–`F`) iterate via `RAYLS_NODES`:

| Dictionary | PN Env Var Pattern | PNH Env Var | Example |
|---|---|---|---|
| `RPC_URL[node]` | `PRIVACY_NODE_{node}_RPC_URL` | `PNH_RPC_URL` | `PRIVACY_NODE_A_RPC_URL` |
| `CHAIN_ID[node]` | `PRIVACY_NODE_{node}_CHAIN_ID` | `PNH_CHAIN_ID` | `PRIVACY_NODE_A_CHAIN_ID` |
| `PROVIDER[node]` | Built from `RPC_URL[node]` | — | — |
| `DB_CONNECTION[node]` | `PRIVACY_NODE_{node}_DB_CS` | `PNH_DB_CS` | `PRIVACY_NODE_A_DB_CS` |
| `ENDPOINT_ADDRESS[node]` | `PRIVACY_NODE_{node}_ENDPOINT_ADDRESS` | `PNH_ENDPOINT_ADDRESS` | — |
| `DEPLOYMENT_PROXY_REGISTRY_ADDRESS[node]` | `PRIVACY_NODE_{node}_DEPLOYMENT_PROXY_REGISTRY` | `PNH_DEPLOYMENT_PROXY_REGISTRY` | — |

All config dicts are `Object.freeze()`d at startup.

Key standalone vars:
- `OPS_SERVICE_URL[NODE]` / `OPS_SERVICE_USER_AUTH_KEY[NODE]` / `OPS_SERVICE_OPERATOR_AUTH_KEY[NODE]` — Ops Service, **per-node maps** keyed by node letter (e.g. `OPS_SERVICE_URL['B']`), loaded from `OPS_SERVICE_<NODE>_URL` / `_USER_AUTH_KEY` / `_OPERATOR_AUTH_KEY`.
- `BACKEND_TARGET_NODE` (derived) + `BACKEND_OPS_URL` / `BACKEND_USER_AUTH_KEY` / `BACKEND_OPERATOR_AUTH_KEY` (each `<MAP>[BACKEND_TARGET_NODE]`) — the node single-node backend tests target. `BACKEND_TARGET_NODE = WORKER_ID % availableBackends.length` (spreads parallel load; single-worker → first backend; first worker warns if `PARALLEL_WORKERS > available backends`). Cross-node tests (e.g. `Token_Lock_CrossNode_Negative`) name nodes directly via `OPS_SERVICE_URL['A'|'B']` + matching auth key, with an inline prerequisite check at the top of the describe block that fails fast on a missing `OPS_SERVICE_*_URL` (else `undefined` → axios `baseURL`).
- `GOVERNANCE_API_URL` — Governance API base URL
- `PUBLIC_CHAIN_RPC_URL` / `PUBLIC_CHAIN_ID` — Public chain connection

Key flags:
- `USE_DB_CHECKS` — enables PostgreSQL balance assertions (optional)
- `CLEAN_ENYGMA_DB_BEFORE_TESTS` — wipes Enygma tables on startup
- `PARALLEL_WORKERS` — number of parallel Hardhat workers
- `PARTICIPANTS` — comma-separated chain IDs for dynamic test generation

### Hardhat (`hardhat.config.ts`)

- Solidity `0.8.24`, optimizer `runs: 50`, EVM `paris`
- TypeChain: ethers-v6, output to `typechain-types/`
- Sources: `./contracts/remote` (synced from upstream)
- 20+ network configs (local, dev, custom)
- Mocha: mochawesome reporter, requires `./test/setup.ts`

---

## Smart Contracts (`contracts/remote/`)

Synced from upstream repos. **Not authored in this repo.**

```
contracts/remote/
├── privateHub/            # PNH: TokenRegistry, ParticipantStorage, DVP, Teleport (was commitChain/)
├── rayls-node/            # PN: Endpoint, UserGovernance, TokenGovernance, DeploymentProxyRegistry
├── rayls-protocol/        # Core: Teleport, Enygma, Merkle, Proofs, MessageDispatcher
├── rayls-protocol-sdk/    # Token standards: ERC20/721/1155/Enygma examples
├── dvp/                   # DVP vaults and coordinators
├── lib/                   # Shared Solidity libraries
└── test/                  # Test-only contracts (reentrancy attackers, callable mocks)
```

Sync scripts: `scripts/sync-contracts-local.sh` and `scripts/sync-gnark-verifiers.sh` copy Solidity / verifier artifacts from the local sibling repos (`../rayls-sovereign-contracts`, `../rayls-sovereign-gnark-api`).

---

## Key Patterns

### forNode() — Cross-Chain Token Assertions
```typescript
// Clone wrapper for PN-C without mutating original
const enygmaOnC = await enygma.forNode(privacyNodes.C);
const balance = await enygmaOnC.contract.balanceOf(address);
```

### Dynamic Test Generation
Enygma transfer tests are generated at runtime from `PrivacyNodeManager.getValidTransferScenarios()` based on `PARTICIPANTS` env var. Supports 1→1, 1→2, 1→3, 1→N fan-out patterns.

### Security Tests as Documentation
Each `SEC00X_*.ts` includes a JSDoc block explaining the vulnerability, attack vector, and expected outcome. Tests **pass** when the attack is properly guarded; **fail** when the vulnerability is exploitable.

### Address-Pair Onboarding — pending-only discovery
Operator transitions target a pair by UUID from the admin **pending** list — a pair surfaces there **only while
PENDING**. `updateOnboardingStatus()` discovers + **returns** that `userId`; `onboardUserAndUpdateStatus()` runs the
first transition internally and exposes the id via `opts.onUserId(userId)`. A **second** transition (e.g.
APPROVED→REJECTED) must pass that cached id back as `opts.userId` — re-discovering an already-transitioned pair polls
forever (`eventually` throws). Capture-then-reuse:
```typescript
let userId: string;
const pair = await onboardUserAndUpdateStatus(user, op, OnboardingStatus.APPROVED,
  { onUserId: (id) => { userId = id; } });
await updateOnboardingStatus(op, pair, OnboardingStatus.REJECTED, { userId });  // no re-discovery
```

### Pre-Authorization + Deploy Pattern
When deploying test contracts with a user wallet:
```typescript
const deployer = createUserOperator(node.provider);
const factory = await node.contractStore.getFactory(MyFactory, deployer);
const nonce = await node.provider.getTransactionCount(deployer.address);
const predicted = ethers.getCreateAddress({ from: deployer.address, nonce });
await node.addAuthorizedAddresses([predicted]);  // admin wallet
await node.contractStore.deploy(factory, 'MyContract', ...args);  // deployer wallet
```

---

## API Clients (`src/api/`)

Axios-based REST clients for the Ops Service:

| Controller | Base Path | Operations |
|---|---|---|
| `GovernanceController` | `/audit/*` | Tokens, participants, transactions queries |
| `UserController` | `/api/tokens/*` (registry + teleport), `/api/me/address-pairs` (onboarding) | `registerToken(address)` → `POST /api/tokens/:address/register` (**no body**; metadata read on-chain; starts WAITING_APPROVAL=1), `listRegistry()` / `listRegistryPending()` (WAITING_APPROVAL subset), `teleport(address, …)` → `POST /api/tokens/:address/teleport` (response `tx_hash`); `addAddressPair()` / `listMyAddressPairs(status?)` for JWT-derived onboarding |
| `OperatorController` | `/api/v1/admin/*` (tokens + onboarding) | `updateTokenStatus(address, {status})` → `PATCH /api/v1/admin/tokens/:address/status` (accepts only 2 AUTHORIZED / 3 UNAUTHORIZED; 0/1/4 → 400); `freezeToken`/`unfreezeToken(address, {layer})` → `POST /api/v1/admin/tokens/:address/freeze`\|`/unfreeze` (`privacy_node`\|`public_chain`; bad layer → 400, contract reject → 422); `submitToken(address, {target})` → `POST /api/v1/admin/tokens/:address/submit` (`hub`\|`public_chain`; initiate-only, async activation; non-AUTHORIZED → 422); `listAllPendingAddressPairs()` (UUID discovery) + `approveAddressPair(userId, …)` |

All extend `BaseController` which provides auth token injection and error interception (`BackendError`).

---

## Running Tests

See [TESTING.md](TESTING.md) for full local setup guide.

Quick reference:
```bash
# Smoke tests
npm run test:smoke

# Hub-free suites (no PrivateHub — PN + ops-api only; @hubless)
npm run test:hubless

# Full E2E
npm run test:e2e-full

# Parallel execution
node scripts/runners/e2e-parallel-runner.js test:e2e-full

# Specific suite
npx hardhat test test/e2e/enygma/enygma-payment/Enygma_Transfer_Scenarios.ts

# Specific test by name
npx hardhat test test/e2e/ERC20.ts --grep "atomic"
```
