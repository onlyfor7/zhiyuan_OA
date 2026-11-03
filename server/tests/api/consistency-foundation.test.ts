import "./env-setup";

import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, sessionCookieOf, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 一致性地基验收套件（迭代 0 工单 05 范围 3；迭代 1 工单 04 翻转 D2/N1）：
 * 审计行断言（登录/上传的 action/actor/target/result）、登录错误同形、
 * 会话生命周期一致性（场景 4 服务端部分）、上传幂等（D2，arch/02 §4 v1.1）。
 *
 * D2 已落地（STATUS 2026-10-27 裁定关闭）：upload 接受可选 idempotencyKey，
 * file_versions.idempotency_key 唯一；原「[偏差取证]」probe 翻转为幂等拦截断言。
 * N1 已落地（arch/04 §7）：登录审计行 actor/session 由 resolver 显式补记。
 */

const YEAR = new Date().getFullYear();

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows as T[];
  } finally {
    await client.end();
  }
}

async function uploadOnce(
  app: Awaited<ReturnType<typeof getApp>>,
  cookie: string,
  sourceId: string,
  filename: string,
  bytes: Uint8Array = new Uint8Array([0x25, 0x50, 0x44, 0x46]),
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  const form = new FormData();
  form.append("sourceType", "project");
  form.append("sourceId", sourceId);
  if (idempotencyKey) form.append("idempotencyKey", idempotencyKey);
  form.append("file", new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" }), filename);
  const response = await app.request("http://test/files/upload", {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

describe("一致性地基验收（审计 / 登录同形 / 会话一致性 / 幂等取证）", () => {
  let pmCookie: string;
  let projectAId: string;

  beforeAll(async () => {
    await setupDatabase();
    const app = await getApp();
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
      .result.data.items;
    projectAId = items.find((p) => p.code === `PRJ-${YEAR}-00001`)?.id ?? "";
    expect(projectAId).toBeTruthy();
  });

  afterAll(async () => {
    await closeDb();
  });

  it("登录审计：成功/失败各落行，action/actor/target/result/session 完整", async () => {
    const app = await getApp();
    await trpc(app, "auth.login", { input: { email: "wangbaozhuo@lexflow.demo", password: "bad" } });
    const login = await trpc(app, "auth.login", {
      input: { email: "guanchen@lexflow.demo", password: "Demo@2026" },
    });
    expect(login.status).toBe(200);

    const rows = await query<{ action: string; result: string; actor_id: string | null; target_type: string | null; target_id: string | null; session_id: string | null }>(
      `SELECT action, result, actor_id, target_type, target_id, session_id
       FROM audit_events WHERE action = 'auth.login' ORDER BY created_at DESC LIMIT 5`,
    );
    const failure = rows.find((r) => r.result === "failure");
    const success = rows.find((r) => r.result === "success");
    expect(failure).toBeDefined();
    expect(success).toBeDefined();
    // N1（arch/04 §7 落地）：登录成功审计行由 resolver 显式补记 actor+session
    const member = await query<{ id: string }>(`SELECT id FROM users WHERE email = 'guanchen@lexflow.demo'`);
    expect(success?.actor_id).toBe(member[0].id);
    expect(success?.session_id).toBeTruthy();
    expect(success?.target_type).toBe("rpc");
    expect(failure?.actor_id).toBeNull(); // 未认证 actor 不得伪造
    expect(failure?.session_id).toBeNull();
  });

  it("上传审计：file.upload 行 actor=上传人、target 与响应一致、同事务可追溯", async () => {
    const app = await getApp();
    const saved = await uploadOnce(app, pmCookie, projectAId, "审计取证.pdf");
    const fileObjectId = saved.fileObjectId as string;

    const rows = await query<{ action: string; actor_id: string; target_type: string; target_id: string; result: string; after_json: Record<string, unknown> }>(
      `SELECT action, actor_id, target_type, target_id, result, after_json
       FROM audit_events WHERE action = 'file.upload' AND target_id = $1`,
      [fileObjectId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "file.upload",
      target_type: "file_object",
      target_id: fileObjectId,
      result: "success",
    });
    // actor 为上传人本人（pm），且 after_json 带 sha256 供追溯
    const users = await query<{ id: string }>(`SELECT id FROM users WHERE email = 'wangbaozhuo@lexflow.demo'`);
    expect(rows[0].actor_id).toBe(users[0].id);
    expect(rows[0].after_json.sha256).toBe(saved.sha256);
  });

  it("auth.login 错误口令与不存在账号 → 响应逐字段一致（不泄露账号存在性）", async () => {
    const app = await getApp();
    const wrongPassword = await trpc(app, "auth.login", {
      input: { email: "wangbaozhuo@lexflow.demo", password: "WrongPass1" },
    });
    const wrongAccount = await trpc(app, "auth.login", {
      input: { email: "ghost@lexflow.demo", password: "Demo@2026" },
    });
    expect(wrongPassword.status).toBe(401);
    expect(wrongAccount.status).toBe(401);
    const strip = (json: Record<string, unknown>) => {
      const clone = JSON.parse(JSON.stringify(json)) as Record<string, unknown>;
      const data = (clone.error as Record<string, unknown>).data as Record<string, unknown>;
      delete data.requestId;
      return clone;
    };
    expect(strip(wrongPassword.json)).toEqual(strip(wrongAccount.json));
    expect(trpcError(wrongPassword).message).toBe("邮箱或密码错误");
  });

  it("会话一致性（场景 4 服务端部分）：登出后所有 API 一律 AUTH_REQUIRED；重登后数据一致", async () => {
    const app = await getApp();
    const first = await loginAs(app, "wangbaozhuo@lexflow.demo");
    const beforeList = await trpc(app, "project.list", { cookie: first.cookie, method: "GET" });
    const beforeCodes = (beforeList.json as { result: { data: { items: { code: string }[] } } })
      .result.data.items.map((p) => p.code);

    const logout = await trpc(app, "auth.logout", { cookie: first.cookie });
    expect(logout.status).toBe(200);

    const meAfter = await trpc(app, "auth.me", { cookie: first.cookie, method: "GET" });
    expect(meAfter.status).toBe(401);
    expect(trpcError(meAfter).businessCode).toBe("AUTH_REQUIRED");
    const listAfter = await trpc(app, "project.list", { cookie: first.cookie, method: "GET" });
    expect(listAfter.status).toBe(401);
    const fileAfter = await app.request(
      `http://test/files/00000000-0000-0000-0000-000000000000/download`,
      { headers: { cookie: first.cookie } },
    );
    expect(fileAfter.status).toBe(401);

    // 重新登录：同一用户、同一项目集合（刷新/重登一致性）
    const second = await loginAs(app, "wangbaozhuo@lexflow.demo");
    expect(second.user.id).toBe(first.user.id);
    const reloginList = await trpc(app, "project.list", { cookie: second.cookie, method: "GET" });
    const afterCodes = (reloginList.json as { result: { data: { items: { code: string }[] } } })
      .result.data.items.map((p) => p.code);
    expect(afterCodes.sort()).toEqual(beforeCodes.sort());
  });

  it("D2 幂等拦截：同键重复上传返回首次结果且仅建行一次（arch/02 §4 v1.1 翻转）", async () => {
    const app = await getApp();
    const probeBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x58]);
    const key = crypto.randomUUID();
    const first = await uploadOnce(app, pmCookie, projectAId, "幂等拦截取证.pdf", probeBytes, key);
    const second = await uploadOnce(app, pmCookie, projectAId, "幂等拦截取证.pdf", probeBytes, key);
    // 拦截语义：同键重放返回首次结果，不产生新行
    expect(second.fileObjectId).toBe(first.fileObjectId);
    expect(second.fileVersionId).toBe(first.fileVersionId);
    expect(second.sha256).toBe(first.sha256);

    const rows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM file_versions WHERE idempotency_key = $1`,
      [key],
    );
    expect(rows[0].n).toBe(1);

    // 对照：不同键照常建行（幂等键不阻塞正常多次上传）
    const third = await uploadOnce(app, pmCookie, projectAId, "幂等拦截取证.pdf", probeBytes, crypto.randomUUID());
    expect(third.fileObjectId).not.toBe(first.fileObjectId);
  });

  it("[D2 已落地] idempotency_key 列随迭代 1/3/6 表落地（approval_instances / budget_ledger / file_versions / payment_receipts）", async () => {
    // D2 偏差裁定关闭（STATUS 2026-10-27）：幂等键列由数据会话随迭代 1 迁移落地；
    // budget_ledger 幂等键为 arch/06 §2 台账唯一约束；本条取证对象随数据棒落地原地更新，
    // 正式「重复上传/重复记账拦截断言」归测试会话工单 04。
    // R6（STATUS 2026-10-29 迭代6-05b）：payment_receipts 增 idempotency_key 唯一列（收款登记幂等）。
    const rows = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'idempotency_key'
       ORDER BY table_name`,
    );
    expect(rows).toEqual([
      { table_name: "approval_instances" },
      { table_name: "budget_ledger" },
      { table_name: "file_versions" },
      { table_name: "payment_receipts" },
    ]);
  });

  it("会话 cookie 属性：HttpOnly + SameSite=Lax（防 XSS 窃取与会话固定面）", async () => {
    const app = await getApp();
    const login = await trpc(app, "auth.login", {
      input: { email: "wangbaozhuo@lexflow.demo", password: "Demo@2026" },
    });
    const setCookie = login.setCookies.find((line) => line.startsWith("lexflow_session="));
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie?.toLowerCase()).toContain("samesite=lax");
    expect(sessionCookieOf(login)).toMatch(/^lexflow_session=/);
  });

  it("上传内容 sha256 与物理字节一致（内容完整性）", async () => {
    const app = await getApp();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG 头
    const expected = createHash("sha256").update(bytes).digest("hex");
    const form = new FormData();
    form.append("sourceType", "project");
    form.append("sourceId", projectAId);
    form.append("file", new Blob([bytes.buffer as ArrayBuffer], { type: "image/png" }), "完整性.png");
    const response = await app.request("http://test/files/upload", {
      method: "POST",
      headers: { cookie: pmCookie },
      body: form,
    });
    expect(response.status).toBe(200);
    const json = (await response.json()) as { sha256: string; sizeBytes: number; fileVersionId: string };
    expect(json.sha256).toBe(expected);
    expect(json.sizeBytes).toBe(bytes.byteLength);

    const download = await app.request(`http://test/files/${json.fileVersionId}/download`, {
      headers: { cookie: pmCookie },
    });
    expect(createHash("sha256").update(new Uint8Array(await download.arrayBuffer())).digest("hex")).toBe(expected);
  });
});
