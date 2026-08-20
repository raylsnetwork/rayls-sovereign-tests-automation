// import config before anything else
import '@openzeppelin/hardhat-upgrades';
import '@solarity/hardhat-gobind';
import '@typechain/hardhat';
import { config as dotEnvConfig } from 'dotenv';
import { HardhatUserConfig, task, subtask } from 'hardhat/config';
// require("hardhat-contract-sizer");
import '@nomicfoundation/hardhat-chai-matchers';
import 'hardhat-contract-sizer';
import 'hardhat-artifactor';
dotEnvConfig();

// MOCHA_REPORT_SUFFIX (parallel-runner per-file slot) takes priority over MOCHA_WORKER_ID
// (legacy per-worker tag). Either presence flips the report into JSON-only/quiet mode.
const REPORT_TAG = process.env.MOCHA_REPORT_SUFFIX || process.env.MOCHA_WORKER_ID;

// Imports for resolving the solidity compilation crash with larger contracts codebases
import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } from 'hardhat/builtin-tasks/task-names';
import { TASK_TYPECHAIN_GENERATE_TYPES } from '@typechain/hardhat/dist/constants';
import * as path from 'path';
import * as fs from 'fs';
import * as glob from 'glob'; // Import glob for use in the task

// Module-scoped variable to store files to compile.
// This is how our custom task communicates with the subtask.
let filesToCompileForCurrentRun: string[] = [];

// This subtask hooks into Hardhat's internal process of finding source files.
subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS).setAction(async (taskArgs, hre, runSuper) => {
  const allSourcePaths = await runSuper(taskArgs); // Get all source paths Hardhat usually sees

  // If our custom variable has files, filter the list
  if (filesToCompileForCurrentRun.length > 0) {
    const targetAbsolutePaths = filesToCompileForCurrentRun.map(file => path.resolve(file));
    const filteredPaths = allSourcePaths.filter((p: string) => targetAbsolutePaths.includes(path.resolve(p)));

    if (filteredPaths.length === 0 && filesToCompileForCurrentRun.length > 0) {
      console.warn(
        `Warning: No Solidity files found matching the specified paths for this compilation step. Check paths: ${filesToCompileForCurrentRun.join(', ')}`
      );
    }
    return filteredPaths;
  }

  return allSourcePaths; // If no specific files are set, run as normal
});

// Define a custom task to compile specific files/directories
task('compile-subset', 'Compiles a specified subset of Solidity files or directories')
  .addVariadicPositionalParam<string>(
    'pathsToCompile',
    "The Solidity files or directories to compile (e.g., 'src/MyContract.sol' or 'src/myDir/**/*.sol')"
  )
  .setAction(async ({ pathsToCompile }, hre) => {
    if (!pathsToCompile || pathsToCompile.length === 0) {
      console.error('Error: No files or directories specified for compilation.');
      process.exit(1);
    }

    // Resolve glob patterns for directories
    let resolvedFiles: string[] = [];
    for (const p of pathsToCompile) {
      if (p.includes('*')) {
        // It's a glob pattern
        const matches = glob.sync(path.resolve(p), { cwd: process.cwd() }); // Ensure correct cwd
        resolvedFiles.push(...matches);
      } else {
        // It's a direct file path
        resolvedFiles.push(path.resolve(p));
      }
    }

    // Filter to ensure only .sol files are passed (glob might pick up other files)
    resolvedFiles = resolvedFiles.filter(file => file.endsWith('.sol'));

    if (resolvedFiles.length === 0) {
      console.warn(`No .sol files found after resolving patterns: ${pathsToCompile.join(', ')}`);
      return; // Don't run compile if no files found
    }

    // Set the module-scoped variable for the subtask
    filesToCompileForCurrentRun = resolvedFiles;

    console.log(
      `\nStarting compilation for:\n - ${resolvedFiles.map(f => path.relative(process.cwd(), f)).join('\n - ')}`
    );

    try {
      await hre.run('compile');
      console.log(`Compilation for subset finished successfully.`);
    } catch (error) {
      console.error('Error during subset compilation:', error);
      process.exit(1);
    } finally {
      // Clear the filter after compilation so subsequent `hre.run("compile")`
      // or other tasks don't inadvertently use this filter.
      filesToCompileForCurrentRun = [];
    }
  });

