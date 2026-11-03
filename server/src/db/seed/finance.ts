import { and, eq, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";

import * as schema from "../schema";
import {
  approvalPolicies,
  budgetCategories,
  budgetLedger,
  budgets,
  expenseItems,
  expenseReports,
  fileObjects,
  fileVersions,
  fundingRequests,
  projects,
  travelRequests,
  users,
} from "../schema";

export type SeedTx =
  | NodePgDatabase<typeof schema>
  | NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;

const YEAR = new Date().getFullYear();

function fmt(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

const TODAY = new Date();

/** arch/06 §6 审批策略种子五条（按 biz_type+priority 幂等） */
const FINANCE_POLICY_SEED = [
  {
    bizType: "budget",
    priority: 100,
    matchJson: {},
    stepsJson: [{ approver_role: "partner" }],
    description: "预算生效/调整 → 管理层审批",
  },
  {
    bizType: "funding",
    priority: 10,
    matchJson: { min_amount_cents: 5000000 },
    stepsJson: [{ approver_role: "project_manager" }, { approver_role: "partner" }],
    description: "经费申请（金额 ≥ 50,000 元）→ 两步升级：项目负责人 → 管理层",
  },
  {
    bizType: "funding",
    priority: 100,
    matchJson: {},
    stepsJson: [{ approver_role: "project_manager" }],
    description: "经费申请（默认）→ 项目负责人审批",
  },
  {
    bizType: "expense",
    priority: 100,
    matchJson: {},
    stepsJson: [{ approver_role: "project_manager" }, { approver_role: "finance" }],
    description: "费用报销 → 项目负责人 → 财务审批",
  },
  {
    // R3（架构 2026-10-27 打回修复，特批改 seed）：单步 partner 终审——finance 发起时
    // 第一步自审全跳过会死锁（E2E-13）；发起不限角色，职责分离由 partner 终审保证
    bizType: "expense_adjustment",
    priority: 100,
    matchJson: {},
    stepsJson: [{ approver_role: "partner" }],
    description: "费用调整/冲销（已支付更正唯一通道）→ 管理层终审（发起不限角色）",
  },
];

/** 台账分录幂等键（arch/06 §4.1：entryType:sourceId:seq） */
const ledgerKey = (entryType: string, sourceId: string, seq: number): string =>
  `${entryType}:${sourceId}:${seq}`;

async function userIdByEmail(tx: SeedTx, email: string): Promise<string> {
  const row = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!row[0]) throw new Error(`种子依赖用户 ${email} 缺失`);
  return row[0].id;
}

async function projectIdByCode(tx: SeedTx, code: string): Promise<string> {
  const row = await tx.select({ id: projects.id }).from(projects).where(eq(projects.code, code));
  if (!row[0]) throw new Error(`种子依赖项目 ${code} 缺失`);
  return row[0].id;
}

export async function seedFinance(tx: SeedTx): Promise<void> {
  const pmId = await userIdByEmail(tx, "wangbaozhuo@lexflow.demo");
  const memberId = await userIdByEmail(tx, "guanchen@lexflow.demo");
  const financeId = await userIdByEmail(tx, "guojingwen@lexflow.demo");
  void financeId; // 策略引用角色即可

  const projectAId = await projectIdByCode(tx, `PRJ-${YEAR}-00001`);
  const projectBId = await projectIdByCode(tx, `PRJ-${YEAR}-00002`);

  // 审批策略（arch/06 §6 五条）
  for (const policy of FINANCE_POLICY_SEED) {
    const existing = await tx
      .select({ id: approvalPolicies.id })
      .from(approvalPolicies)
      .where(and(eq(approvalPolicies.bizType, policy.bizType), eq(approvalPolicies.priority, policy.priority)));
    if (!existing[0]) {
      await tx.insert(approvalPolicies).values({
        bizType: policy.bizType,
        priority: policy.priority,
        matchJson: policy.matchJson,
        stepsJson: policy.stepsJson,
        description: policy.description,
        createdBy: pmId,
        updatedBy: pmId,
      });
    }
  }

  /* ===== 预算：项目 A 80 万（含类别行）+ 项目 B 20 万（无类别行） ===== */

  const periodStart = fmt(addDays(TODAY, -60));
  const periodEnd = fmt(addDays(TODAY, 120));

  async function ensureBudget(
    code: string,
    projectId: string,
    totalCents: number,
    categories: Array<{ category: string; amountCents: number }>,
    ledgerCode: string,
  ): Promise<string> {
    const existing = await tx.select({ id: budgets.id }).from(budgets).where(eq(budgets.code, code));
    let budgetId = existing[0]?.id;
    if (!budgetId) {
      const inserted = await tx
        .insert(budgets)
        .values({
          projectId,
          code,
          versionNo: 1,
          periodStart,
          periodEnd,
          currency: "CNY",
          totalCents,
          description: "种子预算 V1",
          status: "active",
          createdBy: pmId,
          updatedBy: pmId,
        })
        .returning({ id: budgets.id });
      budgetId = inserted[0].id;
      for (const c of categories) {
        await tx.insert(budgetCategories).values({ budgetId, category: c.category as never, amountCents: c.amountCents });
      }
    }
    // BUDGET_ACTIVATED 台账分录（marker：有效预算以 budgets 表 active 版本为准，分录留痕激活事件）
    const key = ledgerKey("BUDGET_ACTIVATED", budgetId, 0);
    const ledgerExisting = await tx
      .select({ id: budgetLedger.id })
      .from(budgetLedger)
      .where(eq(budgetLedger.idempotencyKey, key));
    if (!ledgerExisting[0]) {
      await tx.insert(budgetLedger).values({
        code: ledgerCode,
        projectId,
        budgetVersionId: budgetId,
        sourceType: "budget",
        sourceId: budgetId,
        entryType: "BUDGET_ACTIVATED",
        reservedDeltaCents: 0,
        actualDeltaCents: 0,
        occurredAt: new Date().toISOString(),
        idempotencyKey: key,
      });
    }
    return budgetId;
  }

  const budgetAId = await ensureBudget(`BUD-${YEAR}-00001`, projectAId, 80000000, [
    { category: "transport", amountCents: 30000000 }, // 差旅 30 万
    { category: "materials", amountCents: 10000000 }, // 资料 10 万
  ], `LED-${YEAR}-00001`);
  await ensureBudget(`BUD-${YEAR}-00002`, projectBId, 20000000, [], `LED-${YEAR}-00003`); // 无类别行 ≠ 零预算

  /* ===== 经费：member approved 2 万（台账 FUNDING_RESERVED 在位）+ pm pending 6 万 ===== */

  const travelRow = await tx
    .select({ id: travelRequests.id })
    .from(travelRequests)
    .where(eq(travelRequests.code, `TRV-${YEAR}-00001`));

  const f1Code = `FND-${YEAR}-00001`;
  const f1Existing = await tx.select({ id: fundingRequests.id }).from(fundingRequests).where(eq(fundingRequests.code, f1Code));
  if (!f1Existing[0]) {
    const inserted = await tx
      .insert(fundingRequests)
      .values({
        projectId: projectAId,
        code: f1Code,
        applicantId: memberId,
        purpose: "杭州出差现场服务经费",
        amountCents: 2000000,
        expectedUseDate: fmt(addDays(TODAY, -13)),
        recipientInfo: "差旅费用据实报销",
        sourceTravelId: travelRow[0]?.id ?? null,
        approvalStatus: "approved",
        usageStatus: "unused",
        createdBy: memberId,
        updatedBy: memberId,
      })
      .returning({ id: fundingRequests.id });
    // 获批占用（唯一一次）：FUNDING_RESERVED +2,000,000 —— 五公式「有效占用」来源
    const key = ledgerKey("FUNDING_RESERVED", inserted[0].id, 0);
    const ledgerExisting = await tx
      .select({ id: budgetLedger.id })
      .from(budgetLedger)
      .where(eq(budgetLedger.idempotencyKey, key));
    if (!ledgerExisting[0]) {
      await tx.insert(budgetLedger).values({
        code: `LED-${YEAR}-00002`,
        projectId: projectAId,
        budgetVersionId: budgetAId,
        sourceType: "funding",
        sourceId: inserted[0].id,
        entryType: "FUNDING_RESERVED",
        reservedDeltaCents: 2000000,
        actualDeltaCents: 0,
        occurredAt: new Date().toISOString(),
        idempotencyKey: key,
      });
    }
  }

  const f2Code = `FND-${YEAR}-00002`;
  const f2Existing = await tx.select({ id: fundingRequests.id }).from(fundingRequests).where(eq(fundingRequests.code, f2Code));
  if (!f2Existing[0]) {
    // pending_approval：未获批不占用（无台账分录），演示金额 ≥ 5 万两步升级
    await tx.insert(fundingRequests).values({
      projectId: projectAId,
      code: f2Code,
      applicantId: pmId,
      purpose: "北京异地验收差旅借款",
      amountCents: 6000000,
      expectedUseDate: fmt(addDays(TODAY, 9)),
      recipientInfo: "借款 5,000 元随差旅核销",
      approvalStatus: "pending_approval",
      usageStatus: "unused",
      createdBy: pmId,
      updatedBy: pmId,
    });
  }

  /* ===== 报销：member draft 一单（关联出差+经费，2 明细含票据文件版本） ===== */

  const expCode = `EXP-${YEAR}-00001`;
  const expExisting = await tx.select({ id: expenseReports.id }).from(expenseReports).where(eq(expenseReports.code, expCode));
  if (!expExisting[0]) {
    const report = await tx
      .insert(expenseReports)
      .values({
        code: expCode,
        applicantId: memberId,
        reason: "杭州出差费用报销（现场服务）",
        isCrossProject: false,
        travelId: travelRow[0]?.id ?? null,
        totalCents: 1400000, // 服务端口径 = 明细合计：800,000 + 600,000
        status: "draft",
        createdBy: memberId,
        updatedBy: memberId,
      })
      .returning({ id: expenseReports.id });
    const reportId = report[0].id;

    const funding = await tx
      .select({ id: fundingRequests.id })
      .from(fundingRequests)
      .where(eq(fundingRequests.code, f1Code));

    const receiptDate = fmt(addDays(TODAY, -13));

    // 票据文件（file_objects 来源挂报销单；物理版本各一，sha256 唯一）
    const receiptFile = async (storageKey: string, sha: string): Promise<string> => {
      const fo = await tx
        .insert(fileObjects)
        .values({ sourceType: "expense", sourceId: reportId, createdBy: memberId })
        .returning({ id: fileObjects.id });
      const fv = await tx
        .insert(fileVersions)
        .values({
          fileObjectId: fo[0].id,
          versionNo: 1,
          storageKey,
          sizeBytes: 1024,
          mimeType: "application/pdf",
          sha256: sha,
          businessDate: receiptDate,
          uploadedBy: memberId,
        })
        .returning({ id: fileVersions.id });
      return fv[0].id;
    };

    const receipt1 = await receiptFile(
      `receipt-${YEAR}-00001.pdf`,
      "a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef0123456789abcd01",
    );
    const receipt2 = await receiptFile(
      `receipt-${YEAR}-00002.pdf`,
      "a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef0123456789abcd02",
    );

    await tx.insert(expenseItems).values([
      {
        expenseReportId: reportId,
        projectId: projectAId,
        fundingRequestId: funding[0]?.id ?? null,
        date: receiptDate,
        category: "transport",
        amountCents: 800000,
        description: "上海—杭州高铁往返",
        payee: "中国铁路上海局",
        receiptNo: "TR202613-001",
        receiptFileVersionId: receipt1,
        receiptSatisfied: true,
        createdBy: memberId,
        updatedBy: memberId,
      },
      {
        expenseReportId: reportId,
        projectId: projectAId,
        fundingRequestId: funding[0]?.id ?? null,
        date: receiptDate,
        category: "accommodation",
        amountCents: 600000,
        description: "杭州两晚住宿",
        payee: "杭州示例酒店",
        receiptNo: "HT202613-002",
        receiptFileVersionId: receipt2,
        receiptSatisfied: true,
        createdBy: memberId,
        updatedBy: memberId,
      },
    ]);
  }

  // 编号序列水位对齐（BUD/FND/EXP/LED 新前缀）
  const floors: Array<[string, number]> = [
    ["BUD", 3],
    ["FND", 3],
    ["EXP", 2],
    ["LED", 4],
  ];
  for (const [prefix, next] of floors) {
    await tx.execute(
      sql.raw(
        `INSERT INTO code_sequences (prefix, year, next_value) VALUES ('${prefix}', ${YEAR}, ${next}) ` +
          `ON CONFLICT (prefix, year) DO UPDATE SET next_value = GREATEST(code_sequences.next_value, ${next})`,
      ),
    );
  }
}
