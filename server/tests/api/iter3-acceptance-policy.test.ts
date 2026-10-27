import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 3 验收套件·策略与边界（arch/06 §9）：
 * C7b 超预算 block/escalate 双分支、C10 财务权限边界、C11 统计与导出（同名指标同数+权限+审计）。
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

describe("迭代 3 验收·策略与边界（arch/06 §9 C7b/C10/C11）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let financeCookie: string;
  let partnerCookie: string;
  let projectAId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "pm@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "member@lexflow.demo")).cookie;
    financeCookie = (await loginAs(app, "finance@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "partner@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    projectAId = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
      .result.data.items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("C7b 超预算双分支：escalate 追加管理层并放行（可用为负+通知）；block 终审 409 整体回滚", async () => {
    // —— escalate（默认策略）：79M > 可用 78M → 审批链 [pm, finance, partner] ——
    const big = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "验收 escalate 大额",
        items: [{ projectId: projectAId, date: "2027-12-01", category: "translation", amountCents: 79_000_000, description: "大额翻译" }],
      },
    });
    const bigId = (big.json as { result: { data: { id: string } } }).result.data.id;
    const bigDetail = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id: bigId }, method: "GET" });
    const bigSubmitted = await trpc(app, "expense.submit", {
      cookie: memberCookie,
      input: { id: bigId, rowVersion: (bigDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const bigInstance = (bigSubmitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const approval = await trpc(app, "approval.getById", { cookie: pmCookie, input: { id: bigInstance }, method: "GET" });
    const roles = (approval.json as { result: { data: { steps: { approverRole: string | null }[] } } }).result.data.steps
      .map((s) => s.approverRole);
    expect(roles).toEqual(["project_manager", "finance", "partner"]); // 追加管理层
    const checks = (bigSubmitted.json as { result: { data: { checks: { name: string; pass: boolean }[] } } }).result.data.checks;
    expect(checks.some((c) => c.name === "over_budget_escalate")).toBe(true);

    await approveInstance(app, memberCookie, bigInstance);
    const bigAfter = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id: bigId }, method: "GET" });
    expect((bigAfter.json as { result: { data: { status: string } } }).result.data.status).toBe("approved_pending_payment");
    const notices = await trpc(app, "notification.listMine", { cookie: pmCookie, method: "GET" });
    expect(
      (notices.json as { result: { data: { items: { eventType: string }[] } } }).result.data.items
        .some((n) => n.eventType === "budget_exceeded"),
    ).toBe(true);
    const stats = await trpc(app, "expense.stats.byProject", { cookie: financeCookie, method: "GET", input: { projectId: projectAId } });
    expect((stats.json as { result: { data: { availableCents: number } } }).result.data.availableCents).toBeLessThan(0);

    // —— block 策略：终审 BUDGET_EXCEEDED 拒绝，零台账写入 ——
    await query(`UPDATE system_config SET value_json = '{"default": "block", "byProject": {}}' WHERE key = 'budget.insufficient_policy'`);
    try {
      const blocked = await trpc(app, "expense.create", {
        cookie: memberCookie,
        input: {
          reason: "验收 block 大额",
          items: [{ projectId: projectAId, date: "2027-12-02", category: "translation", amountCents: 50_000_000, description: "block 翻译" }],
        },
      });
      const blockedId = (blocked.json as { result: { data: { id: string } } }).result.data.id;
      const blockedDetail = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id: blockedId }, method: "GET" });
      const blockedSubmitted = await trpc(app, "expense.submit", {
        cookie: memberCookie,
        input: { id: blockedId, rowVersion: (blockedDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
      });
      const blockedInstance = (blockedSubmitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
      await trpc(app, "approval.act", { cookie: pmCookie, input: { instanceId: blockedInstance, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() } });
      const blockedFinal = await trpc(app, "approval.act", { cookie: financeCookie, input: { instanceId: blockedInstance, stepSeq: 2, action: "approve", idempotencyKey: crypto.randomUUID() } });
      expect(blockedFinal.status).toBe(409);
      expect(trpcError(blockedFinal).businessCode).toBe("BUDGET_EXCEEDED");
      const blockedAfter = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id: blockedId }, method: "GET" });
      expect((blockedAfter.json as { result: { data: { status: string } } }).result.data.status).toBe("pending_approval");
      const ledgerRows = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM budget_ledger WHERE source_type='expense' AND source_id=$1`, [blockedId],
      );
      expect(ledgerRows[0].n).toBe(0);
    } finally {
      await query(`UPDATE system_config SET value_json = '{"default": "escalate", "byProject": {}}' WHERE key = 'budget.insufficient_policy'`);
    }
  });

  it("C10 财务权限边界：member 不见汇总；finance 可处理费用但读不了项目法律内容", async () => {
    const memberStats = await trpc(app, "expense.stats.byProject", { cookie: memberCookie, method: "GET", input: { projectId: projectAId } });
    expect(memberStats.status).toBe(404);
    expect(trpcError(memberStats).businessCode).toBe("ACCESS_DENIED_OR_GONE");
    const activeBudget = (await query<{ id: string }>(`SELECT id FROM budgets WHERE project_id=$1 AND status='active'`, [projectAId]))[0].id;
    const memberBudget = await trpc(app, "budget.getById", { cookie: memberCookie, method: "GET", input: { id: activeBudget } });
    expect(memberBudget.status).toBe(404);
    const ghost = await trpc(app, "budget.getById", { cookie: memberCookie, method: "GET", input: { id: "00000000-0000-0000-0000-000000000000" } });
    expect(trpcError(memberBudget).businessCode).toBe(trpcError(ghost).businessCode);

    // finance：费用处理职责可见，项目法律内容不可见
    const financeProject = await trpc(app, "project.getById", { cookie: financeCookie, input: { id: projectAId }, method: "GET" });
    expect(financeProject.status).toBe(404);
    const financeOverview = await trpc(app, "project.overview", { cookie: financeCookie, method: "GET", input: { projectId: projectAId } });
    expect(financeOverview.status).toBe(404);
    const anyReport = (await query<{ id: string }>(`SELECT id FROM expense_reports LIMIT 1`))[0].id;
    const financeReport = await trpc(app, "expense.getById", { cookie: financeCookie, input: { id: anyReport }, method: "GET" });
    expect(financeReport.status).toBe(200); // 费用摘要权
  });

  it("C11 统计与导出：同名指标同数（stats==台账重算）；导出内容/权限/审计", async () => {
    const byProject = await trpc(app, "expense.stats.byProject", { cookie: pmCookie, method: "GET", input: { projectId: projectAId } });
    expect(byProject.status).toBe(200);
    const data = (byProject.json as {
      result: { data: { asOf: string; statusScope: string; actualCents: number; executionRate: number | null } };
    }).result.data;
    expect(data.asOf).toBeTruthy();
    expect(data.statusScope).toContain("EXPENSE_RECOGNIZED");
    const recomputed = await query<{ actual: number }>(
      `SELECT coalesce(sum(actual_delta_cents),0)::float8 AS actual FROM budget_ledger WHERE project_id=$1`, [projectAId],
    );
    expect(data.actualCents).toBe(Number(recomputed[0].actual)); // 同名指标同数

    const byCategory = await trpc(app, "expense.stats.byCategory", { cookie: financeCookie, method: "GET", input: { projectId: projectAId } });
    expect((byCategory.json as { result: { data: { items: unknown[] } } }).result.data.items.length).toBeGreaterThan(0);
    const byPerson = await trpc(app, "expense.stats.byPerson", { cookie: financeCookie, method: "GET", input: { projectId: projectAId } });
    expect((byPerson.json as { result: { data: { items: unknown[] } } }).result.data.items.length).toBeGreaterThan(0);

    const exported = await trpc(app, "expense.stats.exportCsv", { cookie: financeCookie, method: "GET", input: { projectId: projectAId } });
    expect(exported.status).toBe(200);
    const csv = (exported.json as { result: { data: { csv: string; rowCount: number } } }).result.data;
    expect(csv.rowCount).toBeGreaterThan(0);
    expect(csv.csv).toContain("报销单");
    const auditRows = await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE action='export.run'`);
    expect(auditRows[0].n).toBeGreaterThanOrEqual(1);
    const memberExport = await trpc(app, "expense.stats.exportCsv", { cookie: memberCookie, method: "GET", input: { projectId: projectAId } });
    expect(memberExport.status).toBe(404);
  });
});
