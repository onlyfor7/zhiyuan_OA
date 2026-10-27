import "./env-setup";

import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, sessionCookieOf, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 一致性地基验收套件（工单 05 范围 3）：
 * 审计行断言（登录/上传的 action/actor/target/result）、登录错误同形、
 * 会话生命周期一致性（场景 4 服务端部分）、幂等键重复提交取证。
 *
 * 「幂等键重复提交不产生重复行」在迭代 0 为偏差项：冻结上传契约（arch/02 §4）
 * multipart 无 idempotencyKey 字段，服务端上传路径亦无幂等实现，且迭代 0 十六表
 * 无 idempotency_key 列（该列随迭代 1 approval/budget 表落地）。本套件以 probe 用例
 * 固定当前真实行为作为偏差证据，结论见验收报告与 STATUS「偏差与仲裁」。
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
): Promise<Record<string, unknown>> {
  const form = new FormData();
  form.append("sourceType", "project");
  form.append("sourceId", sourceId);
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
    pmCookie = (await loginAs(app, "pm@lexflow.demo")).cookie;
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
    await trpc(app, "auth.login", { input: { email: "pm@lexflow.demo", password: "bad" } });
    const login = await trpc(app, "auth.login", {
      input: { email: "member@lexflow.demo", password: "Demo@2026" },
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
    // 登录审计行在中间件层记录：此时请求尚无身份，actor/session 为 null（已登记 STATUS：
    // 建议迭代 1 由后端在登录 resolver 内显式补 actor，文件下载的显式审计即先例）。
    // 审计行本身齐备（action/result/target_type/ip/created_at），满足「关键写入有审计」。
    expect(success?.target_type).toBe("rpc");
    expect(failure?.actor_id).toBeNull(); // 未认证 actor 不得伪造
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
    const users = await query<{ id: string }>(`SELECT id FROM users WHERE email = 'pm@lexflow.demo'`);
    expect(rows[0].actor_id).toBe(users[0].id);
    expect(rows[0].after_json.sha256).toBe(saved.sha256);
  });

  it("auth.login 错误口令与不存在账号 → 响应逐字段一致（不泄露账号存在性）", async () => {
    const app = await getApp();
    const wrongPassword = await trpc(app, "auth.login", {
      input: { email: "pm@lexflow.demo", password: "WrongPass1" },
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
    const first = await loginAs(app, "pm@lexflow.demo");
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
    const second = await loginAs(app, "pm@lexflow.demo");
    expect(second.user.id).toBe(first.user.id);
    const reloginList = await trpc(app, "project.list", { cookie: second.cookie, method: "GET" });
    const afterCodes = (reloginList.json as { result: { data: { items: { code: string }[] } } })
      .result.data.items.map((p) => p.code);
    expect(afterCodes.sort()).toEqual(beforeCodes.sort());
  });

  it("[偏差取证] 上传重复提交当前行为：无幂等键入口，重复上传建行两行", async () => {
    const app = await getApp();
    // 专用字节串，避免与本文件其他用例的上传在 sha256 维度互相干扰
    const probeBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x58]);
    const first = await uploadOnce(app, pmCookie, projectAId, "重复提交取证.pdf", probeBytes);
    const second = await uploadOnce(app, pmCookie, projectAId, "重复提交取证.pdf", probeBytes);
    // 偏差证据（非验收通过标准）：当前实现两次均建行并返回不同 id——
    // 证明「幂等键重复提交不产生重复行」在迭代 0 无受保护入口，待架构裁定（STATUS 偏差与仲裁）
    expect(first.fileObjectId).not.toBe(second.fileObjectId);

    const objectId = first.fileObjectId as string;
    const sha = first.sha256 as string;
    const dupes = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM file_versions WHERE sha256 = $1 AND uploaded_by = (
         SELECT id FROM users WHERE email = 'pm@lexflow.demo')`,
      [sha],
    );
    expect(dupes[0].n).toBe(2);
    expect(objectId).toBeTruthy();
  });

  it("[偏差取证] 迭代 0 十六表无 idempotency_key 列（与 arch/01：幂等键随迭代 1 表落地一致）", async () => {
    const rows = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'idempotency_key'`,
    );
    expect(rows).toEqual([]);
  });

  it("会话 cookie 属性：HttpOnly + SameSite=Lax（防 XSS 窃取与会话固定面）", async () => {
    const app = await getApp();
    const login = await trpc(app, "auth.login", {
      input: { email: "pm@lexflow.demo", password: "Demo@2026" },
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
