# 🧪 Local Testing Guide

How to run the e2e suite locally against a Rayls dev stack. The tests connect to the stack
purely through environment variables (`src/config/env-config.ts`) — RPC URLs and
`PRIVATE_KEY_SYSTEM` from `.env` — so any local stack works as long as `.env` points at it.

## Prerequisites

- **Docker** + Docker Compose v2
- **Node.js** 20+
- The sibling repos cloned into the **same parent directory** as this repo:
  - `rayls-privacy-relayer-api` (brings up the local stack)
  - `rayls-privacy-contracts` (deploys the contracts; provides the local `.env`)
  - `rayls-privacy-gnark-api` (Groth16 verifier artifacts)

## 1. Start the local stack

The relayer's dev script brings up the whole local environment — Privacy Nodes, the Private
Network Hub, CTS, ops-api — deploys the contracts with the well-known **Anvil account #0** key,
and seeds this repo's `.env`:

```bash
cd ../rayls-privacy-relayer-api
./start_dev.sh -c 2
```

Verify everything is up:

```bash
docker compose -f docker-compose.dev-local.yml ps   # all services Up / healthy
```

## 2. Wait for services

```bash
cd ../rayls-privacy-tests-automation
./scripts/wait-for-services.sh
```

## 3. Install dependencies

```bash
npm ci
```

## 4. Configuration (`.env`)

The stack writes this repo's `.env` for you. If you need to (re)seed it manually, copy it from
the contracts repo once the stack is up (this is what `env-copy.sh` / `scripts/sync-contracts-local.sh`
do):

```bash
cp ../rayls-privacy-contracts/.env ./.env
```

`.env` holds the deployed contract addresses, per-node RPC URLs, chain IDs, CTS/ops URLs, DB
connection strings, and `PRIVATE_KEY_SYSTEM` (the local **Anvil** key — a public test key, never
use it on a shared network). If the Enygma verifiers are out of date, refresh them from the local
gnark build:

```bash
./scripts/sync-gnark-verifiers.sh
```

## 5. Run tests

Use the npm scripts (see `package.json` for the full list), or the `run-e2e-tests.sh` wrapper:

```bash
# Smoke (fast)
npm run test:smoke

# Full suite
npm run test:e2e-full

# A single scenario
npm run test:e2e-enygma-transfers
npm run test:e2e-enygma-batch
npm run test:e2e-enygma-dvp
npm run test:e2e-governance-api

# Or via the wrapper (writes a timestamped log)
./scripts/run-e2e-tests.sh smoke
./scripts/run-e2e-tests.sh e2e
```

HTML reports are written to `mochawesome-report/`.

## 6. Cleanup

```bash
cd ../rayls-privacy-relayer-api
docker compose -f docker-compose.dev-local.yml down -v
```

Removes all containers and volumes.

---

## 🔧 Debugging

### Container logs / status

```bash
cd ../rayls-privacy-relayer-api
docker compose -f docker-compose.dev-local.yml ps
docker compose -f docker-compose.dev-local.yml logs            # all
docker compose -f docker-compose.dev-local.yml logs -f pn-a    # follow one service
```

### Connect to PostgreSQL

```bash
docker exec -it postgres psql -U admin -d relayerA
# or, if the port is published:
psql postgres://admin:admin@localhost:5432/relayerA
```

### Check a Privacy Node RPC

```bash
curl -X POST http://localhost:8545 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
# -> {"jsonrpc":"2.0","id":1,"result":"0x..."}
```

### Disk / hard reset

```bash
df -h && docker system df

cd ../rayls-privacy-relayer-api
docker compose -f docker-compose.dev-local.yml down -v --remove-orphans
docker system prune -af --volumes   # ⚠️ removes ALL docker containers/images/volumes
```

---

## 🐛 Troubleshooting

- **Services never become ready** — inspect `docker compose … logs <service>`; give the stack a
  couple of minutes on first run (image builds + contract deploy).
- **Tests can't reach the chain / `.env` errors** — make sure `.env` exists and its RPC URLs match
  the running stack (re-copy from `../rayls-privacy-contracts/.env`).
- **`verifyProof returned false`** — the on-chain Enygma verifiers are out of sync with the gnark
  proving keys; run `./scripts/sync-gnark-verifiers.sh` and redeploy.
