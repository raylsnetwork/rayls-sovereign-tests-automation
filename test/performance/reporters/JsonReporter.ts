import fs from 'fs';
import path from 'path';
import { VersionUtils } from './VersionUtils';
import { LOGGER } from '../../../src/config/env-config';

interface ReporterOptions {
  outputDir?: string;
}

export default class JsonReporter {
  private outputDir: string;

  constructor(options: ReporterOptions = {}) {
    this.outputDir = options.outputDir || path.join(__dirname, '../reports');

      if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  generateReport(testData: any, filename?: string): string | null {
    if (!filename) {
      const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
      filename = `enygma-performance_${timestamp}.json`;
    }

      const filePath = path.join(this.outputDir, filename);
    const metrics = this._buildMetrics(testData);
    try {
      fs.writeFileSync(filePath, JSON.stringify(metrics, null, 2));
      LOGGER.log(`Performance metrics saved to ${filePath}`);
      return filePath;
    } catch (error: any) {
      LOGGER.error(`Error saving JSON report: ${error.message}`);
      return null;
    }
  }

  private _buildMetrics(testData: any) {
    const {
      testType = 'A→B Performance Test',
      startTime,
      endTime,
      transactionCount,
      actualTPS,
      duration,
      successfulTransactions,
      failedTransactions = 0,
      rpcUrlA,
      methodology,
      // RPN information
      rpnCount,
      // Stability test fields
      testStartTime,
      settlementEndTime,
      totalTransactions,
      overallTPS,
      totalDuration,
      settlementDuration,
      batchSize,
      // Sequential test fields
      avgTimeBetweenSends,
      // Flow test fields
      totalFlowDuration,
      stepBreakdown,
      configuration,
    } = testData || {};

    // Automatically get version information
    const versionInfo = VersionUtils.getVersionInfo();

    const finalStartTime = startTime || testStartTime;
    const finalEndTime = endTime || settlementEndTime;
    const finalTransactionCount = transactionCount || totalTransactions;
    const finalTPS = actualTPS || overallTPS;
    const finalDuration = duration || totalDuration || settlementDuration;

    const successRate = finalTransactionCount > 0
      ? ((successfulTransactions || finalTransactionCount) / finalTransactionCount) * 100
      : 0;

    const environment = this._detectEnvironment(rpcUrlA);

    const baseReport: any = {
      testType,
      environment,
      version: versionInfo.version,
      startTime: finalStartTime || Date.now(),
      endTime: finalEndTime || Date.now(),
      methodology: methodology || '',
      summary: {
        tps: parseFloat(finalTPS) || 0,
        successRate: parseFloat(successRate.toFixed(2)),
        hardFinality: parseFloat(finalDuration) || 0,
        totalTransactions: finalTransactionCount || 0,
        successfulTransactions: successfulTransactions || finalTransactionCount || 0,
        failedTransactions: failedTransactions,
        batchSize: batchSize,
        avgTimeBetweenSends: avgTimeBetweenSends ?? null,
        rpnCount: rpnCount ?? null,
      },
      transactions: [],
    };

    // Add flow-specific fields if present
    if (totalFlowDuration !== undefined) {
      baseReport.totalFlowDuration = totalFlowDuration;
    }
    if (stepBreakdown !== undefined) {
      baseReport.stepBreakdown = stepBreakdown;
    }
    if (configuration !== undefined) {
      baseReport.configuration = configuration;
    }

    return baseReport;
  }

  private _detectEnvironment(rpcUrl?: string): string {
    if (!rpcUrl) return 'unknown';
    const url = rpcUrl.toLowerCase();
    if (url.includes('pn-a:8545') || url.includes('localhost') || url.includes('127.0.0.1')) return 'local';
    return 'unknown';
  }
}


