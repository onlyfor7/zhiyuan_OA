import { and, eq, sql } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import {
  archiveDirectories,
  paymentReceipts,
  changeRequests,
  decisions,
  planItems,
  planVersions,
  projectMembers,
  projectTemplates,
  projects,
  qualityCheckItems,
  qualityIssues,
  stages,
  tasks,
  users,
  weeklyReports,
} from "../../db/schema";
import { nextCode } from "../../db/code";
import { BusinessError } from "../../lib/errors";
import { can } from "../../services/access";
import { recordAudit } from "../../services/audit";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { nowIso } from "./util";
import { aggregateProject } from "../../services/ledger/record";
import { canFinanceSummary } from "../finance/budget";
import { notify } from "../notify";

/**
 * 项目域 service（arch/04 §5 project.*）：
 * create（模板事务：阶段/检查项/十一目录/基线 v1 及 items）、overview 聚合、
 * 成员管理、close 结项检查单（阻断/警告）。
 */

/** 需求基线 §12.1 固定十一目录（arch/04 §2.8：项目创建时生成，不随模板） */
const ARCHIVE_DIRECTORIES: Array<{ dirKey: string; name: string; seq: number }> = [
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

interface TemplateStage {
  name: string;
  seq: number;
  /** 阶段时长（天），默认 14（arch/04 §2.10 v1.2 冻结键名） */
  days?: number;
}
interface TemplateCheckItem {
  name: string;
  required?: boolean;
  stageSeq?: number;
}
interface TemplateTask {
  name: string;
  stageSeq: number;
  /** 相对阶段开始日的偏移（默认 0） */
  offsetDays?: number;
  /** 任务时长（天，默认 7）；planned_end = planned_start + durationDays */
  durationDays?: number;
  /** 项目内角色：解析为该项目首个该角色成员，否则未分配 */
  assigneeRole?: string;
}

export interface CreateProjectInput {
  templateId: string;
  matterId: string;
  name: string;
  type?: string;
  confidentialityLevel?: "public" | "internal" | "confidential" | "secret";
  startDate: string; // YYYY-MM-DD，模板阶段按 2 周/阶段顺排
  /** 指定负责人（09c 打回修复）：缺省=创建人；指定时成员表同事务对齐——managerId 恰为唯一 manager 行，创建人降为 member */
  managerId?: string;
}

export async function createProject(
  db: DbOrTx,
  user: SessionUser,
  input: CreateProjectInput,
  ip: string | null,
  sessionId: string | null,
): Promise<{ id: string; code: string }> {
  // 立项权限门（arch/02 §4.1 v1.2 冻结）：project.manage 动作授权 = partner/sysadmin，
  // 其余角色统一 403/404 同形（无泄露语义）；立项权归属为律所确认项（§18），当前为开发期默认
  if (!user.globalRoles.includes("partner") && !user.globalRoles.includes("sysadmin")) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "无立项权限");
  }
  const [template] = await db
    .select()
    .from(projectTemplates)
    .where(and(eq(projectTemplates.id, input.templateId), eq(projectTemplates.enabled, true)))
    .limit(1);
  if (!template) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "项目模板不存在或已停用", {
      templateId: ["项目模板不存在或已停用"],
    });
  }

  // 指定负责人须为在职用户（成员表同事务对齐的前提；不存在/停用 → 4xx 不泄 500）
  const managerId = input.managerId ?? user.id;
  if (input.managerId) {
    const [mgr] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, input.managerId), eq(users.status, "active")))
      .limit(1);
    if (!mgr) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "负责人不存在或已停用", {
        managerId: ["负责人不存在或已停用"],
      });
    }
  }

  const project = await instantiateProjectFromTemplate(db, user.id, {
    matterId: input.matterId,
    name: input.name,
    type: input.type,
    managerId,
    confidentialityLevel: input.confidentialityLevel,
    template,
    startDate: input.startDate,
  });

  // 创建人≠负责人时创建人落 member（降级语义），保证后续 transferManager 双向可还原
  if (managerId !== user.id) {
    await db
      .insert(projectMembers)
      .values({ projectId: project.id, userId: user.id, projectRole: "member" })
      .onConflictDoNothing();
  }

  await recordAudit(db, {
    actorId: user.id,
    sessionId,
    action: "project.create",
    targetType: "project",
    targetId: project.id,
    result: "success",
    afterJson: { code: project.code, templateId: input.templateId, matterId: input.matterId },
    ip,
  });

  return project;
}

