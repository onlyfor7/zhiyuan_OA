import "./env-setup";

import type { buildApp } from "../../src/app";

import { runSeed } from "../../src/db/seed";
import { TEST_DATABASE_URL, migrateFresh } from "../db/helpers";

type App = ReturnType<typeof buildApp>;

/** 干净库重放迁移 + 种子（与 dev 库验收场景同一布局） */
export async function setupDatabase(): Promise<void> {
  await migrateFresh();
  await runSeed(TEST_DATABASE_URL);
}

let appPromise: Promise<ReturnType<typeof buildApp>> | null = null;

/** 构建被测 app（每次进程一次；模块级 env 已由 env-setup 锁定到测试库） */
export function getApp(): Promise<ReturnType<typeof buildApp>> {
  appPromise ??= import("../../src/app").then((m) => m.buildApp());
  return appPromise;
}

export interface TrpcCallOptions {
  input?: unknown;
  cookie?: string;
  /** tRPC v11：query 仅接受 GET（input 走 ?input= JSON），mutation 用 POST */
  method?: "GET" | "POST";
}

export interface TrpcCallResult {
  status: number;
  json: Record<string, unknown>;
  /** Set-Cookie 响应头数组 */
  setCookies: string[];
}

/** 直连 app.request 的单发 tRPC 调用（集成测试，不引 supertest；arch/00 §1） */
export async function trpc(
  app: App,
  path: string,
  options: TrpcCallOptions = {},
): Promise<TrpcCallResult> {
  const method = options.method ?? "POST";
  const url =
    method === "GET" && options.input !== undefined
      ? `http://test/trpc/${path}?input=${encodeURIComponent(JSON.stringify(options.input))}`
      : `http://test/trpc/${path}`;
  const response = await app.request(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify(options.input ?? {}) } : {}),
  });
  const json = (await response.json()) as Record<string, unknown>;
  return { status: response.status, json, setCookies: response.headers.getSetCookie() };
}

/** 从 Set-Cookie 组里提取回传用的 Cookie 头（lexflow_session=...） */
export function sessionCookieOf(result: TrpcCallResult): string {
  const setCookie = result.setCookies.find((line) => line.startsWith("lexflow_session="));
  if (!setCookie) throw new Error("响应缺少 lexflow_session Set-Cookie");
  return setCookie.split(";")[0];
}

export async function loginAs(
  app: App,
  email: string,
  password = "Demo@2026",
): Promise<{ cookie: string; user: Record<string, unknown> }> {
  const result = await trpc(app, "auth.login", { input: { email, password } });
  if (result.status !== 200) {
    throw new Error(`登录失败 ${email}: ${JSON.stringify(result.json)}`);
  }
  const payload = result.json as { result: { data: { user: Record<string, unknown> } } };
  return { cookie: sessionCookieOf(result), user: payload.result.data.user };
}

/** tRPC 错误形状解包（单发：{ error: {...shape} }） */
export function trpcError(result: TrpcCallResult): {
  message: string;
  businessCode?: string;
  fieldErrors?: Record<string, unknown>;
} {
  const error = (result.json as { error?: Record<string, unknown> }).error ?? {};
  const data = (error.data as Record<string, unknown> | undefined) ?? {};
  return {
    message: String(error.message ?? ""),
    businessCode: data.businessCode as string | undefined,
    fieldErrors: data.fieldErrors as Record<string, unknown> | undefined,
  };
}
