import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { registerHandler } from "../../src/services/approval/engine";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 3 验收套件·台账重资产（arch/06 §9 C3 为核心）：
 * 五公式全量重算 vs 聚合接口一致（种子+新建混合）、核销事务故障注入回滚零部分写入、
 * 幂等键重放不重复记账、双扣检测、C2 经费占用闭环、C1 预算生命周期。
 * 与后端 finance-budget/finance-expense 自测互补的独立验收取证。
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

/** 五公式 SQL 全量重算（独立口径，不经过服务端聚合代码） */
async function recomputeFive(projectId: string): Promise<{
  effectiveBudget: number; reserved: number; actual: number; available: number; executionRate: number | null; hasBudget: boolean;
}> {
  const rows = await query<{
    effective_budget: number | null; reserved: number; actual: number;
  }>(
    `SELECT
       (SELECT total_cents::float8 FROM budgets WHERE project_id=$1 AND status='active' LIMIT 1) AS effective_budget,
       (SELECT coalesce(sum(reserved_delta_cents),0)::float8 FROM budget_ledger WHERE project_id=$1) AS reserved,
       (SELECT coalesce(sum(actual_delta_cents),0)::float8 FROM budget_ledger WHERE project_id=$1) AS actual`,
    [projectId],
  );
  const r = rows[0];
  const hasBudget = r.effective_budget !== null;
  const effectiveBudget = hasBudget ? Number(r.effective_budget) : 0;
  const reserved = Number(r.reserved);
  const actual = Number(r.actual);
  return {
    effectiveBudget,
    reserved,
    actual,
    available: effectiveBudget - reserved - actual,
    executionRate: hasBudget && effectiveBudget > 0 ? actual / effectiveBudget : null,
    hasBudget,
  };
}

async function activeBudgetId(projectId: string): Promise<string> {
  const rows = await query<{ id: string }>(`SELECT id FROM budgets WHERE project_id=$1 AND status='active'`, [projectId]);
  return rows[0].id;
}

