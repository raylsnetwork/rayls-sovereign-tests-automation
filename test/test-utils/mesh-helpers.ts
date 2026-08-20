import { expect } from 'chai';
import { LOGGER } from '../../src/config/env-config';
import { PrivacyNode } from '../../src/entities/PrivacyNode';
import { eventually } from '../../src/utils/common';
import JsonReporter from '../performance/reporters/JsonReporter';

export interface TPSInput {
  result: { totalTxCount: number; direction: string };
  elapsedTime: number;
}

export interface ReportTPSOptions {
  testType: string;
  rpnCount?: number;
  methodology?: string;
}

export async function everyoneToAllParticipants(
  participants: PrivacyNode[],
  callback: (source: PrivacyNode, destinations: PrivacyNode[]) => Promise<void>
): Promise<void> {
  for (const source of participants) {
    const destinations = participants.filter(x => x.node !== source.node);
    await callback(source, destinations);
  }
}

/**
 * Wraps a callback and measures elapsed time from `startTime` (defaults to now).
 * Pass a pre-captured startTime to measure from before a batch was submitted.
 */
export async function trackTime<T extends { totalTxCount: number; direction: string }>(
  callback: () => Promise<T>,
  startTime = Date.now()
): Promise<TPSInput> {
  const result = await callback();
  return { result, elapsedTime: (Date.now() - startTime) / 1000 };
}

/**
 * Polls `getBalanceFn` until it equals `expected`, then asserts.
 */
export async function waitForBalance(
  getBalanceFn: () => Promise<bigint>,
  expected: bigint,
  label: string,
  pollingTimeout: [number, number] = [3000, 3600]
): Promise<void> {
  const reached = await eventually<boolean>({
    check: async (): Promise<boolean> => {
      const balance = await getBalanceFn();
      LOGGER.log(`${label} balance=${balance} expected=${expected}`);
      return balance === expected;
    },
    interval: pollingTimeout[0],
    attempts: pollingTimeout[1],
    message: `Waiting for ${label} balance → ${expected}`,
    tolerateErrors: true,
  });

  expect(reached, `${label} balance did not reach ${expected} within timeout`).to.be.true;
  LOGGER.info(`${label} balance settled at ${expected}`);
}

export function reportTPS(inputs: TPSInput[], options: ReportTPSOptions): void {
  const { testType, rpnCount, methodology } = options;
  let avgTPS = 0;
  let totalTx = 0;
  let maxElapsed = 0;
  const startTime = Date.now();

  LOGGER.info(`=== ${testType} TPS Results ===`);

  for (const { result, elapsedTime } of inputs) {
    const tps = result.totalTxCount / elapsedTime;
    avgTPS += tps / inputs.length;
    totalTx += result.totalTxCount;
    if (elapsedTime > maxElapsed) maxElapsed = elapsedTime;
    LOGGER.info(`${result.direction}: ${result.totalTxCount}tx / ${elapsedTime.toFixed(2)}s = ${tps.toFixed(2)} TPS`);
  }

  LOGGER.info(`Average TPS: ${avgTPS.toFixed(2)}`);

  try {
    const reporter = new JsonReporter();
    reporter.generateReport({
      testType,
      startTime,
      endTime: startTime + Math.round(maxElapsed * 1000),
      transactionCount: totalTx,
      actualTPS: avgTPS.toFixed(2),
      duration: maxElapsed,
      successfulTransactions: totalTx,
      failedTransactions: 0,
      rpnCount,
      methodology,
    } as any);
  } catch (e) {
    LOGGER.info(`JSON report skipped: ${e}`);
  }
}