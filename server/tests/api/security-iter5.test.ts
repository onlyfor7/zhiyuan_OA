import "./env-setup";

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

const YEAR = new Date().getFullYear();

function monday(offsetWeeks: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + offsetWeeks * 7);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

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

describe("迭代 5 安全与运维收口（arch/08 §3 服务端矩阵 + 收口项）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let sysadminCookie: string;
  let projectAId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    sysadminCookie = (await loginAs(app, "zhaokai@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    projectAId = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
      .result.data.items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("会话滑动续期：距到期 <2h 顺延至 8h；过期/停用照旧立即失效", async () => {
    const login = await trpc(app, "auth.login", {
      input: { email: "tianyiming@lexflow.demo", password: "Demo@2026" },
    });
    const cookie = login.setCookies.find((l) => l.startsWith("lexflow_session="))!.split(";")[0];
    const sessionId = (
      await query<{ id: string }>(
        `SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'tianyiming@lexflow.demo' ORDER BY s.created_at DESC LIMIT 1`,
      )
    )[0].id;

    // 临界前：expiresAt = now+90min → 任意访问 → 顺延至 now+8h
    await query(`UPDATE sessions SET expires_at = now() + interval '90 minutes' WHERE id = $1`, [sessionId]);
    const me1 = await trpc(app, "auth.me", { cookie, method: "GET" });
    expect(me1.status).toBe(200);
    const afterRenew = (
      await query<{ expires_at: string }>(`SELECT expires_at FROM sessions WHERE id = $1`, [sessionId])
    )[0].expires_at;
    const hoursLeft = (new Date(afterRenew).getTime() - Date.now()) / 3600_000;
    expect(hoursLeft).toBeGreaterThan(7);
    expect(hoursLeft).toBeLessThanOrEqual(8);

    // 距到期 >2h 不续（expiresAt = now+5h → 保持）
    await query(`UPDATE sessions SET expires_at = now() + interval '5 hours' WHERE id = $1`, [sessionId]);
    await trpc(app, "auth.me", { cookie, method: "GET" });
    const unchanged = (
      await query<{ expires_at: string }>(`SELECT expires_at FROM sessions WHERE id = $1`, [sessionId])
    )[0].expires_at;
    const hoursLeft5 = (new Date(unchanged).getTime() - Date.now()) / 3600_000;
    expect(hoursLeft5).toBeGreaterThan(4.5);
    expect(hoursLeft5).toBeLessThan(5.5);

    // 过期照旧立即失效
    await query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [sessionId]);
    const expired = await trpc(app, "auth.me", { cookie, method: "GET" });
    expect(expired.status).toBe(401);

    // 停用账号会话即时失效（回归）
    const fresh = await loginAs(app, "tianyiming@lexflow.demo");
    await query(`UPDATE users SET status = 'disabled' WHERE email = 'tianyiming@lexflow.demo'`);
    const disabled = await trpc(app, "auth.me", { cookie: fresh.cookie, method: "GET" });
    expect(disabled.status).toBe(401);
    await query(`UPDATE users SET status = 'active' WHERE email = 'tianyiming@lexflow.demo'`);
  });

  it("孤儿文件清理（R5 拆端点）：dry-run=GET 只读；实删=POST mutation；权限与审计齐备", async () => {
    // 非 sysadmin → 404 同形（两端点同口径）
    const denied = await trpc(app, "admin.storageOrphans", { cookie: memberCookie, method: "GET", input: {} });
    expect(denied.status).toBe(404);
    const deniedPurge = await trpc(app, "admin.storageOrphansPurge", { cookie: memberCookie, input: {} });
    expect(deniedPurge.status).toBe(404);

    // 方法不匹配（R5 顺带排查项）：POST 打 query 路径 → 405 带 businessCode；GET 打 mutation → 405
    const postOnQuery = await trpc(app, "admin.storageOrphans", { cookie: sysadminCookie, method: "POST", input: {} });
    expect(postOnQuery.status).toBe(405);
    expect((postOnQuery.json as { error: { data: { businessCode: string } } }).error.data.businessCode).toBe("VALIDATION_FAILED");
    const getOnMutation = await app.request("http://test/trpc/admin.storageOrphansPurge?input=%7B%7D", {
      method: "GET",
      headers: { cookie: sysadminCookie },
    });
    expect(getOnMutation.status).toBe(405);

    // 造孤儿：物理文件无 file_versions 引用
    const orphanName = `orphan-${crypto.randomUUID()}.pdf`;
    const { storageRoot } = await import("../../src/env");
    await writeFile(join(storageRoot, orphanName), Buffer.from("orphan"));
    const withRef = await uploadProbe(app, pmCookie, projectAId);

    // dry-run（GET 只读，无副作用幂等）
    const dryRun = await trpc(app, "admin.storageOrphans", { cookie: sysadminCookie, method: "GET", input: {} });
    expect(dryRun.status).toBe(200);
    const dryData = (dryRun.json as { result: { data: { dryRun: boolean; orphans: string[] } } }).result.data;
    expect(dryData.dryRun).toBe(true);
    expect(dryData.orphans).toContain(orphanName);
    expect(dryData.orphans).not.toContain(withRef);
    // 再跑一次 dry-run 幂等（孤儿仍在，未被删除）
    const dryRun2 = await trpc(app, "admin.storageOrphans", { cookie: sysadminCookie, method: "GET", input: {} });
    expect((dryRun2.json as { result: { data: { orphans: string[] } } }).result.data.orphans).toContain(orphanName);
    const auditDry = await query<{ after_json: { dryRun?: boolean } }>(
      `SELECT after_json FROM audit_events WHERE action = 'admin.storageOrphans' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(auditDry[0].after_json.dryRun).toBe(true);

    // 实删（POST mutation）+ 审计
    const confirm = await trpc(app, "admin.storageOrphansPurge", { cookie: sysadminCookie, input: {} });
    expect(confirm.status).toBe(200);
    const confirmData = (confirm.json as { result: { data: { dryRun: boolean; deleted: string[] } } }).result.data;
    expect(confirmData.dryRun).toBe(false);
    expect(confirmData.deleted).toContain(orphanName);
    const auditConfirm = await query<{ after_json: { deleted?: number }; action: string }>(
      `SELECT action, after_json FROM audit_events WHERE action = 'admin.storageOrphansPurge' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(auditConfirm[0].action).toBe("admin.storageOrphansPurge");
    expect(auditConfirm[0].after_json.deleted).toBeGreaterThanOrEqual(1);
  });

  it("时刻列精确重叠判定：同日均填时刻区间重叠出警告；不重叠无警告；时刻非法被拦", async () => {
    const week = monday(9);
    const mp = await trpc(app, "time.myPeriod", { cookie: memberCookie, method: "GET", input: { periodStart: week } });
    const periodId = (mp.json as { result: { data: { period: { id: string } } } }).result.data.period.id;
    const d0 = new Date(`${week}T00:00:00Z`);
    d0.setUTCDate(d0.getUTCDate() + 1);
    const date = d0.toISOString().slice(0, 10);

    const badPair = await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId: projectAId, activityType: "professional_work", workDate: date, durationMinutes: 60, startMinute: 600, endMinute: 600, description: "坏时刻" }],
      },
    });
    expect(badPair.status).toBe(400);

    const overlapping = await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId,
        idempotencyKey: crypto.randomUUID(),
        entries: [
          { projectId: projectAId, activityType: "professional_work", workDate: date, durationMinutes: 120, startMinute: 540, endMinute: 660, description: "上午" },
          { projectId: projectAId, activityType: "meeting", workDate: date, durationMinutes: 60, startMinute: 600, endMinute: 700, description: "重叠会" },
        ],
      },
    });
    expect(overlapping.status).toBe(200);
    const validate = await trpc(app, "time.validate", { cookie: memberCookie, input: { periodId }, method: "GET" });
    const warnings = (validate.json as { result: { data: { warnings: string[] } } }).result.data.warnings;
    expect(warnings.some((w) => w.includes("时间重叠"))).toBe(true);

    // 不重叠：替换为无交集区间
    const clean = await trpc(app, "time.saveEntries", {
      cookie: memberCookie,
      input: {
        periodId,
        idempotencyKey: crypto.randomUUID(),
        entries: [
          { projectId: projectAId, activityType: "professional_work", workDate: date, durationMinutes: 120, startMinute: 540, endMinute: 660, description: "上午" },
          { projectId: projectAId, activityType: "meeting", workDate: date, durationMinutes: 60, startMinute: 660, endMinute: 720, description: "下午会" },
        ],
      },
    });
    expect(clean.status).toBe(200);
    const validate2 = await trpc(app, "time.validate", { cookie: memberCookie, input: { periodId }, method: "GET" });
    const warnings2 = (validate2.json as { result: { data: { warnings: string[] } } }).result.data.warnings;
    expect(warnings2.some((w) => w.includes("时间重叠"))).toBe(false);
  });

  it("安全矩阵：篡改 projectId/userId/审批人/文件键/分享地址全部同形拒绝；注入探针无害", async () => {
    // 篡改 projectId：member 直取项目 B / 随机 uuid → 同形 404
    const projectBId = (
      await query<{ id: string }>(`SELECT id FROM projects WHERE code = $1`, [`PRJ-${YEAR}-00002`])
    )[0].id;
    for (const id of [projectBId, "00000000-0000-0000-0000-000000000000"]) {
      const denied = await trpc(app, "project.getById", { cookie: memberCookie, input: { id }, method: "GET" });
      expect(denied.status).toBe(404);
      expect(trpcError(denied).businessCode).toBe("ACCESS_DENIED_OR_GONE");
    }

    // 篡改 userId（水平越权读他人报销）：member 读 pm 的报销 → 404 同形
    const pmExpense = await query<{ id: string }>(
      `SELECT er.id FROM expense_reports er WHERE er.applicant_id = (SELECT id FROM users WHERE email='wangbaozhuo@lexflow.demo') LIMIT 1`,
    );
    if (pmExpense[0]) {
      const denied = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id: pmExpense[0].id }, method: "GET" });
      expect(denied.status).toBe(404);
    }

    // 篡改审批人：member 对 pm 的待审实例执行 act → 404
    const pendingInstance = await query<{ id: string; applicant_id: string }>(
      `SELECT id, applicant_id FROM approval_instances WHERE status='pending' LIMIT 1`,
    );
    if (pendingInstance[0]) {
      const tampered = await trpc(app, "approval.act", {
        cookie: memberCookie,
        input: { instanceId: pendingInstance[0].id, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
      });
      expect(tampered.status).toBe(404);
    }

    // 篡改文件键：路径穿越与伪造 id 同形拒绝
    const traversal = await app.request("http://test/files/..%2F..%2F.env/download", { headers: { cookie: pmCookie } });
    expect([400, 404]).toContain(traversal.status);
    const forged = await app.request("http://test/files/not-a-uuid/download", { headers: { cookie: pmCookie } });
    expect([400, 404]).toContain(forged.status);

    // 篡改分享地址：A 的令牌用于 B → 401（与伪造同形）
    const probeA = await uploadProbe(app, pmCookie, projectAId);
    const probeB = await uploadProbe(app, pmCookie, projectAId);
    const { signDownloadToken } = await import("../../src/services/file/tokens");
    const tokenA = signDownloadToken(probeA);
    const cross = await app.request(`http://test/files/${probeB}/download?token=${encodeURIComponent(tokenA)}`);
    expect(cross.status).toBe(401);

    // 枚举注入：非法枚举值 zod 拒绝
    const badEnum = await trpc(app, "quality.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId,
        title: "枚举注入",
        description: "x",
        severity: "critical; DROP TABLE" as never,
      },
    });
    expect(badEnum.status).toBe(400);

    // SQL 注入探针：关键词作为字面量处理，0 命中无异常
    const inject = await trpc(app, "search.query", {
      cookie: memberCookie,
      method: "GET",
      input: { q: "'; DROP TABLE users;--" },
    });
    expect(inject.status).toBe(200);
    const injectData = (inject.json as { result: { data: { items: unknown[] } } }).result.data;
    expect(injectData.items).toHaveLength(0);

    // 上传绕过负例：双扩展名按末段白名单拒绝
    const form = new FormData();
    form.append("sourceType", "project");
    form.append("sourceId", projectAId);
    form.append("file", new Blob([new Uint8Array([1, 2, 3]).buffer], { type: "application/pdf" }), "malicious.pdf.exe");
    const upload = await app.request("http://test/files/upload", { method: "POST", headers: { cookie: pmCookie }, body: form });
    expect(upload.status).toBe(400);

    // CSRF 面：cookie SameSite=Lax 保持（无 JSON CSRF 面评估结论见 docs/安全与运维说明.md）
    const setCookie = (await trpc(app, "auth.login", { input: { email: "wangbaozhuo@lexflow.demo", password: "Demo@2026" } }))
      .setCookies.find((l) => l.startsWith("lexflow_session="));
    expect(setCookie).toContain("SameSite=Lax");
  });
});

async function uploadProbe(
  app: Awaited<ReturnType<typeof getApp>>,
  cookie: string,
  sourceId: string,
): Promise<string> {
  const form = new FormData();
  form.append("sourceType", "project");
  form.append("sourceId", sourceId);
  form.append("file", new Blob([new Uint8Array([7, 7, 7]).buffer], { type: "application/pdf" }), "探针.pdf");
  const response = await app.request("http://test/files/upload", { method: "POST", headers: { cookie }, body: form });
  expect(response.status).toBe(200);
  return ((await response.json()) as { fileVersionId: string }).fileVersionId;
}