/**
 * 模板实例化核心（arch/13 §5.3 D5 复用点）：项目行 + 成员(manager 恰一行) + 基线 v1 计划/阶段/任务/检查项 + 十一档案目录。
 * 供 project.create 与 CRM 商机即立项同事务复用——权限门/校验/审计由调用方承载；任一步失败随调用方事务整体回滚。
 */
export async function instantiateProjectFromTemplate(
  db: DbOrTx,
  actorId: string,
  input: {
    matterId: string;
    name: string;
    type?: string;
    managerId: string;
    confidentialityLevel?: "public" | "internal" | "confidential" | "secret";
    template: typeof projectTemplates.$inferSelect;
    startDate: string;
  },
): Promise<{ id: string; code: string }> {
  const projectCode = await nextCode("PRJ", db);
  const [project] = await db
    .insert(projects)
    .values({
      code: projectCode,
      matterId: input.matterId,
      name: input.name,
      type: input.type ?? "",
      managerId: input.managerId,
      confidentialityLevel: input.confidentialityLevel ?? "internal",
      lifecycleStatus: "preparing",
      healthStatus: "normal",
      createdBy: actorId,
      updatedBy: actorId,
    })
    .returning({ id: projects.id, code: projects.code });
  if (!project) throw new Error("项目插入失败");

  // 成员表与 manager_id 同事务对齐（09c 打回修复语义）：恰一条 manager 行
  await db
    .insert(projectMembers)
    .values({ projectId: project.id, userId: input.managerId, projectRole: "manager" })
    .onConflictDoNothing();

  await instantiateTemplatePlan(db, actorId, project.id, input.template, input.startDate, `模板「${input.template.name}」初始基线`);

  // 固定十一档案目录
  for (const dir of ARCHIVE_DIRECTORIES) {
    await db.insert(archiveDirectories).values({ projectId: project.id, ...dir });
  }

  return project;
}

/**
 * 模板计划实例化（plan v1 + 阶段 + 任务 + 检查项 + plan_items；arch/04 §2.10 冻结规则）。
 * 供项目创建与 crm.opportunities.ensureProjectPlan（存量项目补建售前计划）复用；幂等由调用方先查 v1。
 */
