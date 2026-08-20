<div align="center">

# Rayls Automation

**End-to-end test suite for the Rayls protocol — token operations, Enygma transfers, DVP swaps, governance, and resilience, run against a local Rayls dev stack.**

[![License: Apache 2.0][license-badge]][license-url]
[![Node][node-badge]][node-url]

[![Discord][discord-badge]][discord-url]
[![X][x-badge]][x-url]
[![LinkedIn][linkedin-badge]][linkedin-url]
[![YouTube][youtube-badge]][youtube-url]

[Setup](#setup) | [Running tests](#running-tests) | [Testing guide](TESTING.md) | [Architecture](ARCHITECTURE.md)

</div>

## What is this?

A TypeScript (Hardhat + Mocha) end-to-end test suite for Rayls. The tests connect to a running
Rayls dev stack entirely through environment variables (`src/config/env-config.ts`) — RPC URLs and
`PRIVATE_KEY_SYSTEM` from `.env` — so they run against whatever local stack `.env` points at. See
[TESTING.md](TESTING.md) for the full local flow and [ARCHITECTURE.md](ARCHITECTURE.md) for the design.

## Prerequisites

Clone the sibling repos into the same parent directory (the suite reads contracts + verifier
artifacts from them):

```bash
cd /path/to/your/projects
git clone https://github.com/raylsnetwork/rayls-sovereign-contracts
# plus rayls-sovereign-relayer (brings up the local stack) and rayls-sovereign-gnark-api
```

```
projects/
├── rayls-sovereign-contracts/
├── rayls-sovereign-relayer/
└── rayls-sovereign-tests-automation/
```

Also required: Docker + Docker Compose v2, and Node.js 20+.

> **Note:** the local stack the suite runs against (brought up via the relayer's
> `start_dev.sh`) also depends on components that are not open-sourced yet (the `axyl`
> node, among others), so it cannot currently be brought up from the public repositories
> alone.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Sync contracts

Copies the Solidity sources / typechain artifacts from the local contracts sibling:

```bash
npm run sync-contracts-local
```

### 3. Configure `/etc/hosts`

Adds the Docker service hostnames the suite resolves (requires sudo):

```bash
sudo bash scripts/setup-hosts.sh
```

> The full list of entries is documented in the relayer repo: `rayls-sovereign-relayer/docs/dev/README.md`.

### 4. Configure environment

The relayer's `start_dev.sh` seeds this repo's `.env` when it brings up the local stack (using the
well-known **Anvil** key locally). To set it up manually, copy the contracts repo's local `.env`:

```bash
cp .env.example .env          # or: cp ../rayls-sovereign-contracts/.env ./.env
```

For the Governance API tests, also set `GOVERNANCE_API=http://localhost:9100` in `.env`.

## Running Tests

See [TESTING.md](TESTING.md) for the full flow (start the stack, then run a suite). Common ones:

```bash
npm run test:smoke                  # fast smoke suite
npm run test:e2e-full               # everything
npm run test:e2e-enygma-payment     # Enygma payments
npm run test:e2e-enygma-dvp         # DVP (Delivery vs Payment)
npm run test:e2e-governance-api     # Governance API
```

Run an individual file directly:

```bash
npx hardhat test ./test/e2e/enygma/enygma-payment/Enygma_Transfer_Scenarios.ts
```

HTML reports are written to `mochawesome-report/`.

## Contributing

We are not accepting external contributions at this time — see [CONTRIBUTING.md](./CONTRIBUTING.md). Please also read our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Security

To report a security vulnerability, see [SECURITY.md](./SECURITY.md) — please do not open a public issue.

## License

Licensed under the Apache License, Version 2.0 — see [LICENSE](./LICENSE).

Copyright 2026 Rayls Core Ltd.

[license-badge]: https://img.shields.io/badge/License-Apache_2.0-blue.svg
[license-url]: ./LICENSE
[node-badge]: https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white
[node-url]: https://nodejs.org
[discord-badge]: https://img.shields.io/badge/Discord-join%20chat-5865F2?logo=discord&logoColor=white
[discord-url]: https://discord.gg/6THZ96357r
[x-badge]: https://img.shields.io/badge/X-%40RaylsLabs-000000?logo=x&logoColor=white
[x-url]: https://x.com/RaylsLabs
[linkedin-badge]: https://img.shields.io/badge/LinkedIn-Rayls-0A66C2?logo=linkedin&logoColor=white
[linkedin-url]: https://www.linkedin.com/company/rayls/
[youtube-badge]: https://img.shields.io/badge/YouTube-Rayls-FF0000?logo=youtube&logoColor=white
[youtube-url]: https://www.youtube.com/@Rayls_blockchain
