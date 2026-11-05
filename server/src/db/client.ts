import { AsyncLocalStorage } from "node:async_hooks";

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { requireDatabaseUrl } from "./env";
import * as schema from "./schema";

/**
 * 连接池与查询保护（arch/12 §14.3）：
 * - 显式化 max/idle/获取超时（杜绝 06b 式挂起——获取超时显式报错）；
 * - 连接级 statement_timeout（跑飞查询快速失败）；
 * - 慢查询 warn 日志（>SLOW_QUERY_MS，含 requestId 关联——经 requestContext ALS 贯通）。
 * 全部 env 可调（prod compose 注入），默认值见下。
 */
const POOL_MAX = Number(process.env.PG_POOL_MAX ?? 20);
const POOL_IDLE_MS = Number(process.env.PG_POOL_IDLE_MS ?? 30000);
const POOL_CONN_TIMEOUT_MS = Number(process.env.PG_POOL_CONN_TIMEOUT_MS ?? 5000);
const STATEMENT_TIMEOUT_MS = Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 15000);
const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS ?? 500);

/** 请求上下文（requestId 贯通慢查询/审计日志；app 首个中间件 run 注入） */
export const requestContext = new AsyncLocalStorage<{ requestId: string }>();

function warnSlow(ms: number, sql: unknown): void {
  if (ms <= SLOW_QUERY_MS) return;
  const sqlText = typeof sql === "string" ? sql : JSON.stringify(sql);
  console.warn(
    JSON.stringify({
      level: "warn",
      type: "slow_query",
      ms: Math.round(ms),
      requestId: requestContext.getStore()?.requestId ?? null,
      sql: sqlText.slice(0, 200),
    }),
  );
}

/** 计时包装 query（promise 模式）；drizzle 驱动与直查均走 promise */
function timedQuery<T extends Record<string, unknown>>(target: T, fnKey: "query"): T {
  const original = (target[fnKey] as (...args: unknown[]) => unknown).bind(target);
  (target as Record<string, unknown>)[fnKey] = (...args: unknown[]) => {
    const startedAt = performance.now();
    const result = original(...args) as Promise<unknown> & { then?: unknown };
    if (result && typeof result.then === "function") {
      return result.finally(() => warnSlow(performance.now() - startedAt, args[0]));
    }
    return result;
  };
  return target;
}

export const pool = new pg.Pool({
  connectionString: requireDatabaseUrl(),
  max: POOL_MAX,
  idleTimeoutMillis: POOL_IDLE_MS,
  connectionTimeoutMillis: POOL_CONN_TIMEOUT_MS,
});

pool.on("connect", (client) => {
  client
    .query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
    .catch((error: unknown) => console.warn("statement_timeout 设置失败", error));
  timedQuery(client as unknown as Record<string, unknown>, "query");
});

// pool.query 直查路径计时（checkout 的连接已另行包装，此处覆盖不经 connect 复用的调用面）
timedQuery(pool as unknown as Record<string, unknown>, "query");

export const db = drizzle(pool, { schema });

export type Database = typeof db;

export async function closeDb(): Promise<void> {
  await pool.end();
}