export async function instantiateTemplatePlan(
  db: DbOrTx,
  actorId: string,
  projectId: string,
  template: typeof projectTemplates.$inferSelect,
  startDate: string,
  notes: string,
): Promise<{ planVersionId: string }> {
  const structure = template.structureJson as {
    stages?: TemplateStage[];
    checkItems?: TemplateCheckItem[];
    tasks?: TemplateTask[];
  };

  const [v1] = await db
    .insert(planVersions)
    .values({
      projectId,
      versionNo: 1,
      kind: "baseline",
      status: "active",
      notes,
      createdBy: actorId,
      updatedBy: actorId,
    })
    .returning({ id: planVersions.id });
  if (!v1) throw new Error("计划版本插入失败");

  let seq = 0;
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const addDays = (base: Date, days: number) => {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + days);
    return d;
  };
  const createdStages: Array<{ id: string; seq: number; start: Date; end: Date }> = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  for (const s of (structure.stages ?? []).slice().sort((a, b) => a.seq - b.seq)) {
    const days = s.days ?? 14;
    const ps = new Date(cursor);
    const pe = addDays(ps, days - 1);
    cursor.setUTCDate(cursor.getUTCDate() + days);
    const code = await nextCode("STG", db);
    const [stage] = await db
      .insert(stages)
      .values({
        projectId,
        code,
        name: s.name,
        seq: s.seq,
        plannedStart: fmt(ps),
        plannedEnd: fmt(pe),
        status: "pending",
        createdBy: actorId,
        updatedBy: actorId,
      })
      .returning({ id: stages.id });
    createdStages.push({ id: stage.id, seq: s.seq, start: ps, end: pe });
    await db.insert(planItems).values({
      planVersionId: v1.id,
      itemType: "stage",
      refId: stage.id,
      name: s.name,
      plannedStart: fmt(ps),
      plannedEnd: fmt(pe),
      seq: ++seq,
      createdBy: actorId,
    });
  }

  // 模板任务（arch/04 §2.10 v1.2 冻结规则）：落入对应阶段区间生成真实任务，并写入 v1 plan_items
  const stageBySeq = new Map(createdStages.map((s) => [s.seq, s]));
  for (const taskDef of structure.tasks ?? []) {
    const stage = stageBySeq.get(taskDef.stageSeq);
    if (!stage) {
      throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "模板任务引用了不存在的阶段", {
        tasks: [`stageSeq=${taskDef.stageSeq} 不存在`],
      });
    }
    const offsetDays = taskDef.offsetDays ?? 0;
    const durationDays = taskDef.durationDays ?? 7;
    const ps = addDays(stage.start, offsetDays);
    const pe = addDays(ps, durationDays);
    let assigneeId: string | null = null;
    if (taskDef.assigneeRole) {
      const candidate = await db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.projectRole, taskDef.assigneeRole)))
        .orderBy(projectMembers.joinedAt)
        .limit(1);
      assigneeId = candidate[0]?.userId ?? null;
    }
    const taskCode = await nextCode("TSK", db);
    const [taskRow] = await db
      .insert(tasks)
      .values({
        projectId,
        stageId: stage.id,
        code: taskCode,
        title: taskDef.name,
        assigneeId,
        plannedStart: fmt(ps),
        plannedEnd: fmt(pe),
        status: "pending",
        createdBy: actorId,
        updatedBy: actorId,
      })
      .returning({ id: tasks.id });
    await db.insert(planItems).values({
      planVersionId: v1.id,
      itemType: "task",
      refId: taskRow.id,
      name: taskDef.name,
      plannedStart: fmt(ps),
      plannedEnd: fmt(pe),
      seq: ++seq,
      createdBy: actorId,
    });
  }

  // 模板检查项
  for (const item of structure.checkItems ?? []) {
    const stageRow = item.stageSeq !== undefined ? stageBySeq.get(item.stageSeq) : undefined;
    await db.insert(qualityCheckItems).values({
      projectId,
      stageId: stageRow?.id ?? null,
      name: item.name,
      required: item.required ?? true,
      createdBy: actorId,
      updatedBy: actorId,
    });
  }

  return { planVersionId: v1.id };
}

export interface UpdateProjectInput {
  id: string;
  rowVersion: number;
  name?: string;
  type?: string;
  healthStatus?: "normal" | "warning" | "at_risk";
}

export async function updateProject(
  db: DbOrTx,
  user: SessionUser,
  input: UpdateProjectInput,
): Promise<void> {
  const allowed = await can(db, user, "project.manage", { type: "project", projectId: input.id });
  if (!allowed) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "项目不存在或无权访问");
  const updated = await db
    .update(projects)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.healthStatus !== undefined ? { healthStatus: input.healthStatus } : {}),
      updatedBy: user.id,
      updatedAt: nowIso(),
      rowVersion: sql`${projects.rowVersion} + 1`,
    })
    .where(and(eq(projects.id, input.id), eq(projects.rowVersion, input.rowVersion)))
    .returning({ id: projects.id });
  if (!updated[0]) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  }
}

