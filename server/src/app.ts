import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { trpcServer } from "@hono/trpc-server";

import { db } from "./db/client";
import { ERROR_CODE } from "@lexflow/shared";
import { filesRoute } from "./routes/files";
import { createContext } from "./trpc/context";
import { appRouter } from "./trpc/routers";
import { registerApprovalHandlers } from "./modules/approval/handlers";

/**
 * Hono app 装配（arch/00 §2）：/health、/trpc/*（tRPC）、/files/*（原生文件路由）。
 * 统一兜底错误：无堆栈、带 requestId（arch/00 §6）。
 */
export function buildApp(): Hono<{ Variables: { requestId: string } }> {
  const app = new Hono<{ Variables: { requestId: string } }>();

  // 审批引擎业务处理器注册（幂等；arch/04 §4 registerHandler）
  registerApprovalHandlers();

  app.use(async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? randomUUID();
    c.set("requestId", requestId);
    c.header("X-Request-Id", requestId);
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // R5 修复：方法不匹配在过程执行前发生（logging 中间件挂载在过程级），此处统一前置拦截：
  // query 仅 GET / mutation 仅 POST（batch 请求放行由适配器自理），405 + 带 requestId 的落日志
  const procedureTypes = new Map<string, "query" | "mutation">();
  for (const [path, proc] of Object.entries(appRouter._def.procedures)) {
    procedureTypes.set(path, (proc as unknown as { _def: { type: string } })._def.type as "query" | "mutation");
  }
  app.use("/trpc/*", async (c, next) => {
    const procPath = c.req.path.replace(/^\/trpc\//, "");
    const type = procedureTypes.get(procPath);
    if (type && !c.req.query("batch")) {
      const method = c.req.method;
      const allowed = type === "query" ? "GET" : "POST";
      if (method !== allowed) {
        const requestId = c.get("requestId") ?? "unknown";
        console.error(
          JSON.stringify({ requestId, path: c.req.path, error: `method_not_allowed: ${method} → ${type}（须 ${allowed}）` }),
        );
        return c.json(
          {
            error: {
              message: `方法不允许：${type} 过程仅接受 ${allowed}`,
              code: -32600,
              data: { businessCode: ERROR_CODE.VALIDATION_FAILED, requestId },
            },
          },
          405,
        );
      }
    }
    await next();
  });

  app.use(
    "/trpc/*",
    trpcServer({
      router: appRouter,
      createContext: (opts, c) => createContext(db, opts, c) as unknown as Promise<Record<string, unknown>>,
    }),
  );

  app.route("/files", filesRoute);

  app.onError((error, c) => {
    const requestId = c.get("requestId") ?? "unknown";
    console.error(JSON.stringify({ requestId, route: c.req.path, error: error.message }));
    const status = error instanceof Error && (error as { status?: number }).status === 404 ? 404 : 500;
    return c.json(
      {
        error: {
          businessCode: status === 404 ? ERROR_CODE.ACCESS_DENIED_OR_GONE : ERROR_CODE.INTERNAL,
          message: status === 404 ? "资源不存在或无权访问" : "服务器内部错误",
          requestId,
        },
      },
      status as never,
    );
  });

  app.notFound((c) =>
    c.json(
      {
        error: {
          businessCode: ERROR_CODE.ACCESS_DENIED_OR_GONE,
          message: "资源不存在或无权访问",
          requestId: c.get("requestId") ?? "unknown",
        },
      },
      404,
    ),
  );

  return app;
}
