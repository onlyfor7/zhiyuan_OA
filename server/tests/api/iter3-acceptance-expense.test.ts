import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 3 验收套件·费用重资产（arch/06 §9）：
 * C4 合计服务端/逐行鉴权、C5 重复票据命中不命中矩阵（R1 主辅因子）、
 * C6 五检查项随快照、C8 支付登记权限+幂等+paid 后编辑拒、
 * C9 调整净额可追溯、R4 同经费双报销核销 RELEASED 完整性回归。
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

async function approveInstance(
  app: Awaited<ReturnType<typeof getApp>>, cookie: string, instanceId: string, maxSteps = 6,
): Promise<void> {
  for (let guard = 0; guard < maxSteps; guard += 1) {
    const detail = await trpc(app, "approval.getById", { cookie, input: { id: instanceId }, method: "GET" });
    const instance = (detail.json as {
      result: { data: { status: string; currentStepSeq: number; steps: { seq: number; approverRole: string | null }[] } };
    }).result.data;
    if (instance.status !== "pending") return;
    const step = instance.steps.find((s) => s.seq === instance.currentStepSeq);
    if (!step) return;
    const approverCookie =
      step.approverRole === "partner" ? (await loginAs(app, "liangqifeng@lexflow.demo")).cookie
      : step.approverRole === "finance" ? (await loginAs(app, "guojingwen@lexflow.demo")).cookie
      : step.approverRole === "project_manager" ? (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie
      : cookie;
    const acted = await trpc(app, "approval.act", {
      cookie: approverCookie,
      input: { instanceId, stepSeq: step.seq, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(acted.status).toBe(200);
  }
}

async function submitAndApproveExpense(
  app: Awaited<ReturnType<typeof getApp>>, cookie: string, reportId: string,
): Promise<string> {
  const detail = await trpc(app, "expense.getById", { cookie, input: { id: reportId }, method: "GET" });
  const submitted = await trpc(app, "expense.submit", {
    cookie,
    input: { id: reportId, rowVersion: (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
  });
  expect(submitted.status).toBe(200);
  const instanceId = (submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
  await approveInstance(app, cookie, instanceId);
  return instanceId;
}

async function uploadReceipt(
  app: Awaited<ReturnType<typeof getApp>>, cookie: string, projectId: string, bytes: Uint8Array,
): Promise<string> {
  const form = new FormData();
  form.append("sourceType", "expense");
  form.append("sourceId", projectId);
  form.append("file", new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" }), "票据.pdf");
  const response = await app.request("http://test/files/upload", {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { fileVersionId: string }).fileVersionId;
}

describe("迭代 3 验收·费用重资产（arch/06 §9）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let financeCookie: string;
  let partnerCookie: string;
  let projectAId: string;
  let projectBId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    financeCookie = (await loginAs(app, "guojingwen@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "liangqifeng@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } }).result.data.items;
    projectAId = items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
    projectBId = items.find((p) => p.code === `PRJ-${YEAR}-00002`)!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("C4 创建：合计一律服务端计算（前端传错被忽略）；跨项目明细逐行鉴权", async () => {
    const created = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "C4 服务端合计验收",
        totalCents: 123_456_789,
        items: [
          { projectId: projectAId, date: "2027-11-01", category: "transport", amountCents: 120_000, description: "车票" },
          { projectId: projectAId, date: "2027-11-01", category: "meals", amountCents: 80_000, description: "餐费" },
        ],
      },
    });
    expect(created.status).toBe(200);
    expect((created.json as { result: { data: { totalCents: number } } }).result.data.totalCents).toBe(200_000);

    const bad = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "越权跨项目行",
        items: [
          { projectId: projectAId, date: "2027-11-02", category: "transport", amountCents: 10_000, description: "A 行" },
          { projectId: projectBId, date: "2027-11-02", category: "transport", amountCents: 10_000, description: "B 行越权" },
        ],
      },
    });
    expect(bad.status).toBe(404);
    expect(trpcError(bad).businessCode).toBe("ACCESS_DENIED_OR_GONE");
  });

  it("C5 重复票据命中/不命中矩阵（R1 修复后主辅因子）+ 原报销定位", async () => {
    const shaA = new Uint8Array([0x61, 0x62, 0x63, 0x41]);
    const shaB = new Uint8Array([0x61, 0x62, 0x63, 0x42]);
    const receiptA1 = await uploadReceipt(app, pmCookie, projectAId, shaA);
    const receiptA2 = await uploadReceipt(app, pmCookie, projectAId, shaA); // 同内容异版本
    const receiptB = await uploadReceipt(app, pmCookie, projectAId, shaB);

    // 基准单：号 INV-ACC-7 / 100_000 / 文件 A1 → 审批通过成为历史票据
    const base = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "票据基准单（验收）",
        items: [
          { projectId: projectAId, date: "2027-11-05", category: "materials", amountCents: 100_000, description: "基准", receiptNo: "INV-ACC-7", receiptFileVersionId: receiptA1 },
        ],
      },
    });
    const baseData = (base.json as { result: { data: { id: string; code: string } } }).result.data;
    await submitAndApproveExpense(app, memberCookie, baseData.id);

    const trySubmit = async (input: Record<string, unknown>) => {
      const created = await trpc(app, "expense.create", {
        cookie: memberCookie,
        input: { reason: "票据矩阵（验收）", items: [input] },
      });
      expect(created.status).toBe(200);
      const id = (created.json as { result: { data: { id: string } } }).result.data.id;
      const detail = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id }, method: "GET" });
      const res = await trpc(app, "expense.submit", {
        cookie: memberCookie,
        input: { id, rowVersion: (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
      });
      return { id, res };
    };
    const expectHit = (res: Awaited<ReturnType<typeof trpc>>, baseCode: string) => {
      expect(res.status).toBe(409);
      expect(trpcError(res).businessCode).toBe("DUPLICATE_RECEIPT");
      const details = (res.json as { error: { data: { details?: { originalReportCode?: string; originalReportId?: string } } } }).error.data.details;
      expect(details?.originalReportCode).toBe(baseCode);
      expect(details?.originalReportId).toBe(baseData.id);
    };

    // 命中①（R1 主场景）：原票有文件，新票无文件，同号同额 → 必拦
    const hitNoFile = await trySubmit({ projectId: projectAId, date: "2027-11-06", category: "materials", amountCents: 100_000, description: "无文件同号同额", receiptNo: "INV-ACC-7" });
    expectHit(hitNoFile.res, baseData.code);
    // 命中②（主因子不看 sha）：同号同额 + 异内容文件 → 拦
    const hitDiffSha = await trySubmit({ projectId: projectAId, date: "2027-11-07", category: "materials", amountCents: 100_000, description: "异sha同号同额", receiptNo: "INV-ACC-7", receiptFileVersionId: receiptB });
    expectHit(hitDiffSha.res, baseData.code);
    // 命中③（辅因子）：异号 + 同 sha + 同额 → 拦
    const hitSameSha = await trySubmit({ projectId: projectAId, date: "2027-11-08", category: "materials", amountCents: 100_000, description: "异号同sha同额", receiptNo: "INV-ACC-8", receiptFileVersionId: receiptA2 });
    expectHit(hitSameSha.res, baseData.code);
    // 不命中①：异号 + 异 sha + 同额 → 放行
    const missDiff = await trySubmit({ projectId: projectAId, date: "2027-11-09", category: "materials", amountCents: 100_000, description: "异号异sha", receiptNo: "INV-ACC-9", receiptFileVersionId: receiptB });
    expect(missDiff.res.status).toBe(200);
    // 不命中②：同号 + 异额 → 放行
    const missAmount = await trySubmit({ projectId: projectAId, date: "2027-11-10", category: "materials", amountCents: 100_001, description: "同号异额", receiptNo: "INV-ACC-7" });
    expect(missAmount.res.status).toBe(200);
  });

  it("C6 审批检查项五项可见且随快照冻结（预算/经费/票据/关联/重复）", async () => {
    await query(
      `UPDATE system_config SET value_json = jsonb_set(coalesce(value_json,'{}'), '{byCategory,transport}', '{"required": true}') WHERE key = 'expense.receipt_rules'`,
    );
    try {
      const created = await trpc(app, "expense.create", {
        cookie: memberCookie,
        input: {
          reason: "检查项验收",
          items: [
            { projectId: projectAId, date: "2027-11-12", category: "transport", amountCents: 60_000, description: "缺票据交通费" },
          ],
        },
      });
      const id = (created.json as { result: { data: { id: string } } }).result.data.id;
      const detail = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id }, method: "GET" });
      const submitted = await trpc(app, "expense.submit", {
        cookie: memberCookie,
        input: { id, rowVersion: (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
      });
      expect(submitted.status).toBe(200);
      const checks = (submitted.json as { result: { data: { checks: { name: string; pass: boolean }[] } } }).result.data.checks;
      expect(checks.map((c) => c.name)).toEqual([
        "budget_sufficiency", "funding_sufficiency", "receipt_completeness", "link_validity", "duplicate_receipt",
      ]);
      expect(checks.find((c) => c.name === "receipt_completeness")?.pass).toBe(false);
      expect(checks.find((c) => c.name === "budget_sufficiency")?.pass).toBe(true);
      const instanceId = (submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
      const approval = await trpc(app, "approval.getById", { cookie: pmCookie, input: { id: instanceId }, method: "GET" });
      const snapshot = (approval.json as { result: { data: { formSnapshot: { checks?: unknown[] } } } }).result.data.formSnapshot;
      expect(Array.isArray(snapshot.checks)).toBe(true);
    } finally {
      await query(`UPDATE system_config SET value_json = '{"byCategory": {}, "duplicateReceipt": "block"}' WHERE key = 'expense.receipt_rules'`);
    }
  });

  it("C8 支付登记：finance 专属 + 幂等重放 + paid 后编辑被拒", async () => {
    const expense = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "支付登记验收",
        items: [{ projectId: projectAId, date: "2027-11-15", category: "meals", amountCents: 88_000, description: "餐费" }],
      },
    });
    const reportId = (expense.json as { result: { data: { id: string } } }).result.data.id;
    await submitAndApproveExpense(app, memberCookie, reportId);

    const denied = await trpc(app, "expense.markPaid", {
      cookie: memberCookie,
      input: { id: reportId, paymentRef: "X", idempotencyKey: crypto.randomUUID() },
    });
    expect(denied.status).toBe(404);

    const key = crypto.randomUUID();
    const paid1 = await trpc(app, "expense.markPaid", {
      cookie: financeCookie,
      input: { id: reportId, paymentRef: "PAY-ACC-0001", idempotencyKey: key },
    });
    expect(paid1.status).toBe(200);
    expect((paid1.json as { result: { data: { report: { status: string; paidAt: string | null } } } }).result.data.report).toMatchObject({ status: "paid" });
    const paidAt1 = (paid1.json as { result: { data: { report: { paidAt: string } } } }).result.data.report.paidAt;
    const paid2 = await trpc(app, "expense.markPaid", {
      cookie: financeCookie,
      input: { id: reportId, paymentRef: "PAY-ACC-0001", idempotencyKey: key },
    });
    expect((paid2.json as { result: { data: { replayed: boolean; report: { paidAt: string } } } }).result.data).toMatchObject({ replayed: true });
    expect((paid2.json as { result: { data: { report: { paidAt: string } } } }).result.data.report.paidAt).toBe(paidAt1);

    const edit = await trpc(app, "expense.update", {
      cookie: memberCookie,
      input: { id: reportId, rowVersion: 99, reason: "篡改已支付记录" },
    });
    expect(edit.status).toBe(409);
    expect(trpcError(edit).businessCode).toBe("STATE_CONFLICT"); // paid 后编辑被拒（仅草稿可改）
    const earlyAdjust = await trpc(app, "expense.adjustCreate", {
      cookie: financeCookie,
      input: { expenseId: (await (async () => {
        const draft = await trpc(app, "expense.create", {
          cookie: memberCookie,
          input: { reason: "未支付调整验收", items: [{ projectId: projectAId, date: "2027-11-16", category: "meals", amountCents: 5_000, description: "x" }] },
        });
        return (draft.json as { result: { data: { id: string } } }).result.data.id;
      })()), deltaCents: -1_000, reason: "过早", idempotencyKey: crypto.randomUUID() },
    });
    expect(earlyAdjust.status).toBe(409);
  });

  it("C9 调整/冲销：paid 更正唯一通道，EXPENSE_ADJUSTED 净额可追溯，原记录不可变", async () => {
    const expense = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "调整验收报销",
        items: [{ projectId: projectAId, date: "2027-11-18", category: "translation", amountCents: 400_000, description: "翻译费" }],
      },
    });
    const reportId = (expense.json as { result: { data: { id: string } } }).result.data.id;
    await submitAndApproveExpense(app, memberCookie, reportId);
    await trpc(app, "expense.markPaid", {
      cookie: financeCookie,
      input: { id: reportId, paymentRef: "PAY-ACC-0002", idempotencyKey: crypto.randomUUID() },
    });

    const before = await query<{ actual: number }>(
      `SELECT coalesce(sum(actual_delta_cents),0)::float8 AS actual FROM budget_ledger WHERE project_id=$1`, [projectAId],
    );
    const adjusted = await trpc(app, "expense.adjustCreate", {
      cookie: financeCookie,
      input: { expenseId: reportId, deltaCents: -120_000, reason: "冲销多计部分（验收）", idempotencyKey: crypto.randomUUID() },
    });
    expect(adjusted.status).toBe(200);
    const adjustmentId = (adjusted.json as { result: { data: { adjustment: { id: string } } } }).result.data.adjustment.id;
    const instanceId = (adjusted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const approvalDetail = await trpc(app, "approval.getById", { cookie: financeCookie, input: { id: instanceId }, method: "GET" });
    expect((approvalDetail.json as { result: { data: { steps: { approverRole: string | null }[] } } }).result.data.steps.map((s) => s.approverRole)).toEqual(["partner"]);
    await approveInstance(app, financeCookie, instanceId);

    const after = await query<{ actual: number }>(
      `SELECT coalesce(sum(actual_delta_cents),0)::float8 AS actual FROM budget_ledger WHERE project_id=$1`, [projectAId],
    );
    expect(Number(after[0].actual) - Number(before[0].actual)).toBe(-120_000);
    const entry = await query<{ entry_type: string; actual_delta_cents: number; idempotency_key: string }>(
      `SELECT entry_type, actual_delta_cents, idempotency_key FROM budget_ledger WHERE source_type='expense_adjustment' AND source_id=$1`,
      [adjustmentId],
    );
    expect(entry[0].entry_type).toBe("EXPENSE_ADJUSTED");
    expect(Number(entry[0].actual_delta_cents)).toBe(-120_000);
    expect(entry[0].idempotency_key).toBe(`EXPENSE_ADJUSTED:${adjustmentId}:0`);
    const status = await query<{ status: string }>(`SELECT status FROM expense_adjustments WHERE id=$1`, [adjustmentId]);
    expect(status[0].status).toBe("approved");

    // 可追溯：原报销仍 paid 且金额不变；统计净额反映调整
    const original = await trpc(app, "expense.getById", { cookie: financeCookie, input: { id: reportId }, method: "GET" });
    expect((original.json as { result: { data: { status: string; totalCents: number } } }).result.data).toMatchObject({ status: "paid", totalCents: 400_000 });
    const stats = await trpc(app, "expense.stats.byProject", { cookie: financeCookie, method: "GET", input: { projectId: projectAId } });
    const recomputed = await query<{ actual: number }>(
      `SELECT coalesce(sum(actual_delta_cents),0)::float8 AS actual FROM budget_ledger WHERE project_id=$1`, [projectAId],
    );
    expect((stats.json as { result: { data: { actualCents: number } } }).result.data.actualCents).toBe(Number(recomputed[0].actual));
  });

  it("R4 回归：同一经费被两张报销核销——两条 RELEASED 均入账、净占用正确、重放不重复", async () => {
    // 经费 4M 获批
    const funding = await trpc(app, "funding.create", {
      cookie: memberCookie,
      input: { projectId: projectAId, purpose: "R4 回归经费", amountCents: 4_000_000 },
    });
    const fundingId = (funding.json as { result: { data: { id: string } } }).result.data.id;
    const fDetail = await trpc(app, "funding.getById", { cookie: memberCookie, input: { id: fundingId }, method: "GET" });
    const fSubmitted = await trpc(app, "funding.submit", {
      cookie: memberCookie,
      input: { id: fundingId, rowVersion: (fDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const fInstance = (fSubmitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    await approveInstance(app, memberCookie, fInstance);

    // 报销 A 1.5M
    const expA = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "R4 报销 A",
        items: [{ projectId: projectAId, fundingRequestId: fundingId, date: "2027-11-20", category: "transport", amountCents: 1_500_000, description: "A 明细" }],
      },
    });
    const expAId = (expA.json as { result: { data: { id: string } } }).result.data.id;
    const instA = await submitAndApproveExpense(app, memberCookie, expAId);

    // 报销 B 1.0M
    const expB = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "R4 报销 B",
        items: [{ projectId: projectAId, fundingRequestId: fundingId, date: "2027-11-21", category: "accommodation", amountCents: 1_000_000, description: "B 明细" }],
      },
    });
    const expBId = (expB.json as { result: { data: { id: string } } }).result.data.id;
    const instB = await submitAndApproveExpense(app, memberCookie, expBId);

    // 两条 RELEASED 均入账（键 funding:report 不冲突）
    const released = await query<{ idempotency_key: string; reserved_delta_cents: number }>(
      `SELECT idempotency_key, reserved_delta_cents FROM budget_ledger
       WHERE source_type='funding' AND source_id=$1 AND entry_type='FUNDING_RELEASED'`,
      [fundingId],
    );
    expect(released).toHaveLength(2);
    expect(released.map((r) => r.idempotency_key).sort()).toEqual([
      `FUNDING_RELEASED:${fundingId}:${expAId}`,
      `FUNDING_RELEASED:${fundingId}:${expBId}`,
    ].sort());
    expect(released.reduce((s, r) => s + Number(r.reserved_delta_cents), 0)).toBe(-2_500_000);

    // 净占用 1.5M 与使用态
    const fundingAfter = await trpc(app, "funding.getById", { cookie: memberCookie, input: { id: fundingId }, method: "GET" });
    const fundingData = (fundingAfter.json as {
      result: { data: { figures: { remainingCents: number }; usageStatus: string } };
    }).result.data;
    expect(fundingData.figures.remainingCents).toBe(1_500_000);
    expect(fundingData.usageStatus).toBe("partially_used");

    // 审批重放 → 无第三条 RELEASED
    const replay = await trpc(app, "approval.act", {
      cookie: financeCookie,
      input: { instanceId: instB, stepSeq: 2, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(replay.status).toBe(409);
    const releasedAfter = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM budget_ledger WHERE source_type='funding' AND source_id=$1 AND entry_type='FUNDING_RELEASED'`,
      [fundingId],
    );
    expect(releasedAfter[0].n).toBe(2);
    expect(instA).not.toBe(instB);
  });
});