export async function projectOverview(db: DbOrTx, user: SessionUser, projectId: string) {
  const allowed = await can(db, user, "project.read", { type: "project", projectId });
  if (!allowed) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "项目不存在或无权访问");

  const [taskCounts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      pending: sql<number>`count(*) filter (where ${tasks.status} = 'pending')::int`,
      inProgress: sql<number>`count(*) filter (where ${tasks.status} = 'in_progress')::int`,
      done: sql<number>`count(*) filter (where ${tasks.status} = 'done')::int`,
      overdue: sql<number>`count(*) filter (where ${tasks.status} in ('pending','in_progress') and ${tasks.plannedEnd} < current_date)::int`,
    })
    .from(tasks)
    .where(eq(tasks.projectId, projectId));

  const [quality] = await db
    .select({
      open: sql<number>`count(*) filter (where ${qualityIssues.status} <> 'closed')::int`,
      blocking: sql<number>`count(*) filter (where ${qualityIssues.isBlocking})::int`,
    })
    .from(qualityIssues)
    .where(eq(qualityIssues.projectId, projectId));

  const [decisionsPending] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(decisions)
    .where(and(eq(decisions.projectId, projectId), eq(decisions.status, "deciding")));

  const [reports] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(weeklyReports)
    .where(eq(weeklyReports.projectId, projectId));

  const [members] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId));

  const [pendingApprovals] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(changeRequests)
    .where(and(eq(changeRequests.projectId, projectId), eq(changeRequests.status, "pending_approval")));

  const [project] = await db
    .select({
      lifecycleStatus: projects.lifecycleStatus,
      healthStatus: projects.healthStatus,
      rowVersion: projects.rowVersion,
      archivedAt: projects.archivedAt,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  // 财务摘要（arch/06 §8）+ 收款摘要（arch/09 §2）：仅 pm/partner/finance 可见；成员默认不见（E2E-12）
  let budgetSummary: Awaited<ReturnType<typeof aggregateProject>> | null = null;
  let receiptSummary: { registeredCents: number; voidedCents: number; netCents: number } | null = null;
  if (canFinanceSummary(user, projectId)) {
    budgetSummary = await aggregateProject(db, projectId);
    const [receiptRow] = await db
      .select({
        registered: sql<number>`coalesce(sum(${paymentReceipts.amountCents}) filter (where ${paymentReceipts.status} = 'registered'), 0)::float8`,
        voided: sql<number>`coalesce(sum(${paymentReceipts.amountCents}) filter (where ${paymentReceipts.status} = 'voided'), 0)::float8`,
      })
      .from(paymentReceipts)
      .where(eq(paymentReceipts.projectId, projectId));
    receiptSummary = {
      registeredCents: Number(receiptRow.registered),
      voidedCents: Number(receiptRow.voided),
      netCents: Number(receiptRow.registered) - Number(receiptRow.voided),
    };
  }

  return {
    project: project ?? null,
    tasks: taskCounts,
    quality,
    decisionsPending: decisionsPending.n,
    reports: reports.n,
    members: members.n,
    pendingApprovals: pendingApprovals.n,
    myRole: user.projectRoles.get(projectId) ?? null,
    budgetSummary,
    receiptSummary,
  };
}

/* ===== 成员管理（project.manage） ===== */

async function requireManage(db: DbOrTx, user: SessionUser, projectId: string): Promise<void> {
  const allowed = await can(db, user, "project.manage", { type: "project", projectId });
  if (!allowed) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "项目不存在或无权管理");
}

export async function addMember(
  db: DbOrTx,
  user: SessionUser,
  projectId: string,
  memberUserId: string,
  projectRole: string,
): Promise<void> {
  await requireManage(db, user, projectId);
  await db
    .insert(projectMembers)
    .values({ projectId, userId: memberUserId, projectRole })
    .onConflictDoNothing();
}