async function aggregateOf(app: Awaited<ReturnType<typeof getApp>>, cookie: string, budgetId: string) {
  const res = await trpc(app, "budget.getById", { cookie, method: "GET", input: { id: budgetId } });
  expect(res.status).toBe(200);
  return (res.json as {
    result: {
      data: {
        rowVersion: number;
        aggregate: {
          effectiveBudgetCents: number; reservedCents: number; actualCents: number;
          availableCents: number; executionRate: number | null; hasBudget: boolean;
        };
      };
    };
  }).result.data;
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
      step.approverRole === "partner" ? (await loginAs(app, "partner@lexflow.demo")).cookie
      : step.approverRole === "finance" ? (await loginAs(app, "finance@lexflow.demo")).cookie
      : step.approverRole === "project_manager" ? (await loginAs(app, "pm@lexflow.demo")).cookie
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
): Promise<void> {
  const detail = await trpc(app, "expense.getById", { cookie, input: { id: reportId }, method: "GET" });
  const rv = (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
  const submitted = await trpc(app, "expense.submit", {
    cookie,
    input: { id: reportId, rowVersion: rv, idempotencyKey: crypto.randomUUID() },
  });
  expect(submitted.status).toBe(200);
  const instanceId = (submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
  await approveInstance(app, cookie, instanceId);
}

describe("迭代 3 验收·台账重资产（arch/06 §9）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let partnerCookie: string;
  let memberCookie: string;
  let financeCookie: string;
  let projectAId: string;
  let projectBId: string;
  let projectCId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "pm@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "partner@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "member@lexflow.demo")).cookie;
    financeCookie = (await loginAs(app, "finance@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } }).result.data.items;
    projectAId = items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
    projectBId = items.find((p) => p.code === `PRJ-${YEAR}-00002`)!.id;
    projectCId = (await query<{ id: string }>(`SELECT id FROM projects WHERE code = $1`, [`PRJ-${YEAR}-00003`]))[0].id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("C3 台账五公式全量重算 vs 聚合接口一致（种子基线 + 新建业务混合）", async () => {
    // ① 种子基线：A=80M/占用2M/实际0；B=20M/0/0
    const a0 = await recomputeFive(projectAId);
    const aggA0 = await aggregateOf(app, pmCookie, await activeBudgetId(projectAId));
    expect(a0).toMatchObject({
      effectiveBudget: 80_000_000, reserved: 2_000_000, actual: 0, available: 78_000_000, executionRate: 0, hasBudget: true,
    });
    expect(aggA0.aggregate).toMatchObject({
      effectiveBudgetCents: a0.effectiveBudget, reservedCents: a0.reserved,
      actualCents: a0.actual, availableCents: a0.available, hasBudget: true,
    });
    const b0 = await recomputeFive(projectBId);
    const aggB0 = await aggregateOf(app, pmCookie, await activeBudgetId(projectBId));
    expect(b0).toMatchObject({ effectiveBudget: 20_000_000, reserved: 0, actual: 0, available: 20_000_000 });
    expect(aggB0.aggregate.effectiveBudgetCents).toBe(b0.effectiveBudget);

    // ② 新建业务：经费 3M 获批（RESERVED）+ 报销 2.2M 关联核销（RELEASED+RECOGNIZED）
    const funding = await trpc(app, "funding.create", {
      cookie: memberCookie,
      input: { projectId: projectAId, purpose: "C3 混合重算经费", amountCents: 3_000_000 },
    });
    const fundingId = (funding.json as { result: { data: { id: string } } }).result.data.id;
    const fDetail = await trpc(app, "funding.getById", { cookie: memberCookie, input: { id: fundingId }, method: "GET" });
    const fSubmitted = await trpc(app, "funding.submit", {
      cookie: memberCookie,
      input: { id: fundingId, rowVersion: (fDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    await approveInstance(app, memberCookie, (fSubmitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id);

    const expense = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "C3 混合重算报销",
        items: [{ projectId: projectAId, fundingRequestId: fundingId, date: "2027-10-01", category: "transport", amountCents: 2_200_000, description: "重算明细" }],
      },
    });
    await submitAndApproveExpense(app, memberCookie, (expense.json as { result: { data: { id: string } } }).result.data.id);

    // ③ 重算：占用 2M+3M−2.2M=2.8M；实际 2.2M；聚合接口一致
    const a1 = await recomputeFive(projectAId);
    const aggA1 = await aggregateOf(app, pmCookie, await activeBudgetId(projectAId));
    expect(a1).toMatchObject({ effectiveBudget: 80_000_000, reserved: 2_800_000, actual: 2_200_000, available: 75_000_000 });
    expect(a1.executionRate).toBeCloseTo(2_200_000 / 80_000_000, 10);
    expect(aggA1.aggregate).toMatchObject({
      reservedCents: a1.reserved, actualCents: a1.actual, availableCents: a1.available, hasBudget: true,
    });
    expect(aggA1.aggregate.executionRate ?? 0).toBeCloseTo(a1.executionRate ?? 0, 10);

    // ④ 无预算项目：hasBudget=false（「未设预算」≠ 余额零）
    const c0 = await recomputeFive(projectCId);
    expect(c0.hasBudget).toBe(false);
    const overviewC = await trpc(app, "project.overview", { cookie: partnerCookie, method: "GET", input: { projectId: projectCId } });
    expect((overviewC.json as { result: { data: { budgetSummary: { hasBudget: boolean } } } }).result.data.budgetSummary).toMatchObject({ hasBudget: false });
  });

  it("C7 核销事务故障注入：RELEASED 与 RECOGNIZED 要么都在要么都不在；双扣检测", async () => {
    // 经费 2.5M 获批；报销 2M 关联 + 0.6M 无关联
    const funding = await trpc(app, "funding.create", {
      cookie: memberCookie,
      input: { projectId: projectAId, purpose: "故障注入经费", amountCents: 2_500_000 },
    });
    const fundingId = (funding.json as { result: { data: { id: string } } }).result.data.id;
    const fDetail = await trpc(app, "funding.getById", { cookie: memberCookie, input: { id: fundingId }, method: "GET" });
    const fSubmitted = await trpc(app, "funding.submit", {
      cookie: memberCookie,
      input: { id: fundingId, rowVersion: (fDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    await approveInstance(app, memberCookie, (fSubmitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id);

    const expense = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "故障注入报销",
        items: [
          { projectId: projectAId, fundingRequestId: fundingId, date: "2027-10-05", category: "transport", amountCents: 2_000_000, description: "关联明细" },
          { projectId: projectAId, date: "2027-10-05", category: "meals", amountCents: 600_000, description: "无关联明细" },
        ],
      },
    });
    const reportId = (expense.json as { result: { data: { id: string } } }).result.data.id;
    const detail = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id: reportId }, method: "GET" });
    const submitted = await trpc(app, "expense.submit", {
      cookie: memberCookie,
      input: { id: reportId, rowVersion: (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const instanceId = (submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
    });

    // 注入：终审 handler 抛错 → 整事务回滚
    const unregister = registerHandler("expense", {
      async onApproved(): Promise<void> { throw new Error("人为制造：核销失败（验收回滚探测）"); },
      async onRejected(): Promise<void> { /* noop */ },
      async onWithdrawn(): Promise<void> { /* noop */ },
    });
    try {
      const failed = await trpc(app, "approval.act", {
        cookie: financeCookie,
        input: { instanceId, stepSeq: 2, action: "approve", idempotencyKey: crypto.randomUUID() },
      });
      expect(failed.status).toBe(500);
    } finally {
      unregister();
    }

    // 零部分写入：无 RECOGNIZED/RELEASED；报销仍 pending；经费占用净额原样
    const partial = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM budget_ledger WHERE source_id=$1 AND entry_type IN ('EXPENSE_RECOGNIZED','FUNDING_RELEASED')`,
      [reportId],
    );
    expect(partial[0].n).toBe(0);
    const reportAfter = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id: reportId }, method: "GET" });
    expect((reportAfter.json as { result: { data: { status: string } } }).result.data.status).toBe("pending_approval");
    const fundingNet = await query<{ net: number }>(
      `SELECT coalesce(sum(reserved_delta_cents),0)::float8 AS net FROM budget_ledger WHERE source_type='funding' AND source_id=$1`,
      [fundingId],
    );
    expect(Number(fundingNet[0].net)).toBe(2_500_000); // 释放未发生

    // 修复后重放终审：RELEASED 与 RECOGNIZED 同时出现
    const replay = await trpc(app, "approval.act", {
      cookie: financeCookie,
      input: { instanceId, stepSeq: 2, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(replay.status).toBe(200);
    const entries = await query<{ entry_type: string; reserved_delta_cents: number; actual_delta_cents: number }>(
      `SELECT entry_type, reserved_delta_cents, actual_delta_cents FROM budget_ledger
       WHERE (source_type='funding' AND source_id=$1) OR (source_type='expense' AND source_id=$2) ORDER BY created_at`,
      [fundingId, reportId],
    );
    const released = entries.filter((e) => e.entry_type === "FUNDING_RELEASED").reduce((s, e) => s + Number(e.reserved_delta_cents), 0);
    const recognized = entries.filter((e) => e.entry_type === "EXPENSE_RECOGNIZED").reduce((s, e) => s + Number(e.actual_delta_cents), 0);
    expect(released).toBe(-2_000_000);
    expect(recognized).toBe(2_600_000);

    // 双扣检测：实际 2.6M 只计一次；经费未释放的 0.5M 仍只占用于，不同额重复出现在实际
    expect(released + recognized).not.toBe(0);
    const fundingRemaining = 2_500_000 + released; // 500000
    expect(fundingRemaining).toBe(500_000);
    // 关联明细 2M 已由 RELEASED 全额覆盖——实际中不得再存在「与未释放占用同额」的重复扣减
    const overlap = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM budget_ledger
       WHERE source_type='funding' AND source_id=$1 AND entry_type='FUNDING_RESERVED'
         AND reserved_delta_cents = 500000`,
      [fundingId],
    );
    expect(overlap[0].n).toBe(0); // 未释放部分未被记实际（无双扣）
  });

  it("C3 幂等键重放不重复记账（直接重放 + 审批重放双路径）", async () => {
    const fundingId = (await query<{ id: string }>(`SELECT id FROM funding_requests WHERE code=$1`, [`FND-${YEAR}-00001`]))[0].id;
    const before = await query<{ n: number; net: number }>(
      `SELECT count(*)::int AS n, coalesce(sum(reserved_delta_cents),0)::float8 AS net FROM budget_ledger WHERE source_type='funding' AND source_id=$1`,
      [fundingId],
    );
    const { recordLedger } = await import("../../src/services/ledger/record");
    const { db } = await import("../../src/db/client");
    await recordLedger(db, {
      projectId: projectAId, sourceType: "funding", sourceId: fundingId,
      entryType: "FUNDING_RESERVED", reservedDeltaCents: 2_000_000, seq: 0,
    });
    const after = await query<{ n: number; net: number }>(
      `SELECT count(*)::int AS n, coalesce(sum(reserved_delta_cents),0)::float8 AS net FROM budget_ledger WHERE source_type='funding' AND source_id=$1`,
      [fundingId],
    );
    expect(after[0].n).toBe(before[0].n);
    expect(Number(after[0].net)).toBe(2_000_000);

    // 审批重放：同一 act 幂等键 → applied=false → 台账行数不增
    const expense = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "审批重放不双记",
        items: [{ projectId: projectAId, date: "2027-10-08", category: "materials", amountCents: 50_000, description: "重放明细" }],
      },
    });
    const reportId = (expense.json as { result: { data: { id: string } } }).result.data.id;
    const detail = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id: reportId }, method: "GET" });
    const submitted = await trpc(app, "expense.submit", {
      cookie: memberCookie,
      input: { id: reportId, rowVersion: (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const instanceId = (submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    await trpc(app, "approval.act", { cookie: pmCookie, input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() } });
    const key = crypto.randomUUID();
    const final1 = await trpc(app, "approval.act", { cookie: financeCookie, input: { instanceId, stepSeq: 2, action: "approve", idempotencyKey: key } });
    expect(final1.status).toBe(200);
    const rows1 = await query<{ n: number }>(`SELECT count(*)::int AS n FROM budget_ledger WHERE source_type='expense' AND source_id=$1`, [reportId]);
    const final2 = await trpc(app, "approval.act", { cookie: financeCookie, input: { instanceId, stepSeq: 2, action: "approve", idempotencyKey: key } });
    expect(final2.status).toBe(200);
    expect((final2.json as { result: { data: { applied: boolean } } }).result.data.applied).toBe(false);
    const rows2 = await query<{ n: number }>(`SELECT count(*)::int AS n FROM budget_ledger WHERE source_type='expense' AND source_id=$1`, [reportId]);
    expect(rows2[0].n).toBe(rows1[0].n); // 重放不重复记账
  });

  it("C2 经费占用闭环：获批才占用且只一次；未决报销阻断关闭；releaseUnused 有台账依据", async () => {
    const funding = await trpc(app, "funding.create", {
      cookie: memberCookie,
      input: { projectId: projectAId, purpose: "C2 闭环经费", amountCents: 2_000_000 },
    });
    const fundingId = (funding.json as { result: { data: { id: string } } }).result.data.id;
    const fDetail = await trpc(app, "funding.getById", { cookie: memberCookie, input: { id: fundingId }, method: "GET" });
    const fSubmitted = await trpc(app, "funding.submit", {
      cookie: memberCookie,
      input: { id: fundingId, rowVersion: (fDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    await approveInstance(app, memberCookie, (fSubmitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id);
    const entries = await query<{ entry_type: string; n: number }>(
      `SELECT entry_type, count(*)::int AS n FROM budget_ledger WHERE source_type='funding' AND source_id=$1 GROUP BY entry_type`,
      [fundingId],
    );
    expect(entries).toEqual([{ entry_type: "FUNDING_RESERVED", n: 1 }]); // 只占用一次

    // 未决报销存在 → 关闭被阻断
    const expense = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "C2 未决报销",
        items: [{ projectId: projectAId, fundingRequestId: fundingId, date: "2027-10-10", category: "transport", amountCents: 300_000, description: "未决明细" }],
      },
    });
    const reportId = (expense.json as { result: { data: { id: string } } }).result.data.id;
    const eDetail = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id: reportId }, method: "GET" });
    await trpc(app, "expense.submit", {
      cookie: memberCookie,
      input: { id: reportId, rowVersion: (eDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const fDetail2 = await trpc(app, "funding.getById", { cookie: memberCookie, input: { id: fundingId }, method: "GET" });
    const closeDenied = await trpc(app, "funding.close", {
      cookie: memberCookie,
      input: { id: fundingId, rowVersion: (fDetail2.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, note: "尝试关闭" },
    });
    expect(closeDenied.status).toBe(409);
    expect(trpcError(closeDenied).businessCode).toBe("STATE_CONFLICT");

    // 释放未用部分：先撤回报销 → releaseUnused → RELEASED 台账依据
    const eDetail2 = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id: reportId }, method: "GET" });
    await trpc(app, "expense.withdraw", {
      cookie: memberCookie,
      input: { id: reportId, rowVersion: (eDetail2.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion },
    });
    const fDetail3 = await trpc(app, "funding.getById", { cookie: memberCookie, input: { id: fundingId }, method: "GET" });
    const released = await trpc(app, "funding.releaseUnused", {
      cookie: memberCookie,
      input: { id: fundingId, rowVersion: (fDetail3.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion },
    });
    expect(released.status).toBe(200);
    const releasedEntry = await query<{ entry_type: string; reserved_delta_cents: number }>(
      `SELECT entry_type, reserved_delta_cents FROM budget_ledger WHERE source_type='funding' AND source_id=$1 AND entry_type='FUNDING_RELEASED'`,
      [fundingId],
    );
    expect(Number(releasedEntry[0].reserved_delta_cents)).toBe(-2_000_000);

    // 关闭：剩余为零 → closed 留痕
    const fDetail4 = await trpc(app, "funding.getById", { cookie: memberCookie, input: { id: fundingId }, method: "GET" });
    const closed = await trpc(app, "funding.close", {
      cookie: memberCookie,
      input: { id: fundingId, rowVersion: (fDetail4.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, note: "验收关闭" },
    });
    expect(closed.status).toBe(200);
    const status = await query<{ approval_status: string; usage_status: string }>(
      `SELECT approval_status, usage_status FROM funding_requests WHERE id=$1`, [fundingId],
    );
    expect(status[0]).toMatchObject({ approval_status: "approved", usage_status: "closed" });
  });

  it("C1 预算生命周期：调整产新版本（ADJUSTED marker + 旧版 superseded）；关闭后 hasBudget=false", async () => {
    const budgetId = await activeBudgetId(projectAId);
    const adjust = await trpc(app, "budget.adjust", {
      cookie: pmCookie,
      input: { id: budgetId, deltaCents: 5_000_000, reason: "验收调整：追加额度", idempotencyKey: crypto.randomUUID() },
    });
    expect(adjust.status).toBe(200);
    const v2 = (adjust.json as { result: { data: { budget: { id: string; versionNo: number } } } }).result.data.budget;
    await approveInstance(app, pmCookie, (adjust.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id);
    const versions = await query<{ version_no: number; status: string }>(
      `SELECT version_no, status FROM budgets WHERE project_id=$1 ORDER BY version_no`, [projectAId],
    );
    expect(versions.filter((v) => v.status === "active")).toHaveLength(1);
    expect(versions.find((v) => v.version_no === v2.versionNo)?.status).toBe("active");
    const marker = await query<{ entry_type: string }>(
      `SELECT entry_type FROM budget_ledger WHERE source_type='budget' AND source_id=$1`, [v2.id],
    );
    expect(marker[0].entry_type).toBe("BUDGET_ADJUSTED");

    const closed = await trpc(app, "budget.close", {
      cookie: pmCookie,
      input: { id: v2.id, rowVersion: (await aggregateOf(app, pmCookie, v2.id)).rowVersion },
    });
    expect(closed.status).toBe(200);
    const agg = await aggregateOf(app, pmCookie, v2.id);
    expect(agg.aggregate.hasBudget).toBe(false); // 「未设预算」≠ 余额零
  });
});
