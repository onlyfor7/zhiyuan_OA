import { eq, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";

import * as schema from "../schema";
import { approvalPolicies, meetings, projects, tasks, timeEntries, timesheetPeriods, travelRequests, users } from "../schema";

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
/** 本周周一（周期 A）；上周周一 = addDays(mondayThisWeek, -7)（周期 B/C） */
const MONDAY_THIS_WEEK = addDays(TODAY, -((TODAY.getUTCDay() + 6) % 7));
const SUNDAY_THIS_WEEK = addDays(MONDAY_THIS_WEEK, 6);
const MONDAY_LAST_WEEK = addDays(MONDAY_THIS_WEEK, -7);
const SUNDAY_LAST_WEEK = addDays(MONDAY_THIS_WEEK, -1);

async function userIdByEmail(tx: SeedTx, email: string): Promise<string> {
  const row = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!row[0]) throw new Error(`种子依赖用户 ${email} 缺失`);
  return row[0].id;
}

async function idByCode<T extends { id: string }>(
  tx: SeedTx,
  select: Promise<T[]>,
): Promise<string | null> {
  const row = await select;
  return row[0]?.id ?? null;
}

export async function seedTime(tx: SeedTx): Promise<void> {
  const pmId = await userIdByEmail(tx, "pm@lexflow.demo");
  const memberId = await userIdByEmail(tx, "member@lexflow.demo");
  const partnerId = await userIdByEmail(tx, "partner@lexflow.demo");

  const projectAId = (await idByCode(tx, tx.select({ id: projects.id }).from(projects).where(eq(projects.code, `PRJ-${YEAR}-00001`))))!;
  const task3Id = await idByCode(tx, tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.code, `TSK-${YEAR}-00003`)));
  const task4Id = await idByCode(tx, tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.code, `TSK-${YEAR}-00004`)));
  const meeting2Id = await idByCode(tx, tx.select({ id: meetings.id }).from(meetings).where(eq(meetings.code, `MTG-${YEAR}-00002`)));
  const travel1Id = await idByCode(tx, tx.select({ id: travelRequests.id }).from(travelRequests).where(eq(travelRequests.code, `TRV-${YEAR}-00001`)));

  // 审批策略：timesheet 默认（approver 由 arch/07 §4.2 运行时解析，steps_json 为占位说明）
  const policyExisting = await tx
    .select({ id: approvalPolicies.id })
    .from(approvalPolicies)
    .where(eq(approvalPolicies.bizType, "timesheet"));
  if (!policyExisting[0]) {
    await tx.insert(approvalPolicies).values({
      bizType: "timesheet",
      priority: 100,
      matchJson: {},
      stepsJson: [
        {
          runtime_resolve: true,
          note: "approver 由 arch/07 §4.2 运行时解析：申请人含 project_manager 角色→partner（不得自审）；否则→该周期分钟数最多项目的 manager；无项目明细→timesheet.default_approver 配置",
        },
      ],
      description: "工时周期提交（默认；审批人运行时解析，策略行占位）",
      createdBy: pmId,
      updatedBy: pmId,
    });
  }

  /* ===== 周期 A：member 本周 draft（4 明细：专业工作×2/会议×1（prefill 样例）/出差×1） ===== */

  const aCode = `TS-${YEAR}-00001`;
  const aExisting = await tx.select({ id: timesheetPeriods.id }).from(timesheetPeriods).where(eq(timesheetPeriods.code, aCode));
  if (!aExisting[0]) {
    const period = await tx
      .insert(timesheetPeriods)
      .values({
        code: aCode,
        userId: memberId,
        periodType: "weekly",
        periodStart: fmt(MONDAY_THIS_WEEK),
        periodEnd: fmt(SUNDAY_THIS_WEEK),
        status: "draft",
        createdBy: memberId,
        updatedBy: memberId,
      })
      .returning({ id: timesheetPeriods.id });
    const periodId = period[0].id;
    await tx.insert(timeEntries).values([
      {
        periodId,
        userId: memberId,
        projectId: projectAId,
        taskId: task3Id,
        activityType: "professional_work",
        workDate: fmt(addDays(MONDAY_THIS_WEEK, 0)),
        durationMinutes: 480,
        description: "证据交换材料核对",
        source: "manual",
        createdBy: memberId,
        updatedBy: memberId,
      },
      {
        periodId,
        userId: memberId,
        projectId: projectAId,
        taskId: task4Id,
        activityType: "professional_work",
        workDate: fmt(addDays(MONDAY_THIS_WEEK, 1)),
        durationMinutes: 360,
        description: "庭前会议提纲",
        source: "manual",
        createdBy: memberId,
        updatedBy: memberId,
      },
      {
        periodId,
        userId: memberId,
        projectId: projectAId,
        meetingId: meeting2Id,
        activityType: "meeting",
        workDate: fmt(addDays(MONDAY_THIS_WEEK, 2)),
        durationMinutes: 120,
        description: "项目周会（预填草稿样例，未提交不计有效工时）",
        source: "prefill_meeting",
        createdBy: memberId,
        updatedBy: memberId,
      },
      {
        periodId,
        userId: memberId,
        projectId: projectAId,
        travelId: travel1Id,
        activityType: "travel",
        workDate: fmt(addDays(MONDAY_THIS_WEEK, 2)),
        durationMinutes: 300,
        description: "杭州出差证据调取",
        source: "manual",
        createdBy: memberId,
        updatedBy: memberId,
      },
    ]);
  }

  /* ===== 周期 B：member 上周 approved（6 明细；approver=pm，按 §4.2 主项目 manager） ===== */

  const bCode = `TS-${YEAR}-00002`;
  const bExisting = await tx.select({ id: timesheetPeriods.id }).from(timesheetPeriods).where(eq(timesheetPeriods.code, bCode));
  if (!bExisting[0]) {
    const period = await tx
      .insert(timesheetPeriods)
      .values({
        code: bCode,
        userId: memberId,
        periodType: "weekly",
        periodStart: fmt(MONDAY_LAST_WEEK),
        periodEnd: fmt(SUNDAY_LAST_WEEK),
        status: "approved",
        approverId: pmId,
        submittedAt: addDays(MONDAY_THIS_WEEK, -1).toISOString(),
        approvedAt: addDays(MONDAY_THIS_WEEK, -1).toISOString(),
        createdBy: memberId,
        updatedBy: pmId,
      })
      .returning({ id: timesheetPeriods.id });
    const periodId = period[0].id;
    await tx.insert(timeEntries).values([
      { periodId, userId: memberId, projectId: projectAId, taskId: task3Id, activityType: "professional_work", workDate: fmt(addDays(MONDAY_LAST_WEEK, 0)), durationMinutes: 420, description: "证据清单整理", source: "manual", createdBy: memberId, updatedBy: memberId },
      { periodId, userId: memberId, projectId: projectAId, taskId: task4Id, activityType: "professional_work", workDate: fmt(addDays(MONDAY_LAST_WEEK, 1)), durationMinutes: 360, description: "庭前会议提纲", source: "manual", createdBy: memberId, updatedBy: memberId },
      { periodId, userId: memberId, projectId: projectAId, activityType: "professional_work", workDate: fmt(addDays(MONDAY_LAST_WEEK, 2)), durationMinutes: 300, description: "起诉状修订", source: "manual", createdBy: memberId, updatedBy: memberId },
      { periodId, userId: memberId, projectId: projectAId, meetingId: meeting2Id, activityType: "meeting", workDate: fmt(addDays(MONDAY_LAST_WEEK, 3)), durationMinutes: 120, description: "项目周会", source: "manual", createdBy: memberId, updatedBy: memberId },
      { periodId, userId: memberId, projectId: projectAId, travelId: travel1Id, activityType: "travel", workDate: fmt(addDays(MONDAY_LAST_WEEK, 3)), durationMinutes: 480, description: "杭州出差当日往返", source: "manual", createdBy: memberId, updatedBy: memberId },
      { periodId, userId: memberId, projectId: projectAId, activityType: "quality_review", workDate: fmt(addDays(MONDAY_LAST_WEEK, 4)), durationMinutes: 180, description: "证据链质量复核", source: "manual", createdBy: memberId, updatedBy: memberId },
    ]);
  }

  /* ===== 周期 C：pm 上周 locked（3 明细；approver=partner；D4 lock/unlock 演示态） ===== */

  const cCode = `TS-${YEAR}-00003`;
  const cExisting = await tx.select({ id: timesheetPeriods.id }).from(timesheetPeriods).where(eq(timesheetPeriods.code, cCode));
  if (!cExisting[0]) {
    const period = await tx
      .insert(timesheetPeriods)
      .values({
        code: cCode,
        userId: pmId,
        periodType: "weekly",
        periodStart: fmt(MONDAY_LAST_WEEK),
        periodEnd: fmt(SUNDAY_LAST_WEEK),
        status: "locked",
        approverId: partnerId,
        submittedAt: addDays(MONDAY_THIS_WEEK, -2).toISOString(),
        approvedAt: addDays(MONDAY_THIS_WEEK, -2).toISOString(),
        lockedAt: addDays(MONDAY_THIS_WEEK, -1).toISOString(),
        lockedBy: partnerId,
        lockReason: "月度例行锁定期（D4 验收演示：unlock 需 time.unlock 授权+理由+审计）",
        createdBy: pmId,
        updatedBy: partnerId,
      })
      .returning({ id: timesheetPeriods.id });
    const periodId = period[0].id;
    await tx.insert(timeEntries).values([
      { periodId, userId: pmId, projectId: projectAId, activityType: "professional_work", workDate: fmt(addDays(MONDAY_LAST_WEEK, 0)), durationMinutes: 480, description: "项目整体推进与客户沟通", source: "manual", createdBy: pmId, updatedBy: pmId },
      { periodId, userId: pmId, projectId: projectAId, taskId: task3Id, activityType: "professional_work", workDate: fmt(addDays(MONDAY_LAST_WEEK, 1)), durationMinutes: 420, description: "证据交换材料核对复核", source: "manual", createdBy: pmId, updatedBy: pmId },
      // 非项目内部工作：project_id 为空，活动类型须为 internal_admin/other（arch/07 §2 check）
      { periodId, userId: pmId, projectId: null, activityType: "internal_admin", workDate: fmt(addDays(MONDAY_LAST_WEEK, 2)), durationMinutes: 120, description: "所内培训与行政会议", source: "manual", createdBy: pmId, updatedBy: pmId },
    ]);
  }

  // 编号序列水位对齐（TS 前缀）
  await tx.execute(
    sql.raw(
      `INSERT INTO code_sequences (prefix, year, next_value) VALUES ('TS', ${YEAR}, 4) ` +
        `ON CONFLICT (prefix, year) DO UPDATE SET next_value = GREATEST(code_sequences.next_value, 4)`,
    ),
  );
}
