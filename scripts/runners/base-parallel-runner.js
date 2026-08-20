/**
 * Base class for parallel test runners.
 * Handles CLI parsing, file resolution, bootstrap, worker spawning, and report merging.
 *
 * Flow:
 *   1. Resolve test files (from npm script name or glob patterns)
 *   2. Partition into { serial, parallel } (subclass hook)
 *   3. Bootstrap per-worker ADMIN wallets (unless SKIP_BOOTSTRAP=1 or workerCount<=1)
 *   4. Run serial files sequentially with the seed wallet (fails-fast)
 *   5. Dynamic queue: N worker slots each pull one file at a time from a shared queue
 *      — no static assignment, no idle workers, natural load balancing
 *   6. Merge per-file mochawesome reports
 *
 * Subclasses override partitionFiles() to classify @serial vs @parallel.
 */

const { spawn, execSync } = require('child_process');
const glob = require('glob');
const path = require('path');
const fs = require('fs');

class BaseParallelRunner {
  constructor() {
    this.workerCount = parseInt(process.env.PARALLEL_WORKERS || '4', 10);
    this.staggerDelayMs = parseInt(process.env.WORKER_STAGGER_MS || '5000', 10);
    this.skipBootstrap = process.env.SKIP_BOOTSTRAP === '1';
    this.projectRoot = path.resolve(__dirname, '..', '..');

    const rawArgs = process.argv.slice(2);
    const separatorIndex = rawArgs.indexOf('--');
    this.sourceArgs = separatorIndex === -1 ? rawArgs : rawArgs.slice(0, separatorIndex);
    this.cliExtraFlags = separatorIndex === -1 ? [] : rawArgs.slice(separatorIndex + 1);

    if (this.sourceArgs.length === 0) {
      console.error('Usage: node <runner> <glob...|script-name> [-- --grep @smoke]');
      process.exit(1);
    }
  }

  // ── Helpers ──────────────────────────────────────────────

  isScriptName(arg) {
    return !arg.includes('/') && !arg.includes('*') && !arg.includes('\\');
  }