// Pre-warm the typechain output directory tree before typechain starts writing.
// Typechain 8.3.2's processOutput does mkdirp.sync(parent) + writeFileSync(path)
// in adjacent syscalls; on Node 22 / heavily-loaded VFS this occasionally
// surfaces a stale ENOENT for the freshly-created parent dir. Creating every
// dir typechain will need well before it starts writing closes the race
// window without retries or patching typechain.
subtask(TASK_TYPECHAIN_GENERATE_TYPES).setAction(async (args, hre, runSuper) => {
  const root = hre.config.paths.root;
  const artifactsRoot = path.resolve(root, hre.config.paths.artifacts);
  const outDir = path.resolve(root, hre.config.typechain.outDir);
  const factoriesDir = path.join(outDir, 'factories');

  if (fs.existsSync(artifactsRoot)) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(factoriesDir, { recursive: true });

    const stack: string[] = [artifactsRoot];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name === 'build-info') continue;
        const full = path.join(dir, e.name);
        const rel = path.relative(artifactsRoot, full);
        fs.mkdirSync(path.join(outDir, rel), { recursive: true });
        fs.mkdirSync(path.join(factoriesDir, rel), { recursive: true });
        stack.push(full);
      }
    }
  }

  return runSuper(args);
});

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: {
        enabled: true,
        runs: 50,
      },
      evmVersion: 'paris',
    },
  },
  typechain: {
    outDir: 'typechain-types',
    target: 'ethers-v6',
    alwaysGenerateOverloads: false,
    discriminateTypes: false,
    externalArtifacts: ['external/*.json'],
  },
  paths: {
    tests: './test',
    artifacts: './artifacts',
    cache: './cache',
    sources: './contracts/remote',
  },
  networks: (() => {
    const networks: any = {
      // Static networks from HEAD
      localcc: {
        url: 'http://0.0.0.0:8547',
        accounts: ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'],
        timeout: 80000,
      },
      localCC: {
        url: 'http://private-hub:3445',
        accounts: ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'],
        timeout: 80000,
        chainId: 1337,
      },
      localA: {
        url: 'http://pn-a:8545',
        accounts: ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'],
        timeout: 80000,
        chainId: 12345,
      },
      localB: {
        url: 'http://pn-b:8546',
        accounts: ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'],
        timeout: 80000,
        chainId: 12346,
      },
      localC: {
        url: 'http://pn-c:8547',
        accounts: ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'],
        timeout: 80000,
        chainId: 12347,
      },
      localD: {
        url: 'http://pn-d:8548',
        accounts: ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'],
        timeout: 80000,
        chainId: 12348,
      },
      localE: {
        url: 'http://pn-e:8549',
        accounts: ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'],
        timeout: 80000,
        chainId: 12349,
      },
      localF: {
        url: 'http://pn-f:8550',
        accounts: ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'],
        timeout: 80000,
        chainId: 12350,
      },
      ganache: {
        url: 'HTTP://127.0.0.1:7545',
        accounts: ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'],
        timeout: 80000,
      },
    };

    // Add custom_cc network if PNH_RPC_URL is available
    if (process.env['PNH_RPC_URL']) {
      networks.custom_cc = {
        url: process.env['PNH_RPC_URL']!,
        accounts: [process.env['PRIVATE_KEY_SYSTEM']!],
        timeout: 80000,
        chainId: +process.env['PNH_CHAIN_ID']!,
        gasPrice: 0,
        initialBaseFeePerGas: 0,
      };
    }

    // Add custom_pn network if RPC_URL_NODE_PN is available
    if (process.env['RPC_URL_NODE_PN']) {
      networks.custom_pn = {
        url: process.env['RPC_URL_NODE_PN']!,
        accounts: [process.env['PRIVATE_KEY_SYSTEM']!],
        timeout: 80000,
        chainId: +process.env['NODE_PN_CHAIN_ID']!,
      };
    }

    return networks;
  })(),
  contractSizer: {
    alphaSort: true,
    runOnCompile: false,
    disambiguatePaths: false,
  },
  gobind: {
    outdir: './bindings',
    deployable: true,
    runOnCompile: false,
    verbose: true,
    onlyFiles: ['contracts/remote/rayls-protocol-sdk/'],
    skipFiles: [
      'contracts/remote/privateHub/Pedersen/Curve.sol',
      'contracts/remote/privateHub/Pedersen/Ecc.sol',
      'contracts/remote/rayls-protocol/Constants.sol',
      'contracts/remote/rayls-protocol/interfaces/',
      'contracts/remote/rayls-protocol/utils/RaylsReentrancyGuardV1.sol',
      'contracts/remote/rayls-protocol/EnygmaWrapper/EnygmaWithdrawFromDvpVerifierk6Proxy.sol',
      'contracts/remote/rayls-protocol/EnygmaWrapper/EnygmaWithdrawFromDvpVerifierk2Proxy.sol',
      'contracts/remote/rayls-protocol/EnygmaWrapper/EnygmaDepositToDvpVerifierk2Proxy.sol',
      'contracts/remote/rayls-protocol/EnygmaWrapper/EnygmaDepositToDvpVerifierk6Proxy.sol',
      'contracts/remote/rayls-protocol/EnygmaWrapper/EnygmaVerifierk2Proxy.sol',
      'contracts/remote/rayls-protocol/EnygmaWrapper/EnygmaVerifierk6Proxy.sol',
      '@openzeppelin',
      '@solarity',
    ],
  },
  mocha: {
    timeout: 80000,
    retries: 0,
    require: ['ts-node/register', './test/setup.ts'],
    reporter: 'mochawesome',
    reporterOptions: {
      reportDir: 'mochawesome-report',
      reportFilename: REPORT_TAG ? `worker-${REPORT_TAG}` : 'mochawesome',
      overwrite: true,
      json: true,
      html: !REPORT_TAG,
      quiet: !!REPORT_TAG
    }
  }
};
export default config;
