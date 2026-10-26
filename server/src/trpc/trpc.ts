import { ERROR_CODE } from "@lexflow/shared";
import { initTRPC } from "@trpc/server";

import { db } from "../db/client";
import { BusinessError, formatTrpcError } from "../lib/errors";
import { recordAudit } from "../services/audit";

import type { Context } from "./context";

const t = initTRPC.context<Context>().create({
  errorFormatter: (opts) =>
    formatTrpcError(opts as Parameters<typeof formatTrpcError>[0]),
});

/**
 * 统一中间件链（arch/02 §1）：logging → session → rbac(各 resolver 调 access.can)
 * 变更类 mutation 追加：transaction → audit（审计与业务写同事务，arch/02 §7）。
 */

const loggingMiddleware = t.middleware(async ({ ctx, path, type, next }) => {
  const startedAt = Date.now();
  try {
    return await next();
  } catch (error) {
    console.error(
      JSON.stringify({
        requestId: ctx.requestId,
        path,
        type,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  } finally {
    console.log(
      JSON.stringify({ requestId: ctx.requestId, path, type, ms: Date.now() - startedAt }),
    );
  }
});

const sessionMiddleware = t.middleware(async ({ ctx, next }) => {
  if (!ctx.user || !ctx.session) {
    throw new BusinessError(ERROR_CODE.AUTH_REQUIRED, "未登录或会话已失效");
  }
  // 收窄为不可空：后续 resolver 的 ctx.user / ctx.session 类型为非空
  const user = ctx.user;
  const session = ctx.session;
  return next({ ctx: { user, session } });
});

/** mutation 全程在单事务内执行；ctx.db 由连接池换成事务句柄（arch/00 §3.11）。
 *  tRPC v11 中间件 next() 以 {ok} 结果对象传递错误（不抛出），失败须显式抛错回滚。 */
const transactionMiddleware = t.middleware(async ({ ctx, next }) => {
  if (ctx.db !== db) {
    return next(); // 已在事务中（嵌套调用防重）
  }
  return db.transaction(async (tx) => {
    const result = await next({ ctx: { ...ctx, db: tx } });
    if (!result.ok) {
      throw result.error; // 使事务回滚；调用方按原样收到该错误
    }
    return result;
  });
});

/** 变更类 mutation 自动写 audit_events（arch/02 §7）；actor/ip/session_id 取自 ctx。
 *  成功：与业务写同事务（ctx.db 为事务句柄）；失败：走全局连接池独立提交（业务事务回滚后仍留痕）。 */
const auditMutationMiddleware = t.middleware(async ({ ctx, path, next }) => {
  const result = await next();
  if (result.ok) {
    await recordAudit(ctx.db, {
      actorId: ctx.user?.id ?? null,
      sessionId: ctx.session?.id ?? null,
      action: path,
      targetType: "rpc",
      targetId: null,
      result: "success",
      ip: ctx.ip,
    });
    return result;
  }
  try {
    await recordAudit(db, {
      actorId: ctx.user?.id ?? null,
      sessionId: ctx.session?.id ?? null,
      action: path,
      targetType: "rpc",
      targetId: null,
      result: "failure",
      afterJson: { message: result.error.message },
      ip: ctx.ip,
    });
  } catch {
    // 审计失败不掩盖原始错误
  }
  return result;
});

export const router = t.router;
export const publicProcedure = t.procedure.use(loggingMiddleware);
/** 查询类（需登录） */
export const authedProcedure = publicProcedure.use(sessionMiddleware);
/** 变更类（登录 + 事务 + 审计） */
export const authedMutation = authedProcedure.use(transactionMiddleware).use(auditMutationMiddleware);
/** 匿名变更类（仅 auth.login：事务 + 审计，无会话） */
export const anonMutation = publicProcedure.use(transactionMiddleware).use(auditMutationMiddleware);

export type AppContext = Context;
