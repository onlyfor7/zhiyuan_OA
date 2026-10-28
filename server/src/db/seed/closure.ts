import { and, eq, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";

import * as schema from "../schema";
import {
  accessGrants,
  archiveDirectories,
  archiveLinks,
  budgetLedger,
  clients,
  expenseItems,
  expenseReports,
  fileObjects,
  fileVersions,
  fundingRequests,
  matters,
  meetings,
  planItems,
  planVersions,
  projectMembers,
  projects,
  stages,
  tasks,
  travelRequests,
  users,
  weeklyReports,
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

const ARCHIVE_DIRECTORIES = [
  { dirKey: "01_立项与授权", name: "立项与授权", seq: 1 },
  { dirKey: "02_计划基线与变更", name: "计划基线与变更", seq: 2 },
  { dirKey: "03_过程文件", name: "过程文件", seq: 3 },
  { dirKey: "04_质量检查与问题", name: "质量检查与问题", seq: 4 },
  { dirKey: "05_风险与决策", name: "风险与决策", seq: 5 },
  { dirKey: "06_周报与月报", name: "周报与月报", seq: 6 },
  { dirKey: "07_交付与验收", name: "交付与验收", seq: 7 },
  { dirKey: "08_结项与复盘", name: "结项与复盘", seq: 8 },
  { dirKey: "09_会议纪要与协同", name: "会议纪要与协同", seq: 9 },
  { dirKey: "10_出差与费用", name: "出差与费用", seq: 10 },
  { dirKey: "11_预算与经费", name: "预算与经费", seq: 11 },
];

async function userIdByEmail(tx: SeedTx, email: string): Promise<string> {
  const row = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!row[0]) throw new Error(`种子依赖用户 ${email} 缺失`);
  return row[0].id;
}

async function idByCode<T extends { id: string }>(tx: SeedTx, select: Promise<T[]>): Promise<string> {
  const row = await select;
  if (!row[0]) throw new Error("种子依赖行缺失");
  return row[0].id;
}

async function ensureArchiveDirs(tx: SeedTx, projectId: string): Promise<void> {
  for (const dir of ARCHIVE_DIRECTORIES) {
    const existing = await tx
      .select({ id: archiveDirectories.id })
      .from(archiveDirectories)
      .where(and(eq(archiveDirectories.projectId, projectId), eq(archiveDirectories.dirKey, dir.dirKey)));
    if (!existing[0]) {
      await tx.insert(archiveDirectories).values({ projectId, ...dir });
    }
  }
}

async function dirIdByKey(tx: SeedTx, projectId: string, dirKey: string): Promise<string> {
  const row = await tx
    .select({ id: archiveDirectories.id })
    .from(archiveDirectories)
    .where(and(eq(archiveDirectories.projectId, projectId), eq(archiveDirectories.dirKey, dirKey)));
  if (!row[0]) throw new Error(`档案目录 ${dirKey} 缺失`);
  return row[0].id;
}

async function ensureSourceLink(
  tx: SeedTx,
  projectId: string,
  directoryId: string,
  sourceType: string,
  sourceId: string,
  actorId: string,
): Promise<void> {
  const existing = await tx
    .select({ id: archiveLinks.id })
    .from(archiveLinks)
    .where(
      and(
        eq(archiveLinks.directoryId, directoryId),
        eq(archiveLinks.sourceType, sourceType),
        eq(archiveLinks.sourceId, sourceId),
      ),
    );
  if (!existing[0]) {
    await tx.insert(archiveLinks).values({
      projectId,
      directoryId,
      sourceType,
      sourceId,
      businessDate: fmt(TODAY),
      createdBy: actorId,
    });
  }
}

export async function seedClosure(tx: SeedTx): Promise<void> {
  const pmId = await userIdByEmail(tx, "pm@lexflow.demo");
  const memberId = await userIdByEmail(tx, "member@lexflow.demo");
  const partnerId = await userIdByEmail(tx, "partner@lexflow.demo");
  const qualityId = await userIdByEmail(tx, "quality@lexflow.demo");
  const financeId = await userIdByEmail(tx, "finance@lexflow.demo");
  const xubinId = await userIdByEmail(tx, "xubin@lexflow.demo");
  const mayueId = await userIdByEmail(tx, "mayue@lexflow.demo");
  const viewerId = await userIdByEmail(tx, "viewer@lexflow.demo");

  /* ===== 客户 3 + 事项 3（arch/08 §7：3 客户/5 项目） ===== */

  const clt3 = `CLT-${YEAR}-00003`;
  const cltExisting = await tx.select({ id: clients.id }).from(clients).where(eq(clients.code, clt3));
  if (!cltExisting[0]) {
    await tx.insert(clients).values({
      code: clt3,
      name: "恒岳建设集团有限公司",
      confidentialityLevel: "confidential",
      createdBy: pmId,
      updatedBy: pmId,
    });
  }
  const client3Id = await idByCode(tx, tx.select({ id: clients.id }).from(clients).where(eq(clients.code, clt3)));

  const mtr3 = `MTR-${YEAR}-00003`;
  const mtrExisting = await tx.select({ id: matters.id }).from(matters).where(eq(matters.code, mtr3));
  if (!mtrExisting[0]) {
    await tx.insert(matters).values({
      code: mtr3,
      clientId: client3Id,
      name: "恒岳建设并购重组法律尽调",
      type: "非诉",
      createdBy: pmId,
      updatedBy: pmId,
    });
  }
  const matter3Id = await idByCode(tx, tx.select({ id: matters.id }).from(matters).where(eq(matters.code, mtr3)));

  /* ===== 项目 D（恒岳并购尽调：进行中/风险/confidential，manager=孙倩）与 E（数据合规：筹备中/正常/public，manager=partner） ===== */

  const dStages = [
    { code: `STG-${YEAR}-00007`, name: "尽调启动", seq: 1, ps: -14, pe: -1, status: "active" },
    { code: `STG-${YEAR}-00008`, name: "尽调报告撰写", seq: 2, ps: 0, pe: 21, status: "pending" },
  ];
  const eStages = [
    { code: `STG-${YEAR}-00009`, name: "合规现状梳理", seq: 1, ps: 1, pe: 14, status: "pending" },
    { code: `STG-${YEAR}-00010`, name: "整改方案设计", seq: 2, ps: 15, pe: 30, status: "pending" },
  ];
  const dTasks = [
    { code: `TSK-${YEAR}-00013`, title: "尽调资料清单核对", stage: `STG-${YEAR}-00007`, assignee: mayueId, ps: -10, pe: -3, status: "done" },
    { code: `TSK-${YEAR}-00014`, title: "尽调报告初稿", stage: `STG-${YEAR}-00008`, assignee: qualityId, ps: 0, pe: 10, status: "in_progress" },
  ];
  const eTasks = [
    { code: `TSK-${YEAR}-00015`, title: "数据资产盘点", stage: `STG-${YEAR}-00009`, assignee: xubinId, ps: 2, pe: 9, status: "pending" },
    { code: `TSK-${YEAR}-00016`, title: "合规差距分析", stage: `STG-${YEAR}-00009`, assignee: partnerId, ps: 10, pe: 17, status: "pending" },
  ];

  async function ensureProject(
    code: string,
    matterId: string,
    name: string,
    type: string,
    managerId: string,
    level: "public" | "internal" | "confidential" | "secret",
    lifecycle: "preparing" | "in_progress" | "closed",
    health: "normal" | "warning" | "at_risk",
    members: Array<{ userId: string; projectRole: string }>,
    stageSeeds: typeof dStages,
    taskSeeds: typeof dTasks,
  ): Promise<string> {
    const existing = await tx.select({ id: projects.id }).from(projects).where(eq(projects.code, code));
    if (!existing[0]) {
      await tx.insert(projects).values({
        code,
        matterId,
        name,
        type,
        managerId,
        confidentialityLevel: level,
        lifecycleStatus: lifecycle,
        healthStatus: health,
        createdBy: managerId,
        updatedBy: managerId,
      });
    }
    const projectId = await idByCode(tx, tx.select({ id: projects.id }).from(projects).where(eq(projects.code, code)));
    for (const m of members) {
      await tx.insert(projectMembers).values({ projectId, userId: m.userId, projectRole: m.projectRole }).onConflictDoNothing();
    }
    const stageIds = new Map<string, string>();
    for (const s of stageSeeds) {
      const row = await tx.select({ id: stages.id }).from(stages).where(eq(stages.code, s.code));
      if (!row[0]) {
        await tx.insert(stages).values({
          projectId,
          code: s.code,
          name: s.name,
          seq: s.seq,
          plannedStart: fmt(addDays(TODAY, s.ps)),
          plannedEnd: fmt(addDays(TODAY, s.pe)),
          status: s.status as "pending" | "active" | "done",
          createdBy: managerId,
          updatedBy: managerId,
        });
      }
      stageIds.set(s.code, await idByCode(tx, tx.select({ id: stages.id }).from(stages).where(eq(stages.code, s.code))));
    }
    const taskIds = new Map<string, string>();
    for (const t of taskSeeds) {
      const row = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.code, t.code));
      if (!row[0]) {
        await tx.insert(tasks).values({
          projectId,
          stageId: stageIds.get(t.stage) ?? null,
          code: t.code,
          title: t.title,
          assigneeId: t.assignee,
          plannedStart: fmt(addDays(TODAY, t.ps)),
          plannedEnd: fmt(addDays(TODAY, t.pe)),
          status: t.status as "pending" | "in_progress" | "done" | "cancelled",
          createdBy: managerId,
          updatedBy: managerId,
        });
      }
      taskIds.set(t.code, await idByCode(tx, tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.code, t.code))));
    }
    // v1 基线 + plan_items（仅随新版本创建一次）
    const v1 = await tx
      .select({ id: planVersions.id })
      .from(planVersions)
      .where(and(eq(planVersions.projectId, projectId), eq(planVersions.versionNo, 1)));
    let v1Id = v1[0]?.id;
    if (!v1Id) {
      const inserted = await tx
        .insert(planVersions)
        .values({ projectId, versionNo: 1, kind: "baseline", status: "active", notes: "初始基线计划（种子）", createdBy: managerId, updatedBy: managerId })
        .returning({ id: planVersions.id });
      v1Id = inserted[0].id;
    }
    const itemCount = await tx.select({ id: planItems.id }).from(planItems).where(eq(planItems.planVersionId, v1Id));
    if (itemCount.length === 0) {
      let seq = 1;
      for (const s of stageSeeds) {
        await tx.insert(planItems).values({
          planVersionId: v1Id,
          itemType: "stage",
          refId: stageIds.get(s.code)!,
          name: s.name,
          plannedStart: fmt(addDays(TODAY, s.ps)),
          plannedEnd: fmt(addDays(TODAY, s.pe)),
          seq: seq++,
          createdBy: managerId,
        });
      }
      for (const t of taskSeeds) {
        await tx.insert(planItems).values({
          planVersionId: v1Id,
          itemType: "task",
          refId: taskIds.get(t.code)!,
          name: t.title,
          plannedStart: fmt(addDays(TODAY, t.ps)),
          plannedEnd: fmt(addDays(TODAY, t.pe)),
          seq: seq++,
          createdBy: managerId,
        });
      }
    }
    await ensureArchiveDirs(tx, projectId);
    return projectId;
  }

  await ensureProject(
    `PRJ-${YEAR}-00004`,
    matter3Id,
    "恒岳建设并购法律尽调",
    "非诉",
    qualityId,
    "confidential",
    "in_progress",
    "at_risk",
    [
      { userId: qualityId, projectRole: "manager" },
      { userId: mayueId, projectRole: "member" },
    ],
    dStages,
    dTasks,
  );
  const matter2Id = await idByCode(tx, tx.select({ id: matters.id }).from(matters).where(eq(matters.code, `MTR-${YEAR}-00002`)));
  await ensureProject(
    `PRJ-${YEAR}-00005`,
    matter2Id,
    "星澜科技数据合规专项",
    "非诉",
    partnerId,
    "public",
    "preparing",
    "normal",
    [
      { userId: partnerId, projectRole: "manager" },
      { userId: xubinId, projectRole: "member" },
    ],
    eStages,
    eTasks,
  );

  /* ===== 项目 A 全链闭环：经费→报销→支付→核销（台账留痕，五公式自洽） ===== */

  const projectAId = await idByCode(tx, tx.select({ id: projects.id }).from(projects).where(eq(projects.code, `PRJ-${YEAR}-00001`)));
  const travel1Id = await idByCode(tx, tx.select({ id: travelRequests.id }).from(travelRequests).where(eq(travelRequests.code, `TRV-${YEAR}-00001`)));
  const budgetAId = await idByCode(
    tx,
    tx.select({ id: schema.budgets.id }).from(schema.budgets).where(eq(schema.budgets.code, `BUD-${YEAR}-00001`)),
  );

  const f3Code = `FND-${YEAR}-00003`;
  const f3Existing = await tx.select({ id: fundingRequests.id }).from(fundingRequests).where(eq(fundingRequests.code, f3Code));
  if (!f3Existing[0]) {
    const inserted = await tx
      .insert(fundingRequests)
      .values({
        projectId: projectAId,
        code: f3Code,
        applicantId: memberId,
        purpose: "杭州出差差旅备用金（闭环演示经费）",
        amountCents: 1000000,
        expectedUseDate: fmt(addDays(TODAY, -13)),
        recipientInfo: "据实报销",
        sourceTravelId: travel1Id,
        approvalStatus: "approved",
        usageStatus: "partially_used", // 已被 EXP-00002 核销 800,000
        createdBy: memberId,
        updatedBy: memberId,
      })
      .returning({ id: fundingRequests.id });
    const key = `FUNDING_RESERVED:${inserted[0].id}:0`;
    const ledgerExisting = await tx.select({ id: budgetLedger.id }).from(budgetLedger).where(eq(budgetLedger.idempotencyKey, key));
    if (!ledgerExisting[0]) {
      await tx.insert(budgetLedger).values({
        code: `LED-${YEAR}-00004`,
        projectId: projectAId,
        budgetVersionId: budgetAId,
        sourceType: "funding",
        sourceId: inserted[0].id,
        entryType: "FUNDING_RESERVED",
        reservedDeltaCents: 1000000,
        actualDeltaCents: 0,
        occurredAt: addDays(TODAY, -12).toISOString(),
        idempotencyKey: key,
      });
    }
  }
  const fnd3Id = await idByCode(tx, tx.select({ id: fundingRequests.id }).from(fundingRequests).where(eq(fundingRequests.code, f3Code)));

  const exp2Code = `EXP-${YEAR}-00002`;
  const exp2Existing = await tx.select({ id: expenseReports.id }).from(expenseReports).where(eq(expenseReports.code, exp2Code));
  if (!exp2Existing[0]) {
    const report = await tx
      .insert(expenseReports)
      .values({
        code: exp2Code,
        applicantId: memberId,
        reason: "杭州出差费用报销（核销闭环演示）",
        isCrossProject: false,
        travelId: travel1Id,
        totalCents: 800000,
        status: "paid",
        paidAt: addDays(TODAY, -5).toISOString(),
        paidBy: financeId,
        paymentRef: "PAY-2026-0001",
        createdBy: memberId,
        updatedBy: financeId,
      })
      .returning({ id: expenseReports.id });
    const reportId = report[0].id;
    const receiptDate = fmt(addDays(TODAY, -13));

    const receiptFile = async (storageKey: string, sha: string): Promise<string> => {
      const fo = await tx.insert(fileObjects).values({ sourceType: "expense", sourceId: reportId, createdBy: memberId }).returning({ id: fileObjects.id });
      const fv = await tx
        .insert(fileVersions)
        .values({
          fileObjectId: fo[0].id,
          versionNo: 1,
          storageKey,
          sizeBytes: 2048,
          mimeType: "application/pdf",
          sha256: sha,
          businessDate: receiptDate,
          uploadedBy: memberId,
        })
        .returning({ id: fileVersions.id });
      return fv[0].id;
    };
    const receipt3 = await receiptFile(
      `receipt-${YEAR}-00003.pdf`,
      "a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef0123456789abcd03",
    );
    const receipt4 = await receiptFile(
      `receipt-${YEAR}-00004.pdf`,
      "a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef0123456789abcd04",
    );

    const items = await tx
      .insert(expenseItems)
      .values([
        {
          expenseReportId: reportId,
          projectId: projectAId,
          fundingRequestId: fnd3Id,
          date: receiptDate,
          category: "meals",
          amountCents: 500000,
          description: "出差期间工作餐费",
          payee: "杭州示例餐饮",
          receiptNo: "HS202613-003",
          receiptFileVersionId: receipt3,
          receiptSatisfied: true,
          createdBy: memberId,
          updatedBy: memberId,
        },
        {
          expenseReportId: reportId,
          projectId: projectAId,
          fundingRequestId: fnd3Id,
          date: receiptDate,
          category: "travel_other",
          amountCents: 300000,
          description: "市内交通与杂费",
          payee: "杭州出租示例",
          receiptNo: "GT202613-004",
          receiptFileVersionId: receipt4,
          receiptSatisfied: true,
          createdBy: memberId,
          updatedBy: memberId,
        },
      ])
      .returning({ id: expenseItems.id, amountCents: expenseItems.amountCents });

    // 核销三笔（arch/06 §4.3：释放占用 + 确认实际，幂等键业务事件维度，与后端 R4 口径一致）
    const ledgerSeeds = [
      {
        code: `LED-${YEAR}-00005`,
        entryType: "FUNDING_RELEASED",
        reserved: -800000,
        actual: 0,
        sourceType: "funding",
        sourceId: fnd3Id,
        key: `FUNDING_RELEASED:${fnd3Id}:${reportId}`,
      },
      ...items.map((item, i) => ({
        code: `LED-${YEAR}-0000${6 + i}`,
        entryType: "EXPENSE_RECOGNIZED",
        reserved: 0,
        actual: item.amountCents,
        sourceType: "expense",
        sourceId: item.id,
        key: `EXPENSE_RECOGNIZED:${reportId}:${item.id}`,
      })),
    ];
    for (const entry of ledgerSeeds) {
      const existing = await tx.select({ id: budgetLedger.id }).from(budgetLedger).where(eq(budgetLedger.idempotencyKey, entry.key));
      if (!existing[0]) {
        await tx.insert(budgetLedger).values({
          code: entry.code,
          projectId: projectAId,
          budgetVersionId: budgetAId,
          sourceType: entry.sourceType,
          sourceId: entry.sourceId,
          entryType: entry.entryType as never,
          reservedDeltaCents: entry.reserved,
          actualDeltaCents: entry.actual,
          occurredAt: addDays(TODAY, -6).toISOString(),
          idempotencyKey: entry.key,
        });
      }
    }
  }

  /* ===== 项目 A 归档链（报告/会议/出差/经费/费用 + 票据文件链接）与授权 ===== */

  const reportId = await idByCode(tx, tx.select({ id: weeklyReports.id }).from(weeklyReports).where(eq(weeklyReports.code, `RPT-${YEAR}-00001`)));
  const meeting3Id = await idByCode(tx, tx.select({ id: meetings.id }).from(meetings).where(eq(meetings.code, `MTG-${YEAR}-00003`)));
  const fnd1Id = await idByCode(tx, tx.select({ id: fundingRequests.id }).from(fundingRequests).where(eq(fundingRequests.code, `FND-${YEAR}-00001`)));
  const exp1Id = await idByCode(tx, tx.select({ id: expenseReports.id }).from(expenseReports).where(eq(expenseReports.code, `EXP-${YEAR}-00001`)));
  const exp2Id = await idByCode(tx, tx.select({ id: expenseReports.id }).from(expenseReports).where(eq(expenseReports.code, `EXP-${YEAR}-00002`)));
  const receipt3 = await idByCode(
    tx,
    tx.select({ id: fileVersions.id }).from(fileVersions).where(eq(fileVersions.storageKey, `receipt-${YEAR}-00003.pdf`)),
  );

  await ensureSourceLink(tx, projectAId, await dirIdByKey(tx, projectAId, "06_周报与月报"), "report", reportId, pmId);
  await ensureSourceLink(tx, projectAId, await dirIdByKey(tx, projectAId, "09_会议纪要与协同"), "meeting", meeting3Id, pmId);
  await ensureSourceLink(tx, projectAId, await dirIdByKey(tx, projectAId, "10_出差与费用"), "travel", travel1Id, pmId);
  await ensureSourceLink(tx, projectAId, await dirIdByKey(tx, projectAId, "11_预算与经费"), "funding", fnd1Id, pmId);
  await ensureSourceLink(tx, projectAId, await dirIdByKey(tx, projectAId, "10_出差与费用"), "expense", exp1Id, pmId);
  // EXP-00002 不走纯来源链接：其归档由下方票据文件链接承载（fv + 来源对，信息更全且同 (directory, source) 唯一）

  // 票据文件链接（二态：文件链接 fv 非空 + 来源对）
  const receiptLink = await tx
    .select({ id: archiveLinks.id })
    .from(archiveLinks)
    .where(and(eq(archiveLinks.directoryId, await dirIdByKey(tx, projectAId, "10_出差与费用")), eq(archiveLinks.fileVersionId, receipt3)));
  if (!receiptLink[0]) {
    await tx.insert(archiveLinks).values({
      projectId: projectAId,
      directoryId: await dirIdByKey(tx, projectAId, "10_出差与费用"),
      fileVersionId: receipt3,
      sourceType: "expense",
      sourceId: exp2Id,
      businessDate: fmt(TODAY),
      createdBy: memberId,
    });
  }

  // 授权链：viewer 对 A 项目「周报与月报」目录的只读授权（active，到期日未来）——目录级不放大项目可见性
  const dir06 = await dirIdByKey(tx, projectAId, "06_周报与月报");
  const grantExisting = await tx
    .select({ id: accessGrants.id })
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.granteeId, viewerId),
        eq(accessGrants.scopeType, "directory"),
        eq(accessGrants.scopeId, dir06),
        eq(accessGrants.status, "active"),
      ),
    );
  if (!grantExisting[0]) {
    await tx.insert(accessGrants).values({
      granteeId: viewerId,
      scopeType: "directory",
      scopeId: dir06,
      actions: ["read"],
      expiresAt: addDays(TODAY, 30).toISOString(),
      grantedBy: pmId,
      status: "active",
      createdBy: pmId,
      updatedBy: pmId,
    });
  }

  /* ===== 编号序列水位对齐 ===== */

  const floors: Array<[string, number]> = [
    ["CLT", 4],
    ["MTR", 4],
    ["PRJ", 6],
    ["STG", 11],
    ["TSK", 17],
    ["FND", 4],
    ["EXP", 3],
    ["LED", 8],
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
