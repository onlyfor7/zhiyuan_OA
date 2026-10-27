import { and, eq, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";

import * as schema from "../schema";
import {
  approvalPolicies,
  archiveDirectories,
  decisions,
  deliverables,
  fileObjects,
  milestones,
  planItems,
  planVersions,
  projectTemplates,
  projects,
  qualityCheckItems,
  qualityIssueEvents,
  qualityIssues,
  stages,
  tasks,
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

/** 需求基线 §12.1 默认项目档案目录（固定十一项，arch/04 §2.8） */
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

const PROJECT_TEMPLATES = [
  {
    name: "诉讼案件标准模板",
    description: "诉讼案件全周期：立案证据、庭前、庭审、判决执行四阶段与强制检查项",
    structureJson: {
      stages: [
        { name: "立案与证据收集", seq: 1 },
        { name: "庭前准备", seq: 2 },
        { name: "庭审", seq: 3 },
        { name: "判决与执行", seq: 4 },
      ],
      checkItems: [
        { name: "利益冲突检索", required: true, stageSeq: 1 },
        { name: "案件材料完整性核对", required: true, stageSeq: 1 },
        { name: "诉讼文书质检", required: true, stageSeq: 2 },
        { name: "时效核查", required: true, stageSeq: 2 },
      ],
      // 模板任务（arch/04 §2.10 v1.2；覆盖 1/2/3 阶段，日期均落在阶段区间内）
      tasks: [
        { name: "证据清单整理", stageSeq: 1, offsetDays: 3, durationDays: 7, assigneeRole: "manager" },
        { name: "起诉状起草", stageSeq: 1, offsetDays: 6, durationDays: 7 },
        { name: "证据交换材料核对", stageSeq: 2, offsetDays: 2, durationDays: 10 },
        { name: "庭前会议提纲", stageSeq: 2, offsetDays: 8, durationDays: 5 },
        { name: "代理意见初稿", stageSeq: 3, offsetDays: 2, durationDays: 8 },
      ],
    },
  },
  {
    name: "常年法律顾问模板",
    description: "常年法律顾问：需求梳理与日常服务执行两阶段",
    structureJson: {
      stages: [
        { name: "顾问需求梳理", seq: 1 },
        { name: "日常服务执行", seq: 2 },
      ],
      checkItems: [{ name: "服务台账完整性", required: true, stageSeq: 2 }],
      tasks: [{ name: "服务台账建立", stageSeq: 1, offsetDays: 1, durationDays: 5 }],
    },
  },
];

/** arch/04 §2.9 种子审批策略 */
const APPROVAL_POLICY_SEED = [
  {
    bizType: "change_request",
    priority: 10,
    matchJson: { level: "key" },
    stepsJson: [{ approver_role: "partner" }],
    description: "延期申请（关键级）→ 管理层（partner）审批",
  },
  {
    bizType: "change_request",
    priority: 20,
    matchJson: { level: "normal" },
    stepsJson: [{ approver_role: "project_manager" }],
    description: "延期申请（常规级）→ 项目负责人审批",
  },
  {
    bizType: "access_grant",
    priority: 10,
    matchJson: {},
    stepsJson: [{ approver_role: "archivist" }],
    description: "档案授权申请 → 档案管理员审批",
  },
];

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

export async function seedGovernance(tx: SeedTx): Promise<void> {
  const pmId = await userIdByEmail(tx, "pm@lexflow.demo");
  const memberId = await userIdByEmail(tx, "member@lexflow.demo");
  const liuchangId = await userIdByEmail(tx, "liuchang@lexflow.demo");
  const huangleiId = await userIdByEmail(tx, "huanglei@lexflow.demo");
  const xubinId = await userIdByEmail(tx, "xubin@lexflow.demo");

  const projectAId = await projectIdByCode(tx, `PRJ-${YEAR}-00001`);
  const projectBId = await projectIdByCode(tx, `PRJ-${YEAR}-00002`);

  // 项目模板（按 name upsert：冲突时更新 structure_json——02c 架构特批；重跑种子使模板新结构生效）
  for (const tpl of PROJECT_TEMPLATES) {
    const existing = await tx
      .select({ id: projectTemplates.id })
      .from(projectTemplates)
      .where(eq(projectTemplates.name, tpl.name));
    if (!existing[0]) {
      await tx.insert(projectTemplates).values({
        name: tpl.name,
        description: tpl.description,
        structureJson: tpl.structureJson,
        createdBy: pmId,
        updatedBy: pmId,
      });
    } else {
      await tx
        .update(projectTemplates)
        .set({ structureJson: tpl.structureJson, description: tpl.description, updatedBy: pmId, updatedAt: new Date().toISOString() })
        .where(eq(projectTemplates.id, existing[0].id));
    }
  }

  // 审批策略（按 biz_type + priority 幂等，arch/04 §2.9 三条）
  for (const policy of APPROVAL_POLICY_SEED) {
    const existing = await tx
      .select({ id: approvalPolicies.id })
      .from(approvalPolicies)
      .where(
        and(eq(approvalPolicies.bizType, policy.bizType), eq(approvalPolicies.priority, policy.priority)),
      );
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

  // 档案目录：项目 A/B 各十一项（§12.1；C 保持隔离不动）
  for (const projectId of [projectAId, projectBId]) {
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

  /* ===== 项目 A 治理数据（PRJ-2026-00001） ===== */

  const aStages = [
    { code: `STG-${YEAR}-00001`, name: "立案与证据收集", seq: 1, ps: -21, pe: 9, as: -21, ae: null, status: "active" },
    { code: `STG-${YEAR}-00002`, name: "庭前准备", seq: 2, ps: 10, pe: 30, as: null, ae: null, status: "pending" },
    { code: `STG-${YEAR}-00003`, name: "庭审", seq: 3, ps: 31, pe: 45, as: null, ae: null, status: "pending" },
    { code: `STG-${YEAR}-00004`, name: "判决与执行", seq: 4, ps: 46, pe: 60, as: null, ae: null, status: "pending" },
  ];
  const stageIds = new Map<string, string>();
  for (const s of aStages) {
    const existing = await tx.select({ id: stages.id }).from(stages).where(eq(stages.code, s.code));
    if (!existing[0]) {
      await tx.insert(stages).values({
        projectId: projectAId,
        code: s.code,
        name: s.name,
        seq: s.seq,
        plannedStart: fmt(addDays(TODAY, s.ps)),
        plannedEnd: fmt(addDays(TODAY, s.pe)),
        actualStart: s.as === null ? null : fmt(addDays(TODAY, s.as)),
        actualEnd: s.ae === null ? null : fmt(addDays(TODAY, s.ae)),
        status: s.status as "pending" | "active" | "done",
        createdBy: pmId,
        updatedBy: pmId,
      });
    }
    const row = await tx.select({ id: stages.id }).from(stages).where(eq(stages.code, s.code));
    stageIds.set(s.code, row[0].id);
  }

  const aMilestones = [
    { code: `MLS-${YEAR}-00001`, name: "证据收集完成", seq: 1, stage: `STG-${YEAR}-00001`, pd: -1, ad: -1, status: "reached" },
    { code: `MLS-${YEAR}-00002`, name: "庭前会议完成", seq: 2, stage: `STG-${YEAR}-00002`, pd: 25, ad: null, status: "pending" },
    { code: `MLS-${YEAR}-00003`, name: "一审判决取得", seq: 3, stage: `STG-${YEAR}-00004`, pd: 55, ad: null, status: "pending" },
  ];
  const milestoneIds = new Map<string, string>();
  for (const m of aMilestones) {
    const existing = await tx.select({ id: milestones.id }).from(milestones).where(eq(milestones.code, m.code));
    if (!existing[0]) {
      await tx.insert(milestones).values({
        projectId: projectAId,
        stageId: stageIds.get(m.stage) ?? null,
        code: m.code,
        name: m.name,
        seq: m.seq,
        plannedDate: fmt(addDays(TODAY, m.pd)),
        actualDate: m.ad === null ? null : fmt(addDays(TODAY, m.ad)),
        status: m.status as "pending" | "reached" | "missed",
        createdBy: pmId,
        updatedBy: pmId,
      });
    }
    const row = await tx.select({ id: milestones.id }).from(milestones).where(eq(milestones.code, m.code));
    milestoneIds.set(m.code, row[0].id);
  }

  // 任务 ×8：含 1 条已逾期（00004）、1 条临期 2 天内（00003），状态/负责人/期限各异
  const aTasks = [
    { code: `TSK-${YEAR}-00001`, title: "证据清单整理", stage: `STG-${YEAR}-00001`, assignee: memberId, ps: -21, pe: -14, status: "done", completedOffset: -14 },
    { code: `TSK-${YEAR}-00002`, title: "起诉状起草", stage: `STG-${YEAR}-00001`, assignee: memberId, ps: -14, pe: -7, status: "done", completedOffset: -7 },
    { code: `TSK-${YEAR}-00003`, title: "证据交换材料核对", stage: `STG-${YEAR}-00002`, assignee: memberId, ps: -3, pe: 1, status: "in_progress", completedOffset: null },
    { code: `TSK-${YEAR}-00004`, title: "庭前会议提纲", stage: `STG-${YEAR}-00002`, assignee: liuchangId, ps: -5, pe: -2, status: "in_progress", completedOffset: null },
    { code: `TSK-${YEAR}-00005`, title: "代理意见初稿", stage: `STG-${YEAR}-00002`, assignee: pmId, ps: 3, pe: 12, status: "pending", completedOffset: null },
    { code: `TSK-${YEAR}-00006`, title: "客户汇报材料", stage: `STG-${YEAR}-00003`, assignee: huangleiId, ps: 13, pe: 20, status: "pending", completedOffset: null },
    { code: `TSK-${YEAR}-00007`, title: "庭审排期确认", stage: `STG-${YEAR}-00003`, assignee: pmId, ps: 21, pe: 28, status: "pending", completedOffset: null },
    { code: `TSK-${YEAR}-00008`, title: "执行线索梳理", stage: `STG-${YEAR}-00004`, assignee: liuchangId, ps: 31, pe: 40, status: "pending", completedOffset: null },
  ];
  const taskIds = new Map<string, string>();
  for (const t of aTasks) {
    const existing = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.code, t.code));
    if (!existing[0]) {
      await tx.insert(tasks).values({
        projectId: projectAId,
        stageId: stageIds.get(t.stage) ?? null,
        code: t.code,
        title: t.title,
        assigneeId: t.assignee,
        plannedStart: fmt(addDays(TODAY, t.ps)),
        plannedEnd: fmt(addDays(TODAY, t.pe)),
        status: t.status as "pending" | "in_progress" | "done" | "cancelled",
        actualStart: t.completedOffset === null ? null : fmt(addDays(TODAY, t.ps)),
        actualEnd: t.completedOffset === null ? null : addDays(TODAY, t.completedOffset).toISOString(),
        completedAt: t.completedOffset === null ? null : addDays(TODAY, t.completedOffset).toISOString(),
        createdBy: pmId,
        updatedBy: pmId,
      });
    }
    const row = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.code, t.code));
    taskIds.set(t.code, row[0].id);
  }

  // 计划版本 v1（baseline, active）+ plan_items（含依赖；items 仅随新版本创建一次）
  const v1Existing = await tx
    .select({ id: planVersions.id })
    .from(planVersions)
    .where(and(eq(planVersions.projectId, projectAId), eq(planVersions.versionNo, 1)));
  let v1Id = v1Existing[0]?.id;
  if (!v1Id) {
    const inserted = await tx
      .insert(planVersions)
      .values({
        projectId: projectAId,
        versionNo: 1,
        kind: "baseline",
        status: "active",
        notes: "初始基线计划（种子）",
        createdBy: pmId,
        updatedBy: pmId,
      })
      .returning({ id: planVersions.id });
    v1Id = inserted[0].id;
  }
  const v1ItemsCount = await tx
    .select({ id: planItems.id })
    .from(planItems)
    .where(eq(planItems.planVersionId, v1Id));
  if (v1ItemsCount.length === 0) {
    const itemIds = new Map<string, string>();
    let seq = 1;
    const addItem = async (
      key: string,
      itemType: "stage" | "milestone" | "task",
      refId: string,
      name: string,
      ps: number,
      pe: number,
      dependsOn: string[] = [],
    ) => {
      const inserted = await tx
        .insert(planItems)
        .values({
          planVersionId: v1Id,
          itemType,
          refId,
          name,
          plannedStart: fmt(addDays(TODAY, ps)),
          plannedEnd: fmt(addDays(TODAY, pe)),
          seq: seq++,
          dependsOn,
          createdBy: pmId,
        })
        .returning({ id: planItems.id });
      itemIds.set(key, inserted[0].id);
    };
    // 阶段项按序插入：庭审（00003）依赖庭前准备（00002），依赖在插入时成形
    for (const s of aStages) {
      const deps = s.code === `STG-${YEAR}-00003` && itemIds.get(`STG-${YEAR}-00002`)
        ? [itemIds.get(`STG-${YEAR}-00002`)!]
        : [];
      await addItem(s.code, "stage", stageIds.get(s.code)!, s.name, s.ps, s.pe, deps);
    }
    for (const m of aMilestones) {
      await addItem(m.code, "milestone", milestoneIds.get(m.code)!, m.name, m.pd, m.pd);
    }
    // 任务项：证据交换材料核对（00003）依赖证据清单整理（00001）
    for (const t of aTasks) {
      const deps = t.code === `TSK-${YEAR}-00003` && itemIds.get(`TSK-${YEAR}-00001`)
        ? [itemIds.get(`TSK-${YEAR}-00001`)!]
        : [];
      await addItem(t.code, "task", taskIds.get(t.code)!, t.title, t.ps, t.pe, deps);
    }
  }

  // 交付物 ×3
  const aDeliverables = [
    { code: `DLV-${YEAR}-00001`, name: "起诉状", required: true, status: "delivered", deliveredOffset: -7 },
    { code: `DLV-${YEAR}-00002`, name: "证据清单", required: true, status: "delivered", deliveredOffset: -14 },
    { code: `DLV-${YEAR}-00003`, name: "代理词", required: false, status: "pending", deliveredOffset: null },
  ];
  for (const d of aDeliverables) {
    const existing = await tx.select({ id: deliverables.id }).from(deliverables).where(eq(deliverables.code, d.code));
    if (!existing[0]) {
      await tx.insert(deliverables).values({
        projectId: projectAId,
        code: d.code,
        name: d.name,
        required: d.required,
        status: d.status as "pending" | "delivered" | "accepted",
        deliveredAt: d.deliveredOffset === null ? null : addDays(TODAY, d.deliveredOffset).toISOString(),
        deliveredBy: d.deliveredOffset === null ? null : memberId,
        createdBy: pmId,
        updatedBy: pmId,
      });
    }
  }

  // 质量检查项 ×4（项目创建时由模板生成；按 project+name 幂等）
  const aCheckItems = [
    { name: "利益冲突检索", stage: `STG-${YEAR}-00001`, status: "passed", checkedOffset: -20 },
    { name: "案件材料完整性核对", stage: `STG-${YEAR}-00001`, status: "pending", checkedOffset: null },
    { name: "诉讼文书质检", stage: `STG-${YEAR}-00002`, status: "pending", checkedOffset: null },
    { name: "时效核查", stage: `STG-${YEAR}-00002`, status: "passed", checkedOffset: -18 },
  ];
  for (const c of aCheckItems) {
    const existing = await tx
      .select({ id: qualityCheckItems.id })
      .from(qualityCheckItems)
      .where(and(eq(qualityCheckItems.projectId, projectAId), eq(qualityCheckItems.name, c.name)));
    if (!existing[0]) {
      await tx.insert(qualityCheckItems).values({
        projectId: projectAId,
        stageId: stageIds.get(c.stage) ?? null,
        name: c.name,
        status: c.status as "pending" | "passed" | "failed" | "waived",
        checkedBy: c.checkedOffset === null ? null : pmId,
        checkedAt: c.checkedOffset === null ? null : addDays(TODAY, c.checkedOffset).toISOString(),
        createdBy: pmId,
        updatedBy: pmId,
      });
    }
  }

  // 质量问题 ×2（severe 复核中 handler≠reviewer + 对应 events；minor 已关闭 + events）
  const severeExisting = await tx
    .select({ id: qualityIssues.id })
    .from(qualityIssues)
    .where(eq(qualityIssues.code, `QLT-${YEAR}-00001`));
  if (!severeExisting[0]) {
    const inserted = await tx
      .insert(qualityIssues)
      .values({
        projectId: projectAId,
        code: `QLT-${YEAR}-00001`,
        title: "证据链关键证人证言缺口",
        description: "核心证人证言尚未固定，存在证据链断裂风险（种子 severe 示例）",
        severity: "severe",
        status: "pending_review",
        reporterId: pmId,
        handlerId: memberId,
        reviewerId: pmId,
        isBlocking: true,
        createdBy: pmId,
        updatedBy: pmId,
      })
      .returning({ id: qualityIssues.id });
    const issueId = inserted[0].id;
    await tx.insert(qualityIssueEvents).values([
      { issueId, actorId: pmId, action: "create", note: "登记质量问题", createdAt: addDays(TODAY, -6).toISOString() },
      { issueId, actorId: pmId, action: "assign", note: "指派林晓处理，陈立复核", createdAt: addDays(TODAY, -6).toISOString() },
      { issueId, actorId: memberId, action: "handle_submit", note: "已补充证人联系记录，提交复核", createdAt: addDays(TODAY, -2).toISOString() },
    ]);
  }

  const minorExisting = await tx
    .select({ id: qualityIssues.id })
    .from(qualityIssues)
    .where(eq(qualityIssues.code, `QLT-${YEAR}-00002`));
  if (!minorExisting[0]) {
    const inserted = await tx
      .insert(qualityIssues)
      .values({
        projectId: projectAId,
        code: `QLT-${YEAR}-00002`,
        title: "文书格式与编号不规范",
        description: "部分过程文书未按所内模板编号（种子 minor 示例）",
        severity: "minor",
        status: "closed",
        reporterId: pmId,
        handlerId: liuchangId,
        reviewerId: pmId,
        rootCause: "使用旧版模板",
        isBlocking: false,
        closedAt: addDays(TODAY, -4).toISOString(),
        createdBy: pmId,
        updatedBy: pmId,
      })
      .returning({ id: qualityIssues.id });
    const issueId = inserted[0].id;
    await tx.insert(qualityIssueEvents).values([
      { issueId, actorId: pmId, action: "create", note: "登记质量问题", createdAt: addDays(TODAY, -9).toISOString() },
      { issueId, actorId: pmId, action: "assign", note: "指派刘畅处理", createdAt: addDays(TODAY, -9).toISOString() },
      { issueId, actorId: liuchangId, action: "handle_submit", note: "已按新模板重排编号", createdAt: addDays(TODAY, -5).toISOString() },
      { issueId, actorId: pmId, action: "review_pass", note: "复核通过，关闭", createdAt: addDays(TODAY, -4).toISOString() },
    ]);
  }

  // 决策 ×1（deciding 态，双意见其一已填）
  const decisionExisting = await tx
    .select({ id: decisions.id })
    .from(decisions)
    .where(eq(decisions.code, `DEC-${YEAR}-00001`));
  if (!decisionExisting[0]) {
    await tx.insert(decisions).values({
      projectId: projectAId,
      code: `DEC-${YEAR}-00001`,
      title: "是否申请财产保全",
      context: "对方当事人存在转移资产迹象，需在起诉前决定是否申请诉前财产保全（种子决策示例）",
      options: [
        { key: "other", summary: "申请诉前财产保全", impact: "增加保全费用与担保资金占用", risk: "保全错误需承担赔偿责任" },
        { key: "risk_accept", summary: "不申请保全，加速立案", impact: "节省成本", risk: "判决后执行难度显著上升" },
      ],
      pmOpinion: "倾向申请诉前保全：对方近期有大额资金异动记录，执行风险高于保全成本。",
      status: "deciding",
      createdBy: pmId,
      updatedBy: pmId,
    });
  }

  // 周报 ×1（confirmed，上周期间）
  const reportExisting = await tx
    .select({ id: weeklyReports.id })
    .from(weeklyReports)
    .where(eq(weeklyReports.code, `RPT-${YEAR}-00001`));
  if (!reportExisting[0]) {
    const mondayThisWeek = addDays(TODAY, -((TODAY.getUTCDay() + 6) % 7));
    const periodStart = addDays(mondayThisWeek, -7);
    const periodEnd = addDays(mondayThisWeek, -1);
    await tx.insert(weeklyReports).values({
      projectId: projectAId,
      code: `RPT-${YEAR}-00001`,
      periodStart: fmt(periodStart),
      periodEnd: fmt(periodEnd),
      versionNo: 1,
      status: "confirmed",
      content: {
        progress: "完成证据清单整理与起诉状起草，已进入庭前准备阶段。",
        tasks: "证据交换材料核对临期；庭前会议提纲已逾期需跟进。",
        quality: "severe 问题「证据链关键证人证言缺口」待复核；minor 问题已关闭。",
        decisions: "财产保全决策处于 deciding，待质量负责人意见。",
        risks: "证人证言固定进度为当前主要风险。",
        next_week: "完成庭前会议提纲与代理意见初稿。",
      },
      confirmedBy: pmId,
      confirmedAt: addDays(mondayThisWeek, 0).toISOString(),
      createdBy: pmId,
      updatedBy: pmId,
    });
  }

  /* ===== 项目 B 最小结构（PRJ-2026-00002）：v1 基线 + 2 阶段 + 3 任务 ===== */

  const bStages = [
    { code: `STG-${YEAR}-00005`, name: "顾问需求梳理", seq: 1, ps: -10, pe: -1, as: -10, status: "active" },
    { code: `STG-${YEAR}-00006`, name: "日常服务执行", seq: 2, ps: 0, pe: 30, as: null, status: "pending" },
  ];
  const bStageIds = new Map<string, string>();
  for (const s of bStages) {
    const existing = await tx.select({ id: stages.id }).from(stages).where(eq(stages.code, s.code));
    if (!existing[0]) {
      await tx.insert(stages).values({
        projectId: projectBId,
        code: s.code,
        name: s.name,
        seq: s.seq,
        plannedStart: fmt(addDays(TODAY, s.ps)),
        plannedEnd: fmt(addDays(TODAY, s.pe)),
        actualStart: s.as === null ? null : fmt(addDays(TODAY, s.as)),
        status: s.status as "pending" | "active" | "done",
        createdBy: pmId,
        updatedBy: pmId,
      });
    }
    const row = await tx.select({ id: stages.id }).from(stages).where(eq(stages.code, s.code));
    bStageIds.set(s.code, row[0].id);
  }

  const bTasks = [
    { code: `TSK-${YEAR}-00009`, title: "服务台账建立", stage: `STG-${YEAR}-00005`, ps: -10, pe: -5, status: "done", completedOffset: -5 },
    { code: `TSK-${YEAR}-00010`, title: "合同审查流程梳理", stage: `STG-${YEAR}-00005`, ps: -2, pe: 8, status: "in_progress", completedOffset: null },
    { code: `TSK-${YEAR}-00011`, title: "月度法律顾问简报", stage: `STG-${YEAR}-00006`, ps: 9, pe: 20, status: "pending", completedOffset: null },
  ];
  const bTaskIds = new Map<string, string>();
  for (const t of bTasks) {
    const existing = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.code, t.code));
    if (!existing[0]) {
      await tx.insert(tasks).values({
        projectId: projectBId,
        stageId: bStageIds.get(t.stage) ?? null,
        code: t.code,
        title: t.title,
        assigneeId: xubinId,
        plannedStart: fmt(addDays(TODAY, t.ps)),
        plannedEnd: fmt(addDays(TODAY, t.pe)),
        status: t.status as "pending" | "in_progress" | "done" | "cancelled",
        actualStart: t.completedOffset === null ? null : fmt(addDays(TODAY, t.ps)),
        actualEnd: t.completedOffset === null ? null : addDays(TODAY, t.completedOffset).toISOString(),
        completedAt: t.completedOffset === null ? null : addDays(TODAY, t.completedOffset).toISOString(),
        createdBy: pmId,
        updatedBy: pmId,
      });
    }
    const row = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.code, t.code));
    bTaskIds.set(t.code, row[0].id);
  }

  const bV1Existing = await tx
    .select({ id: planVersions.id })
    .from(planVersions)
    .where(and(eq(planVersions.projectId, projectBId), eq(planVersions.versionNo, 1)));
  let bV1Id = bV1Existing[0]?.id;
  if (!bV1Id) {
    const inserted = await tx
      .insert(planVersions)
      .values({
        projectId: projectBId,
        versionNo: 1,
        kind: "baseline",
        status: "active",
        notes: "初始基线计划（种子）",
        createdBy: pmId,
        updatedBy: pmId,
      })
      .returning({ id: planVersions.id });
    bV1Id = inserted[0].id;
  }
  const bV1ItemsCount = await tx
    .select({ id: planItems.id })
    .from(planItems)
    .where(eq(planItems.planVersionId, bV1Id));
  if (bV1ItemsCount.length === 0) {
    let seq = 1;
    for (const s of bStages) {
      await tx.insert(planItems).values({
        planVersionId: bV1Id,
        itemType: "stage",
        refId: bStageIds.get(s.code)!,
        name: s.name,
        plannedStart: fmt(addDays(TODAY, s.ps)),
        plannedEnd: fmt(addDays(TODAY, s.pe)),
        seq: seq++,
        createdBy: pmId,
      });
    }
    for (const t of bTasks) {
      await tx.insert(planItems).values({
        planVersionId: bV1Id,
        itemType: "task",
        refId: bTaskIds.get(t.code)!,
        name: t.title,
        plannedStart: fmt(addDays(TODAY, t.ps)),
        plannedEnd: fmt(addDays(TODAY, t.pe)),
        seq: seq++,
        createdBy: pmId,
      });
    }
  }

  // file_objects 存量行来源回填（arch/04 §2.1：迭代 0 遗留行允许为 null，种子回填为挂载项目 A）
  await tx.execute(
    sql`UPDATE file_objects SET source_type = 'project', source_id = ${projectAId} WHERE source_type IS NULL`,
  );

  // 编号序列水位对齐到治理种子最大序号（防 next_code 撞号）
  const floors: Array<[string, number]> = [
    ["STG", 7],
    ["MLS", 4],
    ["TSK", 12],
    ["DLV", 4],
    ["QLT", 3],
    ["DEC", 2],
    ["RPT", 2],
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
