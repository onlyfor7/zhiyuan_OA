import "./env-setup";

import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { signDownloadToken } from "../../src/services/file/tokens";
import { getApp, loginAs, setupDatabase, trpc } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
const PDF_SHA256 = createHash("sha256").update(PDF_BYTES).digest("hex");

async function uploadPdf(
  app: Awaited<ReturnType<typeof getApp>>,
  cookie: string,
  sourceId: string,
  filename = "合同扫描件.pdf",
): Promise<{ status: number; json: Record<string, unknown> }> {
  const form = new FormData();
  form.append("sourceType", "project");
  form.append("sourceId", sourceId);
  form.append("file", new Blob([PDF_BYTES.buffer as ArrayBuffer], { type: "application/pdf" }), filename);
  const response = await app.request("http://test/files/upload", {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("文件（/files 上传/下载/预览/令牌）", () => {
  let pmCookie: string;
  let memberCookie: string;
  let projectAId: string;
  let projectBId: string;
  let fileVersionId: string;

  beforeAll(async () => {
    await setupDatabase();
    const app = await getApp();
    pmCookie = (await loginAs(app, "pm@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "member@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
      .result.data.items;
    const year = new Date().getFullYear();
    const projectA = items.find((p) => p.code === `PRJ-${year}-00001`);
    const projectB = items.find((p) => p.code === `PRJ-${year}-00002`);
    if (!projectA || !projectB) throw new Error("种子项目 A/B 缺失");
    projectAId = projectA.id;
    projectBId = projectB.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("上传：白名单校验 + sha256 + 元数据入库，审计落行", async () => {
    const app = await getApp();
    const uploaded = await uploadPdf(app, pmCookie, projectAId);
    expect(uploaded.status).toBe(200);
    const data = uploaded.json as {
      fileVersionId: string;
      fileObjectId: string;
      sha256: string;
      sizeBytes: number;
    };
    expect(data.sha256).toBe(PDF_SHA256);
    expect(data.sizeBytes).toBe(PDF_BYTES.byteLength);
    fileVersionId = data.fileVersionId;

    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const version = await client.query(
        `SELECT version_no, mime_type, storage_key, uploaded_by IS NOT NULL AS has_uploader
         FROM file_versions WHERE id = $1`,
        [fileVersionId],
      );
      expect(version.rows[0]).toMatchObject({ version_no: 1, mime_type: "application/pdf", has_uploader: true });
      const audit = await client.query(
        `SELECT count(*)::int AS n FROM audit_events WHERE action = 'file.upload' AND target_id = $1`,
        [data.fileObjectId],
      );
      expect(audit.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  it("非白名单类型与超限文件 → VALIDATION_FAILED", async () => {
    const app = await getApp();
    const exeForm = new FormData();
    exeForm.append("sourceType", "project");
    exeForm.append("sourceId", projectAId);
    exeForm.append("file", new Blob([new Uint8Array([1, 2, 3]).buffer as ArrayBuffer], { type: "application/x-msdownload" }), "malware.exe");
    const exeRes = await app.request("http://test/files/upload", {
      method: "POST",
      headers: { cookie: pmCookie },
      body: exeForm,
    });
    expect(exeRes.status).toBe(400);
    const exeJson = (await exeRes.json()) as { error: { businessCode: string; fieldErrors?: Record<string, string[]> } };
    expect(exeJson.error.businessCode).toBe("VALIDATION_FAILED");
    expect(exeJson.error.fieldErrors?.file?.[0]).toContain("pdf");

    const bigForm = new FormData();
    bigForm.append("sourceType", "project");
    bigForm.append("sourceId", projectAId);
    bigForm.append("file", new Blob([new Uint8Array(20 * 1024 * 1024 + 1).buffer as ArrayBuffer], { type: "application/zip" }), "big.zip");
    const bigRes = await app.request("http://test/files/upload", {
      method: "POST",
      headers: { cookie: pmCookie },
      body: bigForm,
    });
    expect(bigRes.status).toBe(400);
    const bigJson = (await bigRes.json()) as { error: { businessCode: string } };
    expect(bigJson.error.businessCode).toBe("VALIDATION_FAILED");
  });

  it("授权人下载/预览：内容一致、响应头正确，预览 inline", async () => {
    const app = await getApp();
    const download = await app.request(`http://test/files/${fileVersionId}/download`, {
      headers: { cookie: pmCookie },
    });
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(PDF_BYTES);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(download.headers.get("cache-control")).toBe("private, no-store");

    const preview = await app.request(`http://test/files/${fileVersionId}/preview`, {
      headers: { cookie: pmCookie },
    });
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-disposition")).toContain("inline");
  });

  it("无授权下载他人文件 → 与不存在同形 404（验收场景 3 前半）", async () => {
    const app = await getApp();
    // 迭代 1 起来源项目成员可读（arch/04 §5 留坑落地），越权夹具挂在项目 B（member 非 B 成员）
    const fixture = await uploadPdf(app, pmCookie, projectBId, "越权取证.pdf");
    expect(fixture.status).toBe(200);
    const denialId = (fixture.json as { fileVersionId: string }).fileVersionId;
    const denied = await app.request(`http://test/files/${denialId}/download`, {
      headers: { cookie: memberCookie },
    });
    const nonexistent = await app.request(
      "http://test/files/00000000-0000-0000-0000-000000000000/download",
      { headers: { cookie: memberCookie } },
    );
    for (const response of [denied, nonexistent]) {
      expect(response.status).toBe(404);
      const json = (await response.json()) as { error: { businessCode: string; message: string } };
      expect(json.error.businessCode).toBe("ACCESS_DENIED_OR_GONE");
      expect(json.error.message).toBe("文件不存在或无权访问");
    }
    // 匿名（无 cookie 无令牌）→ 401 与 404 区分：未认证不进入存在性判断
    const anonymous = await app.request(`http://test/files/${fileVersionId}/download`);
    expect(anonymous.status).toBe(401);
    const anonJson = (await anonymous.json()) as { error: { businessCode: string } };
    expect(anonJson.error.businessCode).toBe("AUTH_REQUIRED");
  });

  it("≤15min 短期令牌：签名正确可下载，篡改即拒", async () => {
    const app = await getApp();
    const token = signDownloadToken(fileVersionId);
    const withToken = await app.request(
      `http://test/files/${fileVersionId}/download?token=${encodeURIComponent(token)}`,
    );
    expect(withToken.status).toBe(200);
    expect(new Uint8Array(await withToken.arrayBuffer())).toEqual(PDF_BYTES);

    const tampered = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    const withTampered = await app.request(
      `http://test/files/${fileVersionId}/download?token=${encodeURIComponent(tampered)}`,
    );
    expect(withTampered.status).toBe(401);

    const wrongFile = signDownloadToken("00000000-0000-0000-0000-000000000000");
    const mismatched = await app.request(
      `http://test/files/${fileVersionId}/download?token=${encodeURIComponent(wrongFile)}`,
    );
    expect(mismatched.status).toBe(401);
  });

  it("下载/预览写审计行（敏感读取显式审计，arch/02 §7）", async () => {
    const app = await getApp();
    await app.request(`http://test/files/${fileVersionId}/preview`, { headers: { cookie: pmCookie } });
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      const result = await client.query(
        `SELECT count(*)::int AS n FROM audit_events
         WHERE action IN ('file.download', 'file.preview') AND target_type = 'file_object'`,
      );
      expect(result.rows[0].n).toBeGreaterThanOrEqual(4);
    } finally {
      await client.end();
    }
  });
});
