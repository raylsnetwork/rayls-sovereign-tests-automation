/**
 * E2E parallel runner.
 * Partitions files into parallel + serial by scanning for the @serial tag.
 * The base runner handles bootstrap → serial → parallel ordering.
 *
 * Usage:
 *   node scripts/runners/e2e-parallel-runner.js 'test:e2e-full' -- --bail
 */

const fs = require('fs');
const BaseParallelRunner = require('./base-parallel-runner');

const SERIAL_TAG = '@serial';

class E2eParallelRunner extends BaseParallelRunner {
  partitionFiles(allFiles) {
    const parallel = [];
    const serial = [];

    for (const f of allFiles) {
      const content = fs.readFileSync(f, 'utf8');
      if (content.includes(SERIAL_TAG)) {
        serial.push(f);
      } else {
        parallel.push(f);
      }
    }

    return { parallel, serial };
  }
}

new E2eParallelRunner().run();