export async function updateMember(
  db: DbOrTx,
  user: SessionUser,
  projectId: string,
  memberUserId: string,
  projectRole: string,
): Promise<void> {
  await requireManage(db, user, projectId);
  const updated = await db
    .update(projectMembers)
    .set({ projectRole })
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, memberUserId)))
    .returning({ userId: projectMembers.userId });
  if (!updated[0]) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "成员不存在");
}

export async function removeMember(
  db: DbOrTx,
  user: SessionUser,
  projectId: string,
  memberUserId: string,
): Promise<void> {
  await requireManage(db, user, projectId);
  // 项目负责人不可移除自己（须先经 project.transferManager 变更负责人，D3 裁定 迭代6-09）
  const project = await db
    .select({ managerId: projects.managerId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (project[0]?.managerId === memberUserId) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "项目负责人不可直接移除，请先变更负责人");
  }
  await db
    .delete(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, memberUserId)));
}

/* ===== 负责人变更（D3 裁定 迭代6-09：partner/sysadmin 可变更，审批解析按当前 manager_id 运行时读取） ===== */

export async function transferManager(
  db: DbOrTx,
  user: SessionUser,
  input: { projectId: string; newManagerId: string; reason: string },
  ip: string | null,
  sessionId: string | null,
): Promise<{ projectId: string; managerId: string; formerManagerId: string }> {
  // partner/sysadmin 门；与 project.manage（项目内 manager 职能）分离的运维动作
  const allowed = user.globalRoles.includes("partner") || user.globalRoles.includes("sysadmin");
  if (!allowed) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "项目不存在或无权访问");
  const [project] = await db
    .select({ id: projects.id, code: projects.code, managerId: projects.managerId })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);
  if (!project) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "项目不存在或无权访问");
  if (project.managerId === input.newManagerId) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "新负责人与现任负责人相同");
  }
  const reason = input.reason.trim();
  if (!reason) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "变更原因必填", { reason: ["变更原因必填"] });
  // 新负责人必须是项目成员
  const [membership] = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, input.projectId), eq(projectMembers.userId, input.newManagerId)))
    .limit(1);
  if (!membership) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "新负责人必须是项目成员", {
      newManagerId: ["新负责人必须是项目成员"],
    });
  }
  const formerManagerId = project.managerId;

  // 同事务：manager_id 更新 + 成员角色迁移（旧负责人降级 member、新负责人升级 manager）
  await db
    .update(projects)
    .set({
      managerId: input.newManagerId,
      updatedBy: user.id,
      updatedAt: nowIso(),
      rowVersion: sql`${projects.rowVersion} + 1`,
    })
    .where(eq(projects.id, input.projectId));
  await db
    .update(projectMembers)
    .set({ projectRole: "member" })
    .where(and(eq(projectMembers.projectId, input.projectId), eq(projectMembers.userId, formerManagerId)));
  await db
    .update(projectMembers)
    .set({ projectRole: "manager" })
    .where(and(eq(projectMembers.projectId, input.projectId), eq(projectMembers.userId, input.newManagerId)));
  await recordAudit(db, {
    actorId: user.id,
    sessionId,
    action: "project.transferManager",
    targetType: "project",
    targetId: input.projectId,
    result: "success",
    beforeJson: { managerId: formerManagerId },
    afterJson: { managerId: input.newManagerId, reason },
    ip,
  });
  // 通知新旧负责人（D3：通知（新旧负责人））
  for (const [recipientId, role] of [[input.newManagerId, "new"], [formerManagerId, "former"]] as const) {
    await notify(db, {
      eventType: "manager_transferred",
      recipientId,
      sourceType: "project",
      sourceId: input.projectId,
      payload: {
        projectId: input.projectId,
        projectCode: project.code,
        fromManagerId: formerManagerId,
        toManagerId: input.newManagerId,
        reason,
        role,
      },
    });
  }
  return { projectId: input.projectId, managerId: input.newManagerId, formerManagerId };
}

/* ===== 结项检查（arch/04 §5 project.close） ===== */

