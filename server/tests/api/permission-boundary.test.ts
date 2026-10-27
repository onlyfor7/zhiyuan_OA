import "./env-setup";

import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { signDownloadToken } from "../../src/services/file/tokens";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 权限边界验收套件（工单 00 迭代验收场景 1/2/3/5 的正式取证）。
 * 与后端工单 03 自测的区别：本套件按验收口径做「响应体逐字段同形」断言
 * （仅归一化 requestId），并覆盖过期令牌与「完全不可见项目 C」的直链探测。
 */

const YEAR = new Date().getFullYear();
const PROJECT_A = `PRJ-${YEAR}-00001`;
const PROJECT_B = `PRJ-${YEAR}-00002`;
const PROJECT_C = `PRJ-${YEAR}-00003`;

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
const PDF_SHA256 = createHash("sha256").update(PDF_BYTES).digest("hex");

/** 归一化 requestId 后按 key 排序序列化（tRPC v11 单发响应形状） */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "requestId")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function uploadPdf(
  app: Awaited<ReturnType<typeof getApp>>,
  cookie: string,
  sourceId: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const form = new FormData();
  form.append("sourceType", "project");
  form.append("sourceId", sourceId);
  form.append("file", new Blob([PDF_BYTES.buffer as ArrayBuffer], { type: "application/pdf" }), "取证.pdf");
  const response = await app.request("http://test/files/upload", {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("权限边界验收（工单 00 场景 1/2/3/5）", () => {
  let pmCookie: string;
  let memberCookie: string;
  let projectAId: string;
  let projectBId: string;
  let projectCId: string;
  let fileVersionId: string;
  let denialFileVersionId: string;

  beforeAll(async () => {
    await setupDatabase();
    const app = await getApp();
    pmCookie = (await loginAs(app, "pm@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "member@lexflow.demo")).cookie;

    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
      .result.data.items;
    projectAId = items.find((p) => p.code === PROJECT_A)?.id ?? "";
    projectBId = items.find((p) => p.code === PROJECT_B)?.id ?? "";
    expect(projectAId && projectBId).toBeTruthy();

    // 项目 C 对 pm/member 均不可见（种子隔离布局），id 只能经库读取——正适合存在性探测
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const row = await client.query(`SELECT id FROM projects WHERE code = $1`, [PROJECT_C]);
      projectCId = row.rows[0]?.id as string;
    } finally {
      await client.end();
    }
    expect(projectCId).toBeTruthy();

    const uploaded = await uploadPdf(app, pmCookie, projectAId);
    expect(uploaded.status).toBe(200);
    fileVersionId = (uploaded.json as { fileVersionId: string }).fileVersionId;

    // 越权取证文件：挂在项目 B（member 非 B 成员）——迭代 1 起来源项目成员可读（arch/04 §5 留坑落地），
    // 「他人文件拒绝」须在请求人对来源项目无权限的夹具上取证
    const denialFixture = await uploadPdf(app, pmCookie, projectBId);
    expect(denialFixture.status).toBe(200);
    denialFileVersionId = (denialFixture.json as { fileVersionId: string }).fileVersionId;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("场景 1：pm/member project.list 集合不同，member 不含未加入项目且计数一致", async () => {
    const app = await getApp();
    const listOf = async (cookie: string) => {
      const result = await trpc(app, "project.list", { cookie, method: "GET" });
      expect(result.status).toBe(200);
      return (result.json as { result: { data: { items: { code: string }[] } } }).result.data.items;
    };
    const pmItems = await listOf(pmCookie);
    const memberItems = await listOf(memberCookie);
    expect(pmItems.map((p) => p.code).sort()).toEqual([PROJECT_A, PROJECT_B]);
    expect(memberItems.map((p) => p.code)).toEqual([PROJECT_A]);
    // member 列表计数即集合大小（静默过滤，无分页假象）
    expect(memberItems).toHaveLength(1);
    for (const items of [pmItems, memberItems]) {
      expect(items.map((p) => p.code)).not.toContain(PROJECT_C);
    }
  });

  it("场景 2：member 直链未授权项目（B 与完全不可见的 C）→ 与随机 uuid 响应逐字段同形", async () => {
    const app = await getApp();
    const ghostId = "00000000-0000-0000-0000-000000000000";
    const probes = [
      { name: "成员可见圈外的 B", id: projectBId },
      { name: "对二者完全隔离的 C", id: projectCId },
    ];
    for (const probe of probes) {
      const denied = await trpc(app, "project.getById", { input: { id: probe.id }, cookie: memberCookie, method: "GET" });
      const nonexistent = await trpc(app, "project.getById", { input: { id: ghostId }, cookie: memberCookie, method: "GET" });
      expect(denied.status).toBe(404);
      expect(nonexistent.status).toBe(404);
      // 逐字段同形（仅 requestId 不同）：无存在性泄露
      expect(canonical(denied.json)).toBe(canonical(nonexistent.json));
      expect(trpcError(denied).businessCode).toBe("ACCESS_DENIED_OR_GONE");
    }
    // 反向确认：B 真实存在（pm 可读），证明上面对比的是「存在但无权」而非「真的不存在」
    const asPm = await trpc(app, "project.getById", { input: { id: projectBId }, cookie: pmCookie, method: "GET" });
    expect(asPm.status).toBe(200);
  });

  it("场景 3a：无授权下载他人文件 → 与不存在逐字段同形 404；授权下载 sha256 一致", async () => {
    const app = await getApp();
    const ghostId = "00000000-0000-0000-0000-000000000000";
    const denied = await app.request(`http://test/files/${denialFileVersionId}/download`, {
      headers: { cookie: memberCookie },
    });
    const nonexistent = await app.request(`http://test/files/${ghostId}/download`, {
      headers: { cookie: memberCookie },
    });
    expect(denied.status).toBe(404);
    expect(nonexistent.status).toBe(404);
    const deniedJson = (await denied.json()) as Record<string, unknown>;
    const nonexistentJson = (await nonexistent.json()) as Record<string, unknown>;
    expect(canonical(deniedJson)).toBe(canonical(nonexistentJson));

    const authorized = await app.request(`http://test/files/${fileVersionId}/download`, {
      headers: { cookie: pmCookie },
    });
    expect(authorized.status).toBe(200);
    const bytes = new Uint8Array(await authorized.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(PDF_SHA256);
    expect(authorized.headers.get("cache-control")).toBe("private, no-store");
  });

  it("场景 3b：合法短期令牌可下载；过期/伪造/错文件令牌一律拒绝", async () => {
    const app = await getApp();
    const valid = signDownloadToken(fileVersionId);
    const viaToken = await app.request(
      `http://test/files/${fileVersionId}/download?token=${encodeURIComponent(valid)}`,
    );
    expect(viaToken.status).toBe(200);

    const expired = signDownloadToken(fileVersionId, -60 * 1000);
    const viaExpired = await app.request(
      `http://test/files/${fileVersionId}/download?token=${encodeURIComponent(expired)}`,
    );
    expect(viaExpired.status).toBe(401);

    const forged = valid.slice(0, -2) + (valid.endsWith("AA") ? "BB" : "AA");
    const viaForged = await app.request(
      `http://test/files/${fileVersionId}/download?token=${encodeURIComponent(forged)}`,
    );
    expect(viaForged.status).toBe(401);

    const otherFile = signDownloadToken("00000000-0000-0000-0000-000000000000");
    const viaOther = await app.request(
      `http://test/files/${fileVersionId}/download?token=${encodeURIComponent(otherFile)}`,
    );
    expect(viaOther.status).toBe(401);
  });

  it("场景 5：停用账号后其会话立即失效（全部 API 一律 401）", async () => {
    const app = await getApp();
    const { cookie } = await loginAs(app, "mayue@lexflow.demo");
    const before = await trpc(app, "auth.me", { cookie, method: "GET" });
    expect(before.status).toBe(200);

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      await client.query(`UPDATE users SET status = 'disabled' WHERE email = 'mayue@lexflow.demo'`);
    } finally {
      await client.end();
    }

    const meAfter = await trpc(app, "auth.me", { cookie, method: "GET" });
    expect(meAfter.status).toBe(401);
    expect(trpcError(meAfter).businessCode).toBe("AUTH_REQUIRED");
    const listAfter = await trpc(app, "project.list", { cookie, method: "GET" });
    expect(listAfter.status).toBe(401);
    expect(trpcError(listAfter).businessCode).toBe("AUTH_REQUIRED");
    const fileAfter = await app.request(`http://test/files/${fileVersionId}/download`, { headers: { cookie } });
    expect(fileAfter.status).toBe(401);
  });
});