  parseHardhatScript(scriptCmd) {
    const tokens = [];
    const regex = /'([^']*)'|"([^"]*)"|(\S+)/g;
    let match;
    while ((match = regex.exec(scriptCmd)) !== null) {
      tokens.push(match[1] || match[2] || match[3]);
    }

    const hardhatIdx = tokens.findIndex((t) => t === 'hardhat');
    const testIdx = tokens.indexOf('test', hardhatIdx);
    if (testIdx === -1) {
      console.error(`Script command does not contain 'hardhat test': ${scriptCmd}`);
      process.exit(1);
    }

    const args = tokens.slice(testIdx + 1);
    const globs = [];
    const flags = [];

    for (let i = 0; i < args.length; i++) {
      if (args[i].startsWith('-')) {
        flags.push(args[i]);
        if (args[i] === '--grep' && i + 1 < args.length) flags.push(args[++i]);
      } else {
        globs.push(args[i]);
      }
    }

    return { globs, flags };
  }

  // ── File resolution ─────────────────────────────────────

  resolveFiles() {
    let globPatterns = [];
    let scriptFlags = [];

    if (this.sourceArgs.length === 1 && this.isScriptName(this.sourceArgs[0])) {
      const pkgPath = path.resolve(this.projectRoot, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const scriptName = this.sourceArgs[0];
      const scriptCmd = pkg.scripts && pkg.scripts[scriptName];

      if (!scriptCmd) {
        console.error(`Script "${scriptName}" not found in package.json`);
        process.exit(1);
      }

      console.log(`Resolving script "${scriptName}": ${scriptCmd}\n`);
      const parsed = this.parseHardhatScript(scriptCmd);
      globPatterns = parsed.globs;
      scriptFlags = parsed.flags;
    } else {
      globPatterns = this.sourceArgs;
    }

    this.flags = this._dedupeFlags([...scriptFlags, ...this.cliExtraFlags]);

    const allFiles = [...new Set(globPatterns.flatMap((p) => glob.sync(p)))].sort();

    if (allFiles.length === 0) {
      console.error('No test files matched the provided patterns');
      console.error('Patterns:', globPatterns);
      process.exit(1);
    }

    return allFiles;
  }

  _dedupeFlags(extraFlags) {
    // --bail: keep first, drop dupes (boolean flag).
    // --grep: keep last (CLI overrides script), pattern follows the flag.
    const out = [];
    for (let i = 0; i < extraFlags.length; i++) {
      const flag = extraFlags[i];
      if (flag === '--bail') {
        if (!out.includes('--bail')) out.push('--bail');
      } else if (flag === '--grep') {
        const prev = out.lastIndexOf('--grep');
        if (prev !== -1) out.splice(prev, 2);
        out.push('--grep');
        if (i + 1 < extraFlags.length) out.push(extraFlags[++i]);
      } else {
        out.push(flag);
      }
    }
    return out;
  }

  // ── Template methods (override in subclasses) ───────────

  /** Partition files into parallel and serial buckets. Default: all parallel. */
  partitionFiles(allFiles) {
    return { parallel: allFiles, serial: [] };
  }

  // ── Bootstrap phase ─────────────────────────────────────

  async bootstrap() {
    if (this.skipBootstrap) {
      console.log('SKIP_BOOTSTRAP=1 — skipping per-worker wallet bootstrap');
      return;
    }
    if (this.workerCount <= 1) {
      console.log(`PARALLEL_WORKERS=${this.workerCount} — no bootstrap needed`);
      return;
    }

    console.log(`\n── Bootstrap phase: granting ADMIN to ${this.workerCount} worker wallets ──`);

    const command = [
      'npx', 'hardhat', 'run',
      'scripts/runners/bootstrap-worker-wallets.ts',
      '--no-compile',
    ].join(' ');

    const code = await this._runChild(command, '[bootstrap]', {
      MOCHA_WORKER_ID: 'bootstrap',
      PARALLEL_WORKERS: String(this.workerCount),
    });

    if (code !== 0) {
      console.error('\nBootstrap failed — aborting run');
      process.exit(1);
    }
    console.log('── Bootstrap complete ──\n');
  }

  // ── Serial phase (runs BEFORE parallel) ─────────────────

  async runSerial(serialFiles) {
    if (serialFiles.length === 0) return;

    console.log(`── Serial phase: ${serialFiles.length} high-impact files ──`);
    serialFiles.forEach((f) => console.log(`  - ${f}`));
    console.log('');

    const command = ['npx', 'hardhat', 'test', ...serialFiles, ...this.flags].join(' ');

    const code = await this._runChild(command, '[serial]', {
      MOCHA_WORKER_ID: 'serial',
      PARALLEL_WORKERS: String(this.workerCount),
    });

    if (code !== 0) {
      console.error('\nSerial phase failed — aborting before parallel phase');
      this.mergeReports();
      process.exit(1);
    }
    console.log('── Serial phase passed ──\n');
  }

  // ── Child-process runner ────────────────────────────────

  _runChild(command, prefix, extraEnv) {
    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', command], {
        env: { ...process.env, ...extraEnv },
        stdio: ['inherit', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (data) => {
        data.toString().split('\n').forEach((line) => {
          if (line.trim()) console.log(`${prefix} ${line}`);
        });
      });
      child.stderr.on('data', (data) => {
        data.toString().split('\n').forEach((line) => {
          if (line.trim()) console.error(`${prefix} ${line}`);
        });
      });
      child.on('close', (code) => {
        resolve(code);
      });
    });
  }

  // ── Duration hints (for optimal queue ordering) ─────────

  /**
   * Reads test durations from the last mochawesome.json report.
   * Returns a map of { basename → durationMs }.
   * Used to sort the queue longest-first, so heavy tests start early
   * and don't become tail-end bottlenecks.
   */
  _loadDurationHints() {
    try {
      const reportPath = path.resolve(this.projectRoot, 'mochawesome-report', 'mochawesome.json');
      if (!fs.existsSync(reportPath)) return {};

      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      const hints = {};

      for (const result of (report.results || [])) {
        if (result.fullFile && typeof result.duration === 'number') {
          // Only trust durations from files that fully passed.
          // Timed-out/failed files record inflated durations (e.g. 960 s from a Mocha timeout)
          // which would push them to the front of every subsequent queue — thundering herd.
          const hasFailed = result.failures > 0 || result.pending > 0;
          if (!hasFailed) {
            hints[path.basename(result.fullFile)] = result.duration;
          }
        }
      }
      return hints;
    } catch {
      return {};
    }
  }

  /**
   * Sort files longest-first using duration data from the last run.
   * Unknown files go to the front (conservative — treat as potentially heavy).
   * Longest-first ensures heavy tests start early so they don't create
   * a long tail when all "fast" workers are idle and one worker still runs a 20-min test.
   */
  _sortByExpectedDuration(files) {
    const hints = this._loadDurationHints();
    return [...files].sort((a, b) => {
      const da = hints[path.basename(a)] ?? Infinity; // unknown → treat as longest
      const db = hints[path.basename(b)] ?? Infinity;
      return db - da; // descending: longest first
    });
  }

  // ── Dynamic parallel queue ──────────────────────────────

  /**
   * Work-stealing queue: N slots each process one file at a time.
   * When a slot finishes a file, it immediately pulls the next from the shared queue.
   * No idle workers — natural load balancing without static pre-assignment.
   *
   * Each file run gets a unique MOCHA_REPORT_SUFFIX (slotId-runIndex) so
   * mochawesome reports don't overwrite each other across multiple files per slot.
   */
  async runParallelWithQueue(parallelFiles) {
    if (parallelFiles.length === 0) return;

    const sortedFiles = this._sortByExpectedDuration(parallelFiles);
    const queue = [...sortedFiles];
    const total = queue.length;

    // Atomic queue cursor — safe in JS single-thread event loop
    // (no await between read and increment, so no concurrent mutation)
    let queuePos = 0;
    const failures = [];
    let bailFlag = false;
    const startTime = Date.now();

    // Per-slot stats for utilization reporting
    const slotStats = Array.from({ length: this.workerCount }, () => ({
      filesCompleted: 0,
      totalMs: 0,
    }));

    console.log(`── Parallel phase: ${total} files | ${this.workerCount} slots | dynamic queue ──`);
    console.log(`   Queue sorted longest-first using duration hints from last run.\n`);

    // Progress reporter
    const progressTimer = setInterval(() => {
      const elapsedSec = Math.round((Date.now() - startTime) / 1000);
      const dispatched = Math.min(queuePos, total);
      const h = String(Math.floor(elapsedSec / 3600)).padStart(2, '0');
      const m = String(Math.floor((elapsedSec % 3600) / 60)).padStart(2, '0');
      const s = String(elapsedSec % 60).padStart(2, '0');
      const slotSummary = slotStats.map((st, i) => `slot-${i}:${st.filesCompleted}files`).join(' ');
      console.log(`[${h}:${m}:${s}] Dispatched ${dispatched}/${total} | ${failures.length} failures | ${slotSummary}`);
    }, 60000);

    const runSlot = async (slotId) => {
      // Stagger startup to avoid thundering herd on chain state
      if (slotId > 0 && this.staggerDelayMs > 0) {
        await new Promise((r) => setTimeout(r, slotId * this.staggerDelayMs));
      }

      let runIndex = 0;

      while (!bailFlag) {
        // Dequeue next file — atomic because JS event loop is single-threaded
        // between synchronous operations (no await here)
        const fileIndex = queuePos++;
        if (fileIndex >= total) break;

        const file = queue[fileIndex];
        // Unique suffix prevents mochawesome report overwrites across files per slot
        const reportSuffix = `${slotId}-${runIndex}`;
        const command = ['npx', 'hardhat', 'test', file, ...this.flags].join(' ');
        const basename = path.basename(file);

        console.log(`[slot-${slotId}] → (${fileIndex + 1}/${total}) ${basename}`);
        const fileStart = Date.now();

        const code = await this._runChild(command, `[slot-${slotId}]`, {
          MOCHA_WORKER_ID: String(slotId),
          PARALLEL_WORKERS: String(this.workerCount),
          MOCHA_REPORT_SUFFIX: reportSuffix,
        });

        const fileMs = Date.now() - fileStart;
        slotStats[slotId].filesCompleted++;
        slotStats[slotId].totalMs += fileMs;
        runIndex++;

        console.log(`[slot-${slotId}] ✓ ${basename} (${Math.round(fileMs / 1000)}s)`);

        if (code !== 0) {
          failures.push({ file, slotId, fileIndex });
          if (this.flags.includes('--bail')) {
            bailFlag = true;
            break;
          }
        }
      }

      const utilPct = slotStats[slotId].totalMs > 0
        ? Math.round((slotStats[slotId].totalMs / (Date.now() - startTime)) * 100)
        : 0;
      console.log(`[slot-${slotId}] done — ${slotStats[slotId].filesCompleted} files, ~${utilPct}% busy`);
    };

    // Start all slots concurrently — they share the queue via closure
    await Promise.all(Array.from({ length: this.workerCount }, (_, i) => runSlot(i)));
    clearInterval(progressTimer);

    const totalElapsed = Math.round((Date.now() - startTime) / 1000);
    console.log('\n── Parallel phase summary ──');
    slotStats.forEach((st, i) => {
      const utilPct = st.totalMs > 0 ? Math.round((st.totalMs / (totalElapsed * 1000)) * 100) : 0;
      console.log(`  slot-${i}: ${st.filesCompleted} files | ${Math.round(st.totalMs / 1000)}s active | ~${utilPct}% busy`);
    });

    if (failures.length > 0) {
      console.error(`\n${failures.length}/${total} parallel files failed:`);
      failures.forEach((f) => console.error(`  FAILED (slot-${f.slotId}): ${f.file}`));
      this.mergeReports();
      process.exit(1);
    }
    console.log(`\nAll ${total} parallel files passed in ${totalElapsed}s`);
  }

  // ── Report merging ──────────────────────────────────────

  mergeReports() {
    const reportDir = path.resolve(this.projectRoot, 'mochawesome-report');
    const workerJsons = glob.sync(path.join(reportDir, 'worker-*.json'));

    if (workerJsons.length === 0) {
      console.warn('No worker report JSONs found to merge');
      return;
    }

    console.log(`\nMerging ${workerJsons.length} report JSONs...`);

    const mergedPath = path.join(reportDir, 'mochawesome.json');

    try {
      execSync(`npx mochawesome-merge ${workerJsons.map(f => `"${f}"`).join(' ')} -o "${mergedPath}"`, {
        stdio: 'inherit',
        cwd: this.projectRoot,
      });

      execSync(`npx marge "${mergedPath}" -o "${reportDir}" --inline`, {
        stdio: 'inherit',
        cwd: this.projectRoot,
      });

      workerJsons.forEach(f => fs.unlinkSync(f));
      console.log('Merged report: mochawesome-report/mochawesome.html');
    } catch (err) {
      console.error('Report merge failed:', err.message);
    }
  }

  // ── Relayer recovery (post-serial) ─────────────────────

  /**
   * Some @serial tests (double-spend suite) stop and restart Docker relayer containers.
   * The parallel phase must not start until all relayers have been running for
   * MIN_RELAYER_UPTIME_MS — otherwise cross-chain txs queue behind the relayer's
   * catch-up backlog and basic payment tests hit their timeouts.
   */
  async awaitRelayerRecovery() {
    const MIN_UPTIME_MS = parseInt(process.env.MIN_RELAYER_UPTIME_MS || String(2 * 60 * 1000), 10);
    const POLL_INTERVAL_MS = 30 * 1000;

    const UNIT_MS = { second: 1000, minute: 60000, hour: 3600000, day: 86400000 };

    const getRecent = () => {
      try {
        const out = execSync('docker ps --format "{{.Names}}\t{{.Status}}"', {
          encoding: 'utf8',
          timeout: 10000,
        });
        return out.split('\n')
          .filter(line => line.includes('relayer-'))
          .map(line => {
            const [name, status] = line.split('\t');
            const m = status && status.match(/Up (\d+) (second|minute|hour|day)/);
            if (!m) return null;
            const uptimeMs = parseInt(m[1]) * UNIT_MS[m[2]];
            return uptimeMs < MIN_UPTIME_MS ? { name: name.trim(), uptimeMs } : null;
          })
          .filter(Boolean);
      } catch {
        return []; // docker not available — skip
      }
    };

    let recent = getRecent();
    if (recent.length === 0) return;

    console.log(`\n── Relayer recovery: ${recent.length} container(s) restarted within last ${MIN_UPTIME_MS / 60000}m ──`);
    recent.forEach(r => console.log(`  ${r.name}: up ${Math.round(r.uptimeMs / 1000)}s`));
    console.log(`Waiting until all relayers have been up >= ${MIN_UPTIME_MS / 60000} min...`);

    while (recent.length > 0) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      recent = getRecent();
      if (recent.length > 0) {
        console.log(`  Still waiting for: ${recent.map(r => r.name).join(', ')}`);
      }
    }
    console.log('── All relayers ready ──\n');
  }

  // ── Main orchestrator ───────────────────────────────────

  async run() {
    const allFiles = this.resolveFiles();
    const { parallel: parallelFiles, serial: serialFiles } = this.partitionFiles(allFiles);

    console.log(`Resolved ${allFiles.length} files total (${parallelFiles.length} parallel, ${serialFiles.length} serial)`);
    if (this.flags.length) console.log(`Flags: ${this.flags.join(' ')}`);

    // Phase 1: bootstrap (grants ADMIN to each worker wallet on every chain)
    await this.bootstrap();

    // Phase 2: serial high-impact tests (sequential, seed wallet)
    await this.runSerial(serialFiles);

    // Phase 2.5: wait for Docker relayers to recover if double-spend tests restarted them
    await this.awaitRelayerRecovery();

    // Phase 3: dynamic work queue — slots pull files one-at-a-time, no idle workers
    await this.runParallelWithQueue(parallelFiles);

    this.mergeReports();

    const summary = [
      serialFiles.length > 0 ? `${serialFiles.length} serial` : null,
      parallelFiles.length > 0 ? `${parallelFiles.length} parallel` : null,
    ].filter(Boolean).join(' + ');
    console.log(`\nAll tests passed (${summary})`);
  }
}

module.exports = BaseParallelRunner;
