import fs from 'fs';
import path from 'path';
import { VersionUtils } from './VersionUtils';
import { LOGGER } from '../../../src/config/env-config';

interface ReporterOptions {
  outputDir?: string;
}

export default class HtmlReporter {
  private outputDir: string;

  constructor(options: ReporterOptions = {}) {
    this.outputDir = options.outputDir || path.join(__dirname, '../reports');
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  generateReport(metrics: any, filename?: string): string | null {
    if (!filename) {
      const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
      filename = `${metrics.testType}_${timestamp}.html`;
    }

    const filePath = path.join(this.outputDir, filename);
    const html = this._generateHtml(metrics);

    try {
      fs.writeFileSync(filePath, html);
      return filePath;
    } catch (error: any) {
      LOGGER.error(`Error saving HTML report: ${error.message}`);
      return null;
    }
  }

  private _generateHtml(metrics: any): string {
    const summary = metrics.summary || {};
    const isFlowTest = metrics.totalFlowDuration !== undefined && metrics.stepBreakdown !== undefined;

    // Automatically get version information
    const versionInfo = VersionUtils.getVersionInfo();

    // Legacy TPS-based report values
    const successRate = summary.totalTransactions
      ? ((summary.successfulTransactions / summary.totalTransactions) * 100).toFixed(2)
      : 0;
    const duration = summary.hardFinality ? summary.hardFinality.toFixed(2) : 0;
    const tps = summary.tps ? summary.tps.toFixed(2) : 0;
    const batchSize = summary.batchSize ?? '';
    const avgTimeBetweenSends = summary.avgTimeBetweenSends ?? null;

    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Enygma Test Report</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 1200px; margin: 0 auto; padding: 20px; position: relative; }
          h1, h2, h3 { color: #2c3e50; }
          .version-badge {
            position: absolute;
            top: 0;
            left: 0;
            background: #2c3e50;
            color: #ffffff;
            padding: 8px 12px;
            border-radius: 0 0 8px 0;
            font-size: 14px;
            font-weight: 600;
            font-family: 'Courier New', monospace;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
            letter-spacing: 0.5px;
            z-index: 10;
          }
          .header { text-align: center; margin-bottom: 30px; padding-bottom: 20px; border-bottom: 1px solid #eee; margin-top: 25px; }
          .summary-cards { display: flex; flex-wrap: nowrap; gap: 8px; margin-bottom: 30px; overflow-x: auto; }
          .card { background: #f8f9fa; border-radius: 8px; padding: 15px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); flex: 1; min-width: 140px; }
          .card h3 { margin-top: 0; font-size: 16px; color: #6c757d; }
          .card .value { font-size: 24px; font-weight: bold; color: #2c3e50; }
          .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; color: #6c757d; font-size: 14px; }
          @media (max-width: 768px) { .summary-cards { flex-direction: column; } .card { width: 100%; margin-right: 0; } }
        </style>
      </head>
      <body>
        <div class="version-badge">Version ${versionInfo.version.replace(/^version-?/i, '')}</div>
        <div class="header">
          <h1>Enygma Test Report</h1>
          <p>Test Type: ${metrics.testType}</p>
          <p>Environment: ${metrics.environment || 'unknown'}</p>
          <p>Start Time: ${metrics.startTime ? new Date(metrics.startTime).toLocaleString() : 'N/A'}</p>
          <p>End Time: ${metrics.endTime ? new Date(metrics.endTime).toLocaleString() : 'N/A'}</p>
        </div>

        <h2>Summary</h2>
        <div class="summary-cards">
          ${isFlowTest ? `
          <div class="card">
            <h3>Total Flow Duration</h3>
            <div class="value">${metrics.totalFlowDuration ? metrics.totalFlowDuration.toFixed(2) : 'N/A'}s</div>
            <div style="font-size:12px;color:#6c757d;margin-top:4px;">(deposit → withdrawal complete)</div>
          </div>
          <div class="card">
            <h3>RPN <span style="font-size:10px;font-weight:normal;">(Rayls Privacy Nodes)</span></h3>
            <div class="value">${summary.rpnCount || 'N/A'}</div>
          </div>
          <div class="card" style="display: ${avgTimeBetweenSends !== null && avgTimeBetweenSends > 0.0001 ? 'block' : 'none'};">
            <h3>Send Interval</h3>
            <div class="value">${avgTimeBetweenSends ? avgTimeBetweenSends.toFixed(4) : '0.0000'}ms</div>
            <div style="font-size:12px;color:#6c757d;margin-top:4px;">(avg time between transaction sends)</div>
          </div>
          <div class="card" style="display: ${batchSize !== '' ? 'block' : 'none'};">
            <h3>Batch Size</h3>
            <div class="value">${batchSize || 'N/A'}</div>
          </div>
          ` : `
          <div class="card">
            <h3>TPS</h3>
            <div class="value">${tps}</div>
            <div style="font-size:12px;color:#6c757d;margin-top:4px;">(transactions per second)</div>
          </div>
          <div class="card">
            <h3>Success Rate</h3>
            <div class="value">${successRate}%</div>
          </div>
          <div class="card">
            <h3>Duration</h3>
            <div class="value">${duration}s</div>
            <div style="font-size:12px;color:#6c757d;margin-top:4px;">(first transaction → last settlement)</div>
          </div>
          <div class="card">
            <h3>Total Transactions</h3>
            <div class="value">${summary.totalTransactions || 0}</div>
          </div>
          <div class="card">
            <h3>RPN <span style="font-size:10px;font-weight:normal;">(Rayls Privacy Nodes)</span></h3>
            <div class="value">${summary.rpnCount || 'N/A'}</div>
          </div>
          <div class="card" style="display: ${avgTimeBetweenSends !== null && avgTimeBetweenSends > 0.0001 ? 'block' : 'none'};">
            <h3>Send Interval</h3>
            <div class="value">${avgTimeBetweenSends ? avgTimeBetweenSends.toFixed(4) : '0.0000'}ms</div>
            <div style="font-size:12px;color:#6c757d;margin-top:4px;">(avg time between transaction sends)</div>
          </div>
          <div class="card" style="display: ${batchSize !== '' ? 'block' : 'none'};">
            <h3>Batch Size</h3>
            <div class="value">${batchSize || 'N/A'}</div>
          </div>
          `}
        </div>

        ${isFlowTest && metrics.stepBreakdown ? `
        <h2>Step Breakdown</h2>
        <div class="summary-cards">
          <div class="card">
            <h3>Token Deposit</h3>
            <div class="value">${metrics.stepBreakdown.depositDuration ? metrics.stepBreakdown.depositDuration.toFixed(2) : 'N/A'}s</div>
          </div>
          <div class="card">
            <h3>NFT Deposit</h3>
            <div class="value">${metrics.stepBreakdown.nftDepositDuration ? metrics.stepBreakdown.nftDepositDuration.toFixed(2) : 'N/A'}s</div>
          </div>
          <div class="card">
            <h3>Swap</h3>
            <div class="value">${metrics.stepBreakdown.swapDuration ? metrics.stepBreakdown.swapDuration.toFixed(2) : 'N/A'}s</div>
          </div>
          <div class="card">
            <h3>NFT Withdrawal</h3>
            <div class="value">${metrics.stepBreakdown.nftWithdrawDuration ? metrics.stepBreakdown.nftWithdrawDuration.toFixed(2) : 'N/A'}s</div>
          </div>
          <div class="card">
            <h3>Token Withdrawal</h3>
            <div class="value">${metrics.stepBreakdown.tokenWithdrawDuration ? metrics.stepBreakdown.tokenWithdrawDuration.toFixed(2) : 'N/A'}s</div>
          </div>
        </div>
        ` : ''}

        ${metrics.methodology ? `
        <h2>Methodology</h2>
        <p>${metrics.methodology}</p>
        ` : ''}

        <div class="footer">
          <p>Generated by Enygma Performance Testing Suite</p>
          <p>Report generated on ${new Date().toLocaleString()}</p>
        </div>
      </body>
      </html>
    `;
  }
}


