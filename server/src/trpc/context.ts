import { randomUUID } from "node:crypto";

import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import type { Context as HonoContext } from "hono";
import { getCookie } from "hono/cookie";

import { env } from "../env";
import type * as schema from "../db/schema";
import { SESSION_COOKIE, resolveSession, type ResolvedSession } from "../modules/auth/session";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;
/** service 层统一签名：普通查询用连接池，mutation 经中间件换成事务（arch/00 §3.11） */
export type DbOrTx = Db | Tx;

/** tRPC 请求上下文：session user、db、requestId（arch/00 §2） */
export interface Context {
  db: DbOrTx;
  requestId: string;
  ip: string | null;
  session: { id: string; tokenHash: string } | null;
  user: ResolvedSession["user"] | null;
  /** tRPC fetch 适配器的响应头容器：Set-Cookie 等经此透传（@hono/trpc-server 只转发 tRPC Response 的头） */
  resHeaders: Headers;
}

/** @hono/trpc-server createContext 入口（files 路由不走这里） */
export async function createContext(
  db: Db,
  opts: FetchCreateContextFnOptions,
  c: HonoContext,
): Promise<Context> {
  const requestId = c.req.header("x-request-id") ?? randomUUID();
  c.header("X-Request-Id", requestId);
  const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const resolved = await resolveSession(db, getCookie(c, SESSION_COOKIE));
  return {
    db,
    requestId,
    ip,
    session: resolved ? { id: resolved.sessionId, tokenHash: resolved.tokenHash } : null,
    user: resolved?.user ?? null,
    resHeaders: opts.resHeaders,
  };
}

/** 会话有效期（ISO 字符串） */
export function sessionExpiresAt(): string {
  return new Date(Date.now() + env.SESSION_TTL_HOURS * 3600_000).toISOString();
}
