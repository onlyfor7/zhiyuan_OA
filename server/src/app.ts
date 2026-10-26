import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import { trpcServer } from "@hono/trpc-server";

import { db } from "./db/client";
import { ERROR_CODE } from "@lexflow/shared";
import { filesRoute } from "./routes/files";
import { createContext } from "./trpc/context";
import { appRouter } from "./trpc/routers";

/**
 * Hono app 装配（arch/00 §2）：/health、/trpc/*（tRPC）、/files/*（原生文件路由）。
 * 统一兜底错误：无堆栈、带 requestId（arch/00 §6）。
 */
export function buildApp(): Hono<{ Variables: { requestId: string } }> {
  const app = new Hono<{ Variables: { requestId: string } }>();

  app.use(async (c, next) => {
    const requestId = c.req.header("x-request-id") ?? randomUUID();
    c.set("requestId", requestId);
    c.header("X-Request-Id", requestId);
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

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
