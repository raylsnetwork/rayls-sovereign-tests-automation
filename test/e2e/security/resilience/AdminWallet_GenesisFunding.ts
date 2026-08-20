/**
 * @title E2E RESILIENCE: PN admin/SYSTEM wallet genesis funding
 *
 * Reproduces the 2026-05-13 outage where the E2E security test
 * `CustomTokenExample_AccessControl → factory-deployed CustomTokenExample
 * registers MESSAGE_EXECUTOR-gated selectors on the AccessManager (#1)`
 * failed at the very first `adminWallet.sendTransaction({ value: 1 ETH })`:
 *
 *   Error: insufficient funds (transaction={ "from": "0x48074600..." },
 *   info={ "error": { "code": -32003, "message": "insufficient funds for
 *   gas * price + value: have 0 want 1000000000000000000" } })
 *
 * ROOT CAUSE:
 *   The relayer's docker-compose.dev-local.yml passes `DEV_FUNDED_ACCOUNT=
 *   0xE4F2eB9B...` to axyl_genesis.sh on every PN. axyl's `--dev-funded-account`
 *   then pre-allocates 1e27 wei to that address ONLY. The address the tests
 *   actually use as `adminWallet` (the SYSTEM key, deterministically derived
 *   from `PRIVATE_KEY_SYSTEM=0x46c9079f...`, which is 0x48074600...) gets no
 *   genesis allocation on the axyl-based PNs and ends up with zero balance.
 *
 *   On the besu-based PNH the genesis (`genesis_cc.json`) does pre-fund
 *   0x48074600..., so PNH-side admin transactions work — which masked the bug
 *   for every test that funds via `privateHub.adminWallet`. The first test in
 *   the alphabetical `test/e2e/security/*.ts` order that funds via
 *   `privacyNodes.A.adminWallet` (CustomTokenExample_AccessControl) is the
 *   first to surface the bug.
 *
 * FIX:
 *   In docker-compose.dev-local.yml, set DEV_FUNDED_ACCOUNT to the SYSTEM
 *   address (0x48074600e79d46a19d4f0f6869b4396eD244685F) on every `pn-*-genesis`
 *   service so axyl's `--dev-funded-account` pre-allocates 1e27 wei to the
 *   address the tests will actually use.
 *
 * THIS TEST:
 *   Independent of test ordering, asserts that on EVERY active PN the SYSTEM
 *   address has at least `MIN_BALANCE_ETH` native balance after startup.
 *   - FAILS before the fix (genesis allocates the placeholder address only;
 *     SYSTEM = 0).
 *   - PASSES after the fix (SYSTEM gets 1e27 wei on each PN).
 *
 * RUNTIME: <2 seconds. Pure RPC balance reads, no on-chain state changes.
 */

import { expect } from 'chai';
import { ethers } from 'ethers';
import { DEFAULT_TIMEOUT, PROVIDER, PRIVATE_KEY_SYSTEM } from '../../../../src/config/env-config';
import { PrivacyNodeManager } from '../../../../src/entities/PrivacyNodeManager';

const SYSTEM_ADDRESS = new ethers.Wallet(PRIVATE_KEY_SYSTEM).address;

// Threshold derived from observed test usage: makeFundedWallet/makeRoleHolder
// send 1 ETH per call, security tests often call these >5 times, and we want
// headroom for `--clean` reruns without re-running ./start_dev.sh between
// suite invocations. Anything <1 ETH would fail the very first test.
const MIN_BALANCE_ETH = 50n;

describe('E2E RESILIENCE: PN admin/SYSTEM wallet genesis funding @hubless', function () {
  this.timeout(DEFAULT_TIMEOUT);

  const activeNodes = PrivacyNodeManager.getActiveNodes();

  for (const node of activeNodes) {
    it(`SYSTEM wallet has sufficient native balance on PN ${node}`, async function () {
      const provider = PROVIDER[node];
      const balanceWei = await provider.getBalance(SYSTEM_ADDRESS);
      const minWei = ethers.parseEther(MIN_BALANCE_ETH.toString());

      expect(
        balanceWei >= minWei,
        [
          `SYSTEM (${SYSTEM_ADDRESS}) has insufficient native balance on PN ${node}.`,
          `  Got:      ${ethers.formatEther(balanceWei)} ETH`,
          `  Required: ${MIN_BALANCE_ETH.toString()} ETH`,
          ``,
          `This is the 2026-05-13 outage signature. axyl_genesis.sh allocates 1e27 wei`,
          `to the address in $DEV_FUNDED_ACCOUNT (docker-compose.dev-local.yml). If that`,
          `address is not the SYSTEM key (0x48074600...) — i.e., not the address the`,
          `tests use as adminWallet — every security test that funds a worker wallet via`,
          `\`privacyNodes.<X>.adminWallet.sendTransaction({ value: ... })\` fails with`,
          `"insufficient funds for gas * price + value".`,
          ``,
          `FIX: edit docker-compose.dev-local.yml and set:`,
          `  - DEV_FUNDED_ACCOUNT=${SYSTEM_ADDRESS}`,
          `on each pn-*-genesis service, then re-run \`./start_dev.sh -c <N>\`.`,
        ].join('\n'),
      ).to.equal(true);
    });
  }
});
