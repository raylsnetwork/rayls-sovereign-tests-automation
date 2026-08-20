import { Pool, QueryResult, QueryResultRow } from 'pg';
import { LOGGER } from '../config/env-config';

const pools: Map<string, Pool> = new Map();

export function getPool(connectionString: string): Pool {
  if (!pools.has(connectionString)) {
    const pool = new Pool({
      connectionString,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });
    // pg emits an asynchronous 'error' on a POOLED, IDLE backend connection
    // when the server drops it — a DB restart/failover, an admin
    // pg_terminate_backend (PostgreSQL 57P01), or a brief network blip. With
    // no listener Node escalates it to an uncaught exception and kills the
    // whole test run, even though the next query would just reconnect. This
    // defeats the `tolerateErrors`/retry intent of long-polling resilience
    // tests (the error fires between queries, so it bypasses the caller's
    // try/catch). Swallow it with a redacted log; in-flight queries still
    // reject normally and remain retryable by the caller.
    pool.on('error', (err) => {
      const safeCs = connectionString.replace(/\/\/[^@]*@/, '//***@');
      LOGGER.error(`[pg-client] idle pool connection error (${safeCs}): ${err.message}`);
    });
    pools.set(connectionString, pool);
  }
  return pools.get(connectionString)!;
}

export async function query<T extends QueryResultRow = any>(
  connectionString: string,
  sql: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const pool = getPool(connectionString);
  return pool.query<T>(sql, params);
}

export async function queryOne<T extends QueryResultRow = any>(
  connectionString: string,
  sql: string,
  params?: any[]
): Promise<T | null> {
  const result = await query<T>(connectionString, sql, params);
  return result.rows[0] ?? null;
}

export async function closeAllPools(): Promise<void> {
  for (const pool of pools.values()) {
    await pool.end();
  }
  pools.clear();
}
