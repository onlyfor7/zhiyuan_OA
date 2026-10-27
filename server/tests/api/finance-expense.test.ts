import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { registerHandler } from "../../src/services/approval/engine";
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
  maxSteps = 6,
): Promise<void> {
  for (let guard = 0; guard < maxSteps; guard += 1) {
    const detail = await trpc(app, "approval.getById", { cookie, input: { id: instanceId }, method: "GET" });
    const instance = (detail.json as {
      result: {
        data: {
          status: string;
          currentStepSeq: number;
          steps: { seq: number; approverRole: string | null }[];
        };
      };
    }).result.data;
    if (instance.status !== "pending") return;
    const step = instance.steps.find((s) => s.seq === instance.currentStepSeq);
    if (!step) return;
    const approverCookie =
      step.approverRole === "partner"
        ? (await loginAs(app, "partner@lexflow.demo")).cookie
        : step.approverRole === "finance"
          ? (await loginAs(app, "finance@lexflow.demo")).cookie
          : step.approverRole === "project_manager"
            ? (await loginAs(app, "pm@lexflow.demo")).cookie
            : cookie;
    const acted = await trpc(app, "approval.act", {
      cookie: approverCookie,
      input: { instanceId, stepSeq: step.seq, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(acted.status).toBe(200);
  }
}

async function submitAndApproveExpense(
  app: Awaited<ReturnType<typeof getApp>>,
  cookie: string,
  reportId: string,
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
  const after = await trpc(app, "expense.getById", { cookie, input: { id: reportId }, method: "GET" });
  expect((after.json as { result: { data: { status: string } } }).result.data.status).toBe("approved_pending_payment");
}

async function uploadReceipt(
  app: Awaited<ReturnType<typeof getApp>>,
  cookie: string,
  bytes: Uint8Array,
): Promise<string> {
  const list = await trpc(app, "project.list", { cookie, method: "GET" });
  const projectA = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
    .result.data.items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
  const form = new FormData();
  form.append("sourceType", "expense");
  form.append("sourceId", projectA);
  form.append("file", new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" }), "票据.pdf");
  const response = await app.request("http://test/files/upload", {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { fileVersionId: string }).fileVersionId;
}

describe("迭代 3 费用域（C4–C11 红线全覆盖）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let pmCookie: string;
  let memberCookie: string;
  let financeCookie: string;
  let projectAId: string;
  let projectBId: string;
  let fundingId: string; // FND-00001 approved 2M

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    pmCookie = (await loginAs(app, "pm@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "member@lexflow.demo")).cookie;
    financeCookie = (await loginAs(app, "finance@lexflow.demo")).cookie;
    const list = await trpc(app, "project.list", { cookie: pmCookie, method: "GET" });
    const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } }).result.data.items;
    projectAId = items.find((p) => p.code === `PRJ-${YEAR}-00001`)!.id;
    projectBId = items.find((p) => p.code === `PRJ-${YEAR}-00002`)!.id;
    fundingId = (await query<{ id: string }>(`SELECT id FROM funding_requests WHERE code=$1`, [`FND-${YEAR}-00001`]))[0].id;
  });

  afterAll(async () => {
    await closeDb();
  });

  it("C4 创建：合计服务端计算（前端传错被忽略）；跨项目明细逐行鉴权", async () => {
    const created = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "C4 合计服务端计算",
        totalCents: 999_999_999, // 前端传入合计：服务端必须忽略（zod strip + 服务端求和）
        items: [
          { projectId: projectAId, date: "2027-08-01", category: "transport", amountCents: 300_000, description: "高铁票" },
          { projectId: projectAId, date: "2027-08-01", category: "meals", amountCents: 200_000, description: "工作餐" },
        ],
      },
    });
    expect(created.status).toBe(200);
    expect((created.json as { result: { data: { totalCents: number } } }).result.data.totalCents).toBe(500_000);

    // 跨项目：member 不是项目 B 成员 → 逐行鉴权 404
    const crossDenied = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "越权跨项目",
        items: [{ projectId: projectAId, date: "2027-08-02", category: "transport", amountCents: 100_000, description: "A 明细" }],
      },
    });
    expect(crossDenied.status).toBe(200); // 先建 A 单
    const bad = await trpc(app, "expense.update", {
      cookie: memberCookie,
      input: {
        id: (crossDenied.json as { result: { data: { id: string } } }).result.data.id,
        rowVersion: 0,
        items: [
          { projectId: projectAId, date: "2027-08-02", category: "transport", amountCents: 100_000, description: "A 明细" },
          { projectId: projectBId, date: "2027-08-02", category: "transport", amountCents: 100_000, description: "B 明细越权" },
        ],
      },
    });
    expect(bad.status).toBe(404);
  });

  it("C5 重复票据三因子命中矩阵 + 原报销定位", async () => {
    const receiptV1 = await uploadReceipt(app, pmCookie, new Uint8Array([0x51, 0x52, 0x53, 0x41]));
    const receiptV2SameContent = await uploadReceipt(app, pmCookie, new Uint8Array([0x51, 0x52, 0x53, 0x41])); // 同内容不同版本
    const receiptOther = await uploadReceipt(app, pmCookie, new Uint8Array([0x59, 0x59, 0x59, 0x59]));

    // R1 基准：号 INV-C5-1 金额 100000 带 receiptV1 → 审批通过
    const r1 = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "票据基准单",
        items: [
          { projectId: projectAId, date: "2027-08-10", category: "materials", amountCents: 100_000, description: "资料费", receiptNo: "INV-C5-1", receiptFileVersionId: receiptV1 },
        ],
      },
    });
    const r1Data = (r1.json as { result: { data: { id: string; code: string } } }).result.data;
    const r1Id = r1Data.id;
    const r1Code = r1Data.code;
    await submitAndApproveExpense(app, memberCookie, r1Id);

    const trySubmit = async (input: Record<string, unknown>) => {
      const created = await trpc(app, "expense.create", {
        cookie: memberCookie,
        input: { reason: "票据矩阵探测", items: [input] },
      });
      expect(created.status).toBe(200);
      const id = (created.json as { result: { data: { id: string } } }).result.data.id;
      const detail = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id }, method: "GET" });
      const rv = (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
      return trpc(app, "expense.submit", { cookie: memberCookie, input: { id, rowVersion: rv, idempotencyKey: crypto.randomUUID() } });
    };

    // ① 三因子全同（同号+同额+同 sha）→ 命中
    const hit1 = await trySubmit({ projectId: projectAId, date: "2027-08-11", category: "materials", amountCents: 100_000, description: "命中1", receiptNo: "INV-C5-1", receiptFileVersionId: receiptV1 });
    expect(hit1.status).toBe(409);
    expect(trpcError(hit1).businessCode).toBe("DUPLICATE_RECEIPT");
    const details = (hit1.json as { error: { data: { details?: { originalReportCode?: string } } } }).error.data.details;
    expect(details?.originalReportCode).toBe(r1Code);
    expect((hit1.json as { error: { data: { details?: { originalReportId?: string } } } }).error.data.details?.originalReportId).toBe(r1Id);

    // ③ 同号+同额+不同版本同 sha → 命中
    const hit3 = await trySubmit({ projectId: projectAId, date: "2027-08-11", category: "materials", amountCents: 100_000, description: "命中3", receiptNo: "INV-C5-1", receiptFileVersionId: receiptV2SameContent });
    expect(hit3.status).toBe(409);
    expect(trpcError(hit3).businessCode).toBe("DUPLICATE_RECEIPT");

    // R4 基准（无票据文件）→ 审批通过
    const r4 = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "无票基准单",
        items: [{ projectId: projectAId, date: "2027-08-12", category: "materials", amountCents: 80_000, description: "办公耗材", receiptNo: "INV-C5-2" }],
      },
    });
    await submitAndApproveExpense(app, memberCookie, (r4.json as { result: { data: { id: string } } }).result.data.id);

    // ② 同号+同额+均无文件（sha 双双 null）→ 命中
    const hit2 = await trySubmit({ projectId: projectAId, date: "2027-08-13", category: "materials", amountCents: 80_000, description: "命中2", receiptNo: "INV-C5-2" });
    expect(hit2.status).toBe(409);
    expect(trpcError(hit2).businessCode).toBe("DUPLICATE_RECEIPT");

    // ④ 同号+同额+不同 sha（双方有文件）→ 主因子命中（arch R1：票据号+金额即拦）
    const hit4 = await trySubmit({ projectId: projectAId, date: "2027-08-14", category: "materials", amountCents: 100_000, description: "命中4-异sha", receiptNo: "INV-C5-1", receiptFileVersionId: receiptOther });
    expect(hit4.status).toBe(409);
    expect(trpcError(hit4).businessCode).toBe("DUPLICATE_RECEIPT");

    // ⑤ R1 补：原票有文件、新票无文件，同号同额 → 必拦（旧严格相等规则会漏）
    const hit5 = await trySubmit({ projectId: projectAId, date: "2027-08-15", category: "materials", amountCents: 100_000, description: "命中5-混合文件", receiptNo: "INV-C5-1" });
    expect(hit5.status).toBe(409);
    expect(trpcError(hit5).businessCode).toBe("DUPLICATE_RECEIPT");

    // ⑦ 辅因子：票据号不同 + 同 sha 同额 → 命中（同文件内容即拦）
    const hit7 = await trySubmit({ projectId: projectAId, date: "2027-08-16", category: "materials", amountCents: 100_000, description: "命中7-辅因子", receiptNo: "INV-C5-OTHER", receiptFileVersionId: receiptV2SameContent });
    expect(hit7.status).toBe(409);
    expect(trpcError(hit7).businessCode).toBe("DUPLICATE_RECEIPT");

    // ⑧ 同号+不同额 → 不命中（放行）
    const missAmount = await trySubmit({ projectId: projectAId, date: "2027-08-17", category: "materials", amountCents: 100_001, description: "miss-amount", receiptNo: "INV-C5-1", receiptFileVersionId: receiptV1 });
    expect(missAmount.status).toBe(200);
  });

  it("C6 审批检查项随快照保存（预算/经费/票据/关联/重复五基线）", async () => {
    // 设置票据规则：transport 必填票据
    await query(
      `UPDATE system_config SET value_json = jsonb_set(value_json, '{byCategory,transport}', '{"required": true}') WHERE key = 'expense.receipt_rules'`,
    );
    const created = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "检查项探测",
        items: [
          { projectId: projectAId, fundingRequestId: fundingId, date: "2027-08-20", category: "transport", amountCents: 50_000, description: "缺票据的transport" },
        ],
      },
    });
    const id = (created.json as { result: { data: { id: string } } }).result.data.id;
    const detail = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id }, method: "GET" });
    const rv = (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const submitted = await trpc(app, "expense.submit", {
      cookie: memberCookie,
      input: { id, rowVersion: rv, idempotencyKey: crypto.randomUUID() },
    });
    expect(submitted.status).toBe(200);
    const checks = (submitted.json as { result: { data: { checks: { name: string; pass: boolean }[] } } }).result.data.checks;
    expect(checks.map((c) => c.name)).toEqual([
      "budget_sufficiency",
      "funding_sufficiency",
      "receipt_completeness",
      "link_validity",
      "duplicate_receipt",
    ]);
    expect(checks.find((c) => c.name === "receipt_completeness")?.pass).toBe(false);
    expect(checks.find((c) => c.name === "budget_sufficiency")?.pass).toBe(true);
    // 快照随审批实例保存
    const instanceId = (submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const approval = await trpc(app, "approval.getById", { cookie: pmCookie, input: { id: instanceId }, method: "GET" });
    const snapshot = (approval.json as { result: { data: { formSnapshot: { checks?: unknown[] } } } }).result.data.formSnapshot;
    expect(Array.isArray(snapshot.checks)).toBe(true);
    // 恢复规则默认
    await query(`UPDATE system_config SET value_json = '{"byCategory": {}, "duplicateReceipt": "block"}' WHERE key = 'expense.receipt_rules'`);
    // 撤回草稿，避免影响后续
    const after = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id }, method: "GET" });
    await trpc(app, "expense.withdraw", {
      cookie: memberCookie,
      input: { id, rowVersion: (after.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion },
    });
  });

  it("C7 核销同事务：释放占用+确认实际一次成账；超额进实际；无双扣；故障注入回滚零部分写入", async () => {
    // 新建经费 3M（获批后占用），报销关联它：明细 2.5M 关联 + 0.4M 不关联 → 释放封顶 3M？不，占用 3M：释放 2.5M，超占用无；再测超额：用种子 FND-00001 剩余 2M 报 2.4M
    const before = await query<{ reserved: number; actual: number }>(
      `SELECT coalesce(sum(reserved_delta_cents),0)::float8 AS reserved, coalesce(sum(actual_delta_cents),0)::float8 AS actual FROM budget_ledger WHERE project_id=$1`,
      [projectAId],
    );
    const created = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "核销闭环探测",
        items: [
          { projectId: projectAId, fundingRequestId: fundingId, date: "2027-09-01", category: "transport", amountCents: 1_500_000, description: "核销明细1" },
          { projectId: projectAId, fundingRequestId: fundingId, date: "2027-09-01", category: "accommodation", amountCents: 900_000, description: "核销明细2" },
          { projectId: projectAId, date: "2027-09-02", category: "meals", amountCents: 400_000, description: "无经费明细" },
        ],
      },
    });
    const reportId = (created.json as { result: { data: { id: string } } }).result.data.id;
    expect((created.json as { result: { data: { totalCents: number } } }).result.data.totalCents).toBe(2_800_000);

    const detail = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id: reportId }, method: "GET" });
    const rv = (detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion;
    const submitted = await trpc(app, "expense.submit", {
      cookie: memberCookie,
      input: { id: reportId, rowVersion: rv, idempotencyKey: crypto.randomUUID() },
    });
    const instanceId = (submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;

    // —— 故障注入：expense handler 抛错 → 整事务回滚，零部分写入 ——
    const unregister = registerHandler("expense", {
      async onApproved(): Promise<void> {
        throw new Error("人为制造：核销失败（回滚探测）");
      },
      async onRejected(): Promise<void> {
        /* noop */
      },
      async onWithdrawn(): Promise<void> {
        /* noop */
      },
    });
    let okInstance = "";
    try {
      const failed = await trpc(app, "approval.act", {
        cookie: pmCookie,
        input: { instanceId, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
      });
      expect(failed.status).toBe(200); // 第一步 pm 通过（未至终审）
      const failed2 = await trpc(app, "approval.act", {
        cookie: financeCookie,
        input: { instanceId, stepSeq: 2, action: "approve", idempotencyKey: crypto.randomUUID() },
      });
      expect(failed2.status).toBe(500); // 终审 handler 失败
      okInstance = instanceId;
    } finally {
      unregister();
    }
    // 回滚断言：无 RECOGNIZED/RELEASED、报销仍 pending、占用净额不变
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
    expect(Number(fundingNet[0].net)).toBe(2_000_000); // 释放未发生（无双扣、无部分写入）

    // —— 修复后重放终审：成功 ——
    const replay = await trpc(app, "approval.act", {
      cookie: financeCookie,
      input: { instanceId: okInstance, stepSeq: 2, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(replay.status).toBe(200);

    // 成账断言（delta 口径）
    const after = await query<{ reserved: number; actual: number }>(
      `SELECT coalesce(sum(reserved_delta_cents),0)::float8 AS reserved, coalesce(sum(actual_delta_cents),0)::float8 AS actual FROM budget_ledger WHERE project_id=$1`,
      [projectAId],
    );
    expect(Number(after[0].reserved) - Number(before[0].reserved)).toBe(-2_000_000); // FND-00001 全额释放
    expect(Number(after[0].actual) - Number(before[0].actual)).toBe(2_800_000); // 三明细全部进实际（超额部分 800k 也进实际）
    const fundingEntries = await query<{ entry_type: string; reserved_delta_cents: number }>(
      `SELECT entry_type, reserved_delta_cents FROM budget_ledger WHERE source_type='funding' AND source_id=$1 ORDER BY created_at`,
      [fundingId],
    );
    const releasedSum = fundingEntries
      .filter((e) => e.entry_type === "FUNDING_RELEASED")
      .reduce((sum, e) => sum + Number(e.reserved_delta_cents), 0);
    expect(releasedSum).toBe(-2_000_000); // 释放不超额（≤占用）
    // 双扣检测：释放额与实际额不重复扣同一金额——实际 = 2.8M 只计一次；占用释放 2M 与实际 2.8M 分属两列
    const recognizedForReport = await query<{ n: number; total: number }>(
      `SELECT count(*)::int AS n, coalesce(sum(actual_delta_cents),0)::float8 AS total FROM budget_ledger WHERE source_type='expense' AND source_id=$1`,
      [reportId],
    );
    expect(Number(recognizedForReport[0].total)).toBe(2_800_000);
    expect(Number(recognizedForReport[0].n)).toBe(3);

    // R2：全额核销 → 使用态 written_off（arch/06 §3 迁移）
    const fundingAfter = await trpc(app, "funding.getById", { cookie: memberCookie, input: { id: fundingId }, method: "GET" });
    expect((fundingAfter.json as { result: { data: { usageStatus: string } } }).result.data.usageStatus).toBe("written_off");

    // R2 部分核销 → partially_used
    const f2 = await trpc(app, "funding.create", {
      cookie: memberCookie,
      input: { projectId: projectAId, purpose: "R2 部分核销", amountCents: 3_000_000 },
    });
    const f2Id = (f2.json as { result: { data: { id: string } } }).result.data.id;
    const f2Detail = await trpc(app, "funding.getById", { cookie: memberCookie, input: { id: f2Id }, method: "GET" });
    const f2Submitted = await trpc(app, "funding.submit", {
      cookie: memberCookie,
      input: { id: f2Id, rowVersion: (f2Detail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    await approveInstance(app, memberCookie, (f2Submitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id);
    const expPartial = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "R2 部分核销报销",
        items: [{ projectId: projectAId, fundingRequestId: f2Id, date: "2027-09-05", category: "materials", amountCents: 1_000_000, description: "部分核销明细" }],
      },
    });
    await submitAndApproveExpense(app, memberCookie, (expPartial.json as { result: { data: { id: string } } }).result.data.id);
    const f2After = await trpc(app, "funding.getById", { cookie: memberCookie, input: { id: f2Id }, method: "GET" });
    expect((f2After.json as { result: { data: { usageStatus: string } } }).result.data.usageStatus).toBe("partially_used");
    expect((f2After.json as { result: { data: { figures: { remainingCents: number } } } }).result.data.figures.remainingCents).toBe(2_000_000);

    // C8 前半：支付登记（finance）+ 幂等 + paid 后不可编辑
    const paid = await trpc(app, "expense.markPaid", {
      cookie: financeCookie,
      input: { id: reportId, paymentRef: "PAY-2027-0001", idempotencyKey: crypto.randomUUID() },
    });
    expect(paid.status).toBe(200);
    expect((paid.json as { result: { data: { report: { status: string; paidAt: string | null } } } }).result.data.report).toMatchObject({ status: "paid" });
    expect((paid.json as { result: { data: { report: { paidAt: string | null } } } }).result.data.report.paidAt).toBeTruthy();
    const paidReplay = await trpc(app, "expense.markPaid", {
      cookie: financeCookie,
      input: { id: reportId, paymentRef: "PAY-2027-0001", idempotencyKey: crypto.randomUUID() },
    });
    expect(paidReplay.status).toBe(200);
    expect((paidReplay.json as { result: { data: { replayed: boolean } } }).result.data.replayed).toBe(true);
    // 非 finance 被拒 + paid 不可编辑
    const denied = await trpc(app, "expense.markPaid", {
      cookie: memberCookie,
      input: { id: reportId, paymentRef: "X", idempotencyKey: crypto.randomUUID() },
    });
    expect(denied.status).toBe(404);
    const editPaid = await trpc(app, "expense.update", {
      cookie: memberCookie,
      input: { id: reportId, rowVersion: 99, reason: "篡改已支付" },
    });
    expect(editPaid.status).toBe(409);
  });

  it("C7b 超预算双分支：escalate 审批链追加管理层并放行；block 核销实检拒绝并整体回滚", async () => {
    // escalate 分支（默认策略）：大额 79M（可用 78M）→ 提交追加 partner 步骤
    const big = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "超预算 escalate 探测",
        items: [{ projectId: projectAId, date: "2027-09-10", category: "translation", amountCents: 79_000_000, description: "大额翻译费" }],
      },
    });
    const bigId = (big.json as { result: { data: { id: string } } }).result.data.id;
    const bigDetail = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id: bigId }, method: "GET" });
    const bigSubmitted = await trpc(app, "expense.submit", {
      cookie: memberCookie,
      input: { id: bigId, rowVersion: (bigDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    expect(bigSubmitted.status).toBe(200);
    const bigInstance = (bigSubmitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    const approval = await trpc(app, "approval.getById", { cookie: pmCookie, input: { id: bigInstance }, method: "GET" });
    const steps = (approval.json as { result: { data: { steps: { seq: number; approverRole: string | null }[] } } }).result.data.steps;
    expect(steps.map((s) => s.approverRole)).toEqual(["project_manager", "finance", "partner"]); // 追加管理层
    const bigChecks = (bigSubmitted.json as { result: { data: { checks: { name: string; pass: boolean }[] } } }).result.data.checks;
    expect(bigChecks.some((c) => c.name === "over_budget_escalate")).toBe(true);

    await approveInstance(app, memberCookie, bigInstance);
    const bigAfter = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id: bigId }, method: "GET" });
    expect((bigAfter.json as { result: { data: { status: string } } }).result.data.status).toBe("approved_pending_payment");
    const notices = await trpc(app, "notification.listMine", { cookie: pmCookie, method: "GET" });
    expect(
      ((notices.json as { result: { data: { items: { eventType: string }[] } } }).result.data.items)
        .some((n) => n.eventType === "budget_exceeded"),
    ).toBe(true);
    const financeAgg = await trpc(app, "expense.stats.byProject", { cookie: financeCookie, method: "GET", input: { projectId: projectAId } });
    expect((financeAgg.json as { result: { data: { availableCents: number } } }).result.data.availableCents).toBeLessThan(0); // 超额进入实际后为负

    // block 分支：策略切换 → 新大额报销终审被拒（BUDGET_EXCEEDED），整体回滚
    await query(`UPDATE system_config SET value_json = '{"default": "block", "byProject": {}}' WHERE key = 'budget.insufficient_policy'`);
    const blocked = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "超预算 block 探测",
        items: [{ projectId: projectAId, date: "2027-09-11", category: "translation", amountCents: 50_000_000, description: "block 大额" }],
      },
    });
    const blockedId = (blocked.json as { result: { data: { id: string } } }).result.data.id;
    const blockedDetail = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id: blockedId }, method: "GET" });
    const blockedSubmitted = await trpc(app, "expense.submit", {
      cookie: memberCookie,
      input: { id: blockedId, rowVersion: (blockedDetail.json as { result: { data: { rowVersion: number } } }).result.data.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    const blockedInstance = (blockedSubmitted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    await trpc(app, "approval.act", {
      cookie: pmCookie,
      input: { instanceId: blockedInstance, stepSeq: 1, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    const blockedFinal = await trpc(app, "approval.act", {
      cookie: financeCookie,
      input: { instanceId: blockedInstance, stepSeq: 2, action: "approve", idempotencyKey: crypto.randomUUID() },
    });
    expect(blockedFinal.status).toBe(409);
    expect(trpcError(blockedFinal).businessCode).toBe("BUDGET_EXCEEDED");
    const blockedAfter = await trpc(app, "expense.getById", { cookie: memberCookie, input: { id: blockedId }, method: "GET" });
    expect((blockedAfter.json as { result: { data: { status: string } } }).result.data.status).toBe("pending_approval"); // 回滚
    const blockedLedger = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM budget_ledger WHERE source_type='expense' AND source_id=$1`,
      [blockedId],
    );
    expect(blockedLedger[0].n).toBe(0); // 零部分写入
    await query(`UPDATE system_config SET value_json = '{"default": "escalate", "byProject": {}}' WHERE key = 'budget.insufficient_policy'`);
  });

  it("C9 调整/冲销：paid 更正唯一通道；审批通过写 EXPENSE_ADJUSTED 净额可追溯", async () => {
    // 用 C7 已支付报销（2.8M 实际）：未支付单发起调整 → 409
    const notPaid = await trpc(app, "expense.create", {
      cookie: memberCookie,
      input: {
        reason: "未支付调整探测",
        items: [{ projectId: projectAId, date: "2027-09-15", category: "meals", amountCents: 10_000, description: "小额餐费" }],
      },
    });
    const notPaidId = (notPaid.json as { result: { data: { id: string } } }).result.data.id;
    const earlyAdjust = await trpc(app, "expense.adjustCreate", {
      cookie: financeCookie,
      input: { expenseId: notPaidId, deltaCents: -5_000, reason: "过早", idempotencyKey: crypto.randomUUID() },
    });
    expect(earlyAdjust.status).toBe(409);

    // C7 的 paid 单：找它
    const paidReport = await query<{ id: string; total_cents: number }>(
      `SELECT id, total_cents FROM expense_reports WHERE status='paid' ORDER BY paid_at DESC LIMIT 1`,
    );
    const targetId = paidReport[0].id;
    const before = await query<{ actual: number }>(
      `SELECT coalesce(sum(actual_delta_cents),0)::float8 AS actual FROM budget_ledger WHERE project_id=$1`,
      [projectAId],
    );
    // R3 修复后：finance 发起调整全链通过（策略单步 partner 终审，发起不限角色）
    const adjusted = await trpc(app, "expense.adjustCreate", {
      cookie: financeCookie,
      input: { expenseId: targetId, deltaCents: -100_000, reason: "冲销重复报销部分", idempotencyKey: crypto.randomUUID() },
    });
    expect(adjusted.status).toBe(200);
    const adjustmentId = (adjusted.json as { result: { data: { adjustment: { id: string } } } }).result.data.adjustment.id;
    const instanceId = (adjusted.json as { result: { data: { instance: { id: string } } } }).result.data.instance.id;
    // 断言审批链为单步 partner（R3 种子修复在位）
    const approvalDetail = await trpc(app, "approval.getById", { cookie: financeCookie, input: { id: instanceId }, method: "GET" });
    const chainSteps = (approvalDetail.json as { result: { data: { steps: { approverRole: string | null }[] } } }).result.data.steps;
    expect(chainSteps.map((s) => s.approverRole)).toEqual(["partner"]);
    await approveInstance(app, financeCookie, instanceId); // partner 单步终审

    const after = await query<{ actual: number }>(
      `SELECT coalesce(sum(actual_delta_cents),0)::float8 AS actual FROM budget_ledger WHERE project_id=$1`,
      [projectAId],
    );
    expect(Number(after[0].actual) - Number(before[0].actual)).toBe(-100_000); // 净额调整
    const adjustmentLedger = await query<{ entry_type: string; actual_delta_cents: number; idempotency_key: string }>(
      `SELECT entry_type, actual_delta_cents, idempotency_key FROM budget_ledger WHERE source_type='expense_adjustment' AND source_id=$1`,
      [adjustmentId],
    );
    expect(adjustmentLedger[0].entry_type).toBe("EXPENSE_ADJUSTED");
    expect(Number(adjustmentLedger[0].actual_delta_cents)).toBe(-100_000);
    expect(adjustmentLedger[0].idempotency_key).toBe(`EXPENSE_ADJUSTED:${adjustmentId}:0`);
    const adjRow = await query<{ status: string }>(`SELECT status FROM expense_adjustments WHERE id=$1`, [adjustmentId]);
    expect(adjRow[0].status).toBe("approved");
    // 原记录不可变（paid 保持，历史净额可溯）
    const original = await trpc(app, "expense.getById", { cookie: financeCookie, input: { id: targetId }, method: "GET" });
    expect((original.json as { result: { data: { status: string } } }).result.data.status).toBe("paid");
  });

  it("C10 财务权限边界：member 不见汇总；finance 读不了法律内容", async () => {
    const memberStats = await trpc(app, "expense.stats.byProject", { cookie: memberCookie, method: "GET", input: { projectId: projectAId } });
    expect(memberStats.status).toBe(404);
    const memberBudget = await trpc(app, "budget.getById", {
      cookie: memberCookie,
      method: "GET",
      input: { id: (await query<{ id: string }>(`SELECT id FROM budgets WHERE project_id=$1 AND status='active'`, [projectAId]))[0].id },
    });
    expect(memberBudget.status).toBe(404);

    // finance 可处理费用（markPaid 已验），但项目法律内容不可见
    const financeProject = await trpc(app, "project.getById", { cookie: financeCookie, input: { id: projectAId }, method: "GET" });
    expect(financeProject.status).toBe(404);
    const financeOverview = await trpc(app, "project.overview", { cookie: financeCookie, method: "GET", input: { projectId: projectAId } });
    expect(financeOverview.status).toBe(404);
    // finance 看费用详情（费用摘要权）可见
    const anyReport = await query<{ id: string }>(`SELECT id FROM expense_reports LIMIT 1`);
    const financeReport = await trpc(app, "expense.getById", { cookie: financeCookie, input: { id: anyReport[0].id }, method: "GET" });
    expect(financeReport.status).toBe(200);
  });

  it("C11 统计与导出：同名指标同数；导出继承权限并写审计", async () => {
    const byProject = await trpc(app, "expense.stats.byProject", { cookie: pmCookie, method: "GET", input: { projectId: projectAId } });
    expect(byProject.status).toBe(200);
    const data = (byProject.json as {
      result: { data: { asOf: string; statusScope: string; actualCents: number; executionRate: number | null } };
    }).result.data;
    expect(data.asOf).toBeTruthy();
    expect(data.statusScope).toContain("EXPENSE_RECOGNIZED");
    // 同名指标同数：stats.actualCents === ledger 聚合 actual
    const ledgerAgg = await trpc(app, "budget.getById", {
      cookie: pmCookie,
      method: "GET",
      input: { id: (await query<{ id: string }>(`SELECT id FROM budgets WHERE project_id=$1 AND status='active'`, [projectAId]))[0].id },
    });
    expect(data.actualCents).toBe(
      (ledgerAgg.json as { result: { data: { aggregate: { actualCents: number } } } }).result.data.aggregate.actualCents,
    );

    const byCategory = await trpc(app, "expense.stats.byCategory", { cookie: financeCookie, method: "GET", input: { projectId: projectAId } });
    expect((byCategory.json as { result: { data: { items: unknown[] } } }).result.data.items.length).toBeGreaterThan(0);
    const byPerson = await trpc(app, "expense.stats.byPerson", { cookie: financeCookie, method: "GET", input: { projectId: projectAId } });
    expect((byPerson.json as { result: { data: { items: unknown[] } } }).result.data.items.length).toBeGreaterThan(0);

    // 导出：finance 可导 + 审计事件；member 被拒
    const exported = await trpc(app, "expense.stats.exportCsv", {
      cookie: financeCookie,
      method: "GET",
      input: { projectId: projectAId },
    });
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