export interface CloseCheckResult {
  closed: boolean;
  blockers: string[];
  warnings: string[];
  checklist: Array<{ key: string; label: string; level: "blocker" | "warning" | "ok"; detail: string }>;
}

export async function closeProject(
  db: DbOrTx,
  user: SessionUser,
  projectId: string,
  rowVersion: number,
): Promise<CloseCheckResult> {
  const allowed = await can(db, user, "project.manage", { type: "project", projectId });
  if (!allowed) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "项目不存在或无权管理");

  const checklist: CloseCheckResult["checklist"] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  const blockingQuality = await db
    .select({ code: qualityIssues.code, title: qualityIssues.title })
    .from(qualityIssues)
    .where(and(eq(qualityIssues.projectId, projectId), eq(qualityIssues.isBlocking, true)));
  if (blockingQuality.length > 0) {
    const detail = blockingQuality.map((q) => `${q.code} ${q.title}`).join("；");
    blockers.push(`未关闭的严重质量问题：${detail}`);
    checklist.push({ key: "quality_blocking", label: "阻断质量问题", level: "blocker", detail });
  } else {
    checklist.push({ key: "quality_blocking", label: "阻断质量问题", level: "ok", detail: "无" });
  }

  const openTasks = await db
    .select({ code: tasks.code, title: tasks.title })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), sql`${tasks.status} in ('pending', 'in_progress')`));
  if (openTasks.length > 0) {
    const detail = openTasks.map((t) => `${t.code} ${t.title}`).join("；");
    warnings.push(`未完成任务 ${openTasks.length} 项：${detail}`);
    checklist.push({ key: "open_tasks", label: "未完成任务", level: "warning", detail });
  } else {
    checklist.push({ key: "open_tasks", label: "未完成任务", level: "ok", detail: "无" });
  }

  const unarchivedReports = await db
    .select({ code: weeklyReports.code })
    .from(weeklyReports)
    .where(and(eq(weeklyReports.projectId, projectId), eq(weeklyReports.status, "confirmed")));
  if (unarchivedReports.length > 0) {
    const detail = unarchivedReports.map((r) => r.code).join("；");
    warnings.push(`未归档周报 ${unarchivedReports.length} 份：${detail}`);
    checklist.push({ key: "unarchived_reports", label: "未归档周报", level: "warning", detail });
  } else {
    checklist.push({ key: "unarchived_reports", label: "未归档周报", level: "ok", detail: "无" });
  }

  if (blockers.length > 0) {
    return { closed: false, blockers, warnings, checklist };
  }

  const updated = await db
    .update(projects)
    .set({
      lifecycleStatus: "closed",
      archivedAt: nowIso(),
      updatedBy: user.id,
      updatedAt: nowIso(),
      rowVersion: sql`${projects.rowVersion} + 1`,
    })
    .where(and(eq(projects.id, projectId), eq(projects.rowVersion, rowVersion)))
    .returning({ id: projects.id });
  if (!updated[0]) {
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
  }

  return { closed: true, blockers, warnings, checklist };
}

export async function listTemplates(db: DbOrTx) {
  return db
    .select({
      id: projectTemplates.id,
      name: projectTemplates.name,
      description: projectTemplates.description,
      structureJson: projectTemplates.structureJson,
    })
    .from(projectTemplates)
    .where(eq(projectTemplates.enabled, true))
    .orderBy(projectTemplates.name);
}

/**
 * 财务域项目参照清单（arch/12 §20.4）：finance/partner 项目下拉数据源（最小字段，无业务内容）；
 * 与 receipts.projectOptions 同口径双胞胎（收款登记下拉）——其他角色同形 404。
 */
export async function financeOptions(db: DbOrTx, user: SessionUser) {
  if (!(user.globalRoles.includes("finance") || user.globalRoles.includes("partner"))) {
    throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "财务项目清单不存在或无权访问");
  }
  return db
    .select({ id: projects.id, code: projects.code, name: projects.name })
    .from(projects)
    .orderBy(projects.code);
}
