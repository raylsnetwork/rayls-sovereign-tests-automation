/**
 * Smoke-test parallel runner.
 * All smoke tests are safe to run in parallel — no @serial scanning needed.
 * Filters out files that don't contain @smoke to avoid loading unrelated
 * test files whose before() hooks cause nonce contention.
 *
 * Usage:
 *   node scripts/runners/smoke-parallel-runner.js 'test:smoke' -- --bail
 */

const fs = require('fs');
const BaseParallelRunner = require('./base-parallel-runner');

const SMOKE_TAG = '@smoke';

class SmokeParallelRunner extends BaseParallelRunner {
  /**
   * Only include files that actually contain @smoke tests.
   * Files without @smoke would still be loaded by Hardhat (running their
   * before() hooks, deploying contracts, etc.) even though --grep @smoke
   * filters out their tests — causing unnecessary nonce contention.
   */
  partitionFiles(allFiles) {
    const parallel = [];
    const skipped = [];

    for (const f of allFiles) {
      const content = fs.readFileSync(f, 'utf8');
      if (content.includes(SMOKE_TAG)) {
        parallel.push(f);
      } else {
        skipped.push(f);
      }
    }

    if (skipped.length > 0) {
      console.log(`Skipped ${skipped.length} files without ${SMOKE_TAG} tag`);
    }

    return { parallel, serial: [] };
  }
}

new SmokeParallelRunner().run();
