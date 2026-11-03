import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

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
  app: Awaited<ReturnType<typeof getApp>>,
  cookie: string,
  instanceId: string,
  maxSteps = 5,
): Promise<void> {
  for (let seq = 1; seq <= maxSteps; seq += 1) {
    const detail = await trpc(app, "approval.getById", { cookie, input: { id: instanceId }, method: "GET" });
    const instance = (detail.json as {
      result: { data: { status: string; currentStepSeq: number; steps: { seq: number; approverRole: string | null }[] } };
    }).result.data;
    if (instance.status !== "pending") return;
    const step = instance.steps.find((s) => s.seq === instance.currentStepSeq);
    if (!step) return;
    const approverCookie =
      step.approverRole === "partner"
        ? (await loginAs(app, "liangqifeng@lexflow.demo")).cookie
        : step.approverRole === "finance"
          ? (await loginAs(app, "guojingwen@lexflow.demo")).cookie
          : step.approverRole === "project_manager"
            ? (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie
            : cookie;
    const acted = await trpc(app, "approval.act", {
      cookie: approverCookie,
      input: { instanceId, stepSeq: step.seq, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(acted.status).toBe(200);
  }
}

describe("迭代 3 预算域与台账（C1/C3）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let partnerCookie: string;
  let memberCookie: string;
  let projectCId: string;
  let projectAId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "wangbaozhuo@lexflow.demo")).cookie;
    partnerCookie = (await loginAs(app, "liangqifeng@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "guanchen@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } }).result.data.items;
    projectAId = items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
    // 项目 C 对 pm 不可见，id 走库
    const cRow = await query<{ id: string }>(`SELECT id FROM projects WHERE code = $1`, [`PRJ-${YEAR}-00003`]);
    projectCId = cRow[0].id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("C3 台账口径：五公式与种子基线一致（A=80M/占用2.2M/实际0.8M/可用77M）；幂等键重放不重复记账", async () => {
    const agg = await trpc(app, "budget.getById", {
      cookie: pmCookie,
      method: "GET",
      input: { id: (await query<{ id: string }>(`SELECT id FROM budgets WHERE project_id=$1 AND status='active'`, [projectAId]))[0].id },
    });
    const data = (agg.json as {
      result: {
        data: {
          aggregate: {
            effectiveBudgetCents: number;
            reservedCents: number;
            actualCents: number;
            availableCents: number;
            executionRate: number | null;
            hasBudget: boolean;
          };
        };
      };
    }).result.data.aggregate;
    expect(data).toMatchObject({
      hasBudget: true,
      effectiveBudgetCents: 80_000_000,
      reservedCents: 2_200_000,
      actualCents: 800_000,
      availableCents: 77_000_000,
      executionRate: 0.01,
    });

    // 幂等重放：直接重放 FUNDING_RESERVED 同键 → 返回已存在分录，不双记
    const fundingId = (await query<{ id: string }>(`SELECT id FROM funding_requests WHERE code=$1`, [`FND-${YEAR}-00001`]))[0].id;
    const before = await query<{ n: number; net: number }>(
      `SELECT count(*)::int AS n, coalesce(sum(reserved_delta_cents),0)::float8 AS net FROM budget_ledger WHERE source_type='funding' AND source_id=$1`,
      [fundingId],
    );
    const { recordLedger } = await import("../../src/services/ledger/record");
    const { db } = await import("../../src/db/client");
    await recordLedger(db, {
      projectId: projectAId,
      sourceType: "funding",
      sourceId: fundingId,
      entryType: "FUNDING_RESERVED",
      reservedDeltaCents: 2_000_000,
      seq: 0,
    });
    const after = await query<{ n: number; net: number }>(
      `SELECT count(*)::int AS n, coalesce(sum(reserved_delta_cents),0)::float8 AS net FROM budget_ledger WHERE source_type='funding' AND source_id=$1`,
      [fundingId],
    );
    expect(after[0].n).toBe(before[0].n); // 行数不增（重放返回已存在）
    expect(Number(after[0].net)).toBe(2_000_000); // 净额不变（无双记）
  });

  it("C1 预算生命周期：创建→生效（ACTIVATED marker）→调整新版本（ADJUSTED+旧版 superseded）→关闭", async () => {
    // 项目 C 无预算：overview 预算摘要 hasBudget=false（「未设预算」≠ 余额零）
    // （C=佳力奇由 sunhaoxiang 负责；partner 非成员不可见——用项目负责人身份取证）
    const sunCookie = (await loginAs(app, "sunhaoxiang@lexflow.demo")).cookie;
    const overviewBefore = await trpc(app, "project.overview", {
      cookie: sunCookie,
      method: "GET",
      input: { projectId: projectCId },
    });
    expect((overviewBefore.json as { result: { data: { budgetSummary: { hasBudget: boolean } | null } } }).result.data.budgetSummary).toMatchObject({ hasBudget: false });

    // 新建预算（项目 A，pm 创建 → partner 审批；种子恰一 partner，申请人即审批人会自审拦截）
    const created = await trpc(app, "budget.create", {
      cookie: pmCookie,
      input: {
        projectId: projectAId,
        periodStart: "2027-01-01",
        periodEnd: "2027-12-31",
        totalCents: 50_000_000,
        description: "A 项目 V2 预算（C1 探测）",
        categories: [{ category: "transport", amountCents: 10_000_000 }],
      },
    });
    expect(created.status).toBe(200);
    const budgetId = (created.json as { result: { data: { id: string; code: string } } }).result.data.id;

    // 成员不可见财务摘要
    const denied = await trpc(app, "budget.getById", { cookie: memberCookie, input: { id: budgetId }, method: "GET" });
    expect(denied.status).toBe(404);

    const detail = await trpc(app, "budget.getById", { cookie: pmCookie, input: { id: budgetId }, method: "GET" });
    const rowVersion = (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const submitted = await trpc(app, "budget.submit", {
      cookie: pmCookie,
      input: { id: budgetId, rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    expect(submitted.status).toBe(200);
    const instanceId = (submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    await approveInstance(app, partnerCookie, instanceId);

    const active = await trpc(app, "budget.getById", { cookie: pmCookie, input: { id: budgetId }, method: "GET" });
    const activeData = (active.json as { result: { data: { status: string; aggregate: { hasBudget: boolean; effectiveBudgetCents: number } } } }).result.data;
    expect(activeData.status).toBe("active");
    expect(activeData.aggregate).toMatchObject({ hasBudget: true, effectiveBudgetCents: 50_000_000 });
    const marker = await query<{ entry_type: string; reserved_delta_cents: number; actual_delta_cents: number }>(
      `SELECT entry_type, reserved_delta_cents, actual_delta_cents FROM budget_ledger WHERE source_type='budget' AND source_id=$1`,
      [budgetId],
    );
    expect(marker[0].entry_type).toBe("BUDGET_ACTIVATED");
    expect(Number(marker[0].reserved_delta_cents)).toBe(0);
    expect(Number(marker[0].actual_delta_cents)).toBe(0);

    // 调整：+5M 产新版本（pm 发起，partner 审批）
    const adjusted = await trpc(app, "budget.adjust", {
      cookie: pmCookie,
      input: { id: budgetId, deltaCents: 5_000_000, reason: "追加鉴定费额度", idempotencyKey: crypto.randomUUID() },
    });
    expect(adjusted.status).toBe(200);
    const v2 = (adjusted.json as { result: { data: { budget: { id: string; versionNo: number; totalCents: number } } } }).result.data.budget;
    expect(v2.versionNo).toBe(3); // A 已有种子 V1 + 本次 V2，调整产 V3
    expect(v2.totalCents).toBe(55_000_000);
    const v2Instance = (adjusted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    await approveInstance(app, partnerCookie, v2Instance);

    const versions = await query<{ version_no: number; status: string; total_cents: number }>(
      `SELECT version_no, status, total_cents FROM budgets WHERE project_id = $1 ORDER BY version_no`,
      [projectAId],
    );
    expect(versions.map((v) => ({ ...v, total_cents: Number(v.total_cents) }))).toEqual([
      { version_no: 1, status: "superseded", total_cents: 80_000_000 },
      { version_no: 2, status: "superseded", total_cents: 50_000_000 },
      { version_no: 3, status: "active", total_cents: 55_000_000 },
    ]);
    const adjustMarker = await query<{ entry_type: string }>(
      `SELECT entry_type FROM budget_ledger WHERE source_type='budget' AND source_id=$1`,
      [v2.id],
    );
    expect(adjustMarker[0].entry_type).toBe("BUDGET_ADJUSTED");

    // 调整后聚合=55M
    const aggAfter = await trpc(app, "budget.getById", { cookie: pmCookie, input: { id: v2.id }, method: "GET" });
    expect((aggAfter.json as { result: { data: { aggregate: { effectiveBudgetCents: number } } } }).result.data.aggregate.effectiveBudgetCents).toBe(55_000_000);

    // 关闭 → hasBudget=false（「未设预算」≠ 余额零）
    const closeRv = (aggAfter.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const closed = await trpc(app, "budget.close", {
      cookie: pmCookie,
      input: { id: v2.id, rowVersion: closeRv },
    });
    expect(closed.status).toBe(200);
    const ledger = await trpc(app, "budget.ledger", {
      cookie: pmCookie,
      method: "GET",
      input: { projectId: projectAId },
    });
    expect((ledger.json as { result: { data: { items: unknown[] } } }).result.data.items.length).toBeGreaterThanOrEqual(2);
  });

  it("C2 经费占用闭环：获批才占用且只一次；关闭未用部分有台账依据（releaseUnused）", async () => {
    const created = await trpc(app, "funding.create", {
      cookie: memberCookie,
      input: { projectId: projectAId, purpose: "C2 占用闭环探测", amountCents: 3_000_000 },
    });
    const fundingId = (created.json as { result: { data: { id: string } } }).result.data.id;
    const detail = await trpc(app, "funding.getById", { cookie: memberCookie, input: { id: fundingId }, method: "GET" });
    expect((detail.json as { result: { data: { figures: { approvedCents: number } } } }).result.data.figures.approvedCents).toBe(0);

    const rv = (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const submitted = await trpc(app, "funding.submit", {
      cookie: memberCookie,
      input: { id: fundingId, rowVersion: rv, idempotencyKey: crypto.randomUUID() },
    });
    const instanceId = (submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    await approveInstance(app, pmCookie, instanceId);

    const after = await trpc(app, "funding.getById", { cookie: memberCookie, input: { id: fundingId }, method: "GET" });
    const figures = (after.json as {
      result: { data: { approvalStatus: string; usageStatus: string; figures: { approvedCents: number; remainingCents: number; releasedCents: number } } };
    }).result.data;
    expect(figures.approvalStatus).toBe("approved");
    expect(figures.usageStatus).toBe("unused"); // 审批态与使用态分离
    expect(figures.figures).toMatchObject({ approvedCents: 3_000_000, remainingCents: 3_000_000, releasedCents: 0 });

    const reserved = await query<{ n: number; net: number }>(
      `SELECT count(*)::int AS n, coalesce(sum(reserved_delta_cents),0)::float8 AS net FROM budget_ledger WHERE source_type='funding' AND source_id=$1`,
      [fundingId],
    );
    expect(reserved[0].n).toBe(1); // 只占用一次
    expect(Number(reserved[0].net)).toBe(3_000_000);

    // 释放未用 → written_off + 台账 RELEASED
    const rv2 = (after.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const released = await trpc(app, "funding.releaseUnused", {
      cookie: memberCookie,
      input: { id: fundingId, rowVersion: rv2 },
    });
    expect(released.status).toBe(200);
    const releasedData = (released.json as { result: { data: { usageStatus: string } } }).result.data;
    expect(releasedData.usageStatus).toBe("written_off");
    const releasedLedger = await query<{ entry_type: string; reserved_delta_cents: number }>(
      `SELECT entry_type, reserved_delta_cents FROM budget_ledger WHERE source_type='funding' AND source_id=$1 AND entry_type='FUNDING_RELEASED'`,
      [fundingId],
    );
    expect(Number(releasedLedger[0].reserved_delta_cents)).toBe(-3_000_000);
    // 已释放后项目净占用恢复（种子净占用 2.2M = FND-00001 的 2M + FND-00003 净 0.2M；C1 已关闭 A 预算，直接读台账净额）
    const reservedAfter = await query<{ net: number }>(
      `SELECT coalesce(sum(reserved_delta_cents),0)::float8 AS net FROM budget_ledger WHERE project_id=$1`,
      [projectAId],
    );
    expect(Number(reservedAfter[0].net)).toBe(2_200_000);
  });
});
