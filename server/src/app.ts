import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { trpcServer } from "@hono/trpc-server";

import { db, requestContext } from "./db/client";
import { ERROR_CODE } from "@lexflow/shared";
import { filesRoute } from "./routes/files";
import { createContext } from "./trpc/context";
import { appRouter } from "./trpc/routers";
import { registerApprovalHandlers } from "./modules/approval/handlers";
import { SESSION_COOKIE, resolveSession } from "./modules/auth/session";
import { subscribeEvents } from "./lib/events";

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
    // requestId 贯通异步上下文（慢查询日志关联；db/client requestContext）
    await requestContext.run({ requestId }, next);
    // 响应头须在 next() 后设置（hono：下游新响应会覆盖前置头）
    c.header("X-Request-Id", requestId);
    // arch/12 §14.4 安全响应头四件（全响应覆盖，含 /trpc 与 /files）
    c.header("X-Frame-Options", "DENY");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:",
    );
  });

  app.get("/health", (c) => c.json({ ok: true }));

  /**
   * SSE 实时事件流（arch/12 §20.3）：会话 cookie 鉴权（同 tRPC 会话解析），
   * 进程内事件总线按用户扇出（notification.created / approval.todo / assistant.feed）；
   * 心跳 25s 防代理静默断链。单进程形态——多实例换 PG LISTEN/NOTIFY（见 lib/events.ts 留坑注释）。
   */
  app.get("/events", async (c) => {
    const resolved = await resolveSession(db, getCookie(c, SESSION_COOKIE));
    if (!resolved) {
      return c.json(
        {
          error: {
            message: "未登录或会话已失效",
            code: -32001,
            data: { businessCode: ERROR_CODE.AUTH_REQUIRED, requestId: c.get("requestId") ?? "unknown" },
          },
        },
        401,
      );
    }
    const userId = resolved.user.id;
    return streamSSE(c, async (stream) => {
      const unsubscribe = subscribeEvents(userId, (event) => {
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => {});
      });
      // 心跳 25s（SSE 注释行 ": ping"——客户端 EventSource 自动忽略，防中间代理断链）
      const heartbeat = setInterval(() => {
        void stream.write(": ping\n\n").catch(() => {});
      }, 25_000);
      if (typeof heartbeat.unref === "function") heartbeat.unref();
      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      c.req.raw.signal.addEventListener("abort", cleanup, { once: true });
      // 保持连接直到客户端断开（真实 HTTP 断开触发 abort；单进程形态无跨实例广播）
      while (!c.req.raw.signal.aborted) {
        await stream.sleep(1_000);
      }
      cleanup();
    });
  });

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
