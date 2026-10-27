import { and, eq, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";

import * as schema from "../schema";
import {
  approvalPolicies,
  meetings,
  meetingActionItems,
  meetingMinutes,
  meetingParticipants,
  projects,
  tasks,
  travelEvents,
  travelRequests,
  travelSegments,
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

/** 某天某时刻（UTC ISO；种子用固定时刻避免与日期错位） */
function at(date: Date, hourUtc: number): string {
  const d = new Date(date);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

const TODAY = new Date();

/** arch/05 §7 审批策略种子（按 biz_type+priority 幂等；迭代 1 已有 change_request/access_grant 三条） */
const COLLAB_POLICY_SEED = [
  {
    bizType: "travel",
    priority: 10,
    matchJson: { borrow: true },
    stepsJson: [{ approver_role: "project_manager" }, { approver_role: "finance", countersign: "all" }],
    description: "出差（借款）→ 项目负责人 + 财务会签（all）",
  },
  {
    bizType: "travel",
    priority: 20,
    matchJson: { min_estimated_cost_cents: 5000000 },
    stepsJson: [{ approver_role: "project_manager" }, { approver_role: "partner" }],
    description: "出差（预计费用 ≥ 50,000 元）→ 两步升级：项目负责人 → 管理层",
  },
  {
    bizType: "travel",
    priority: 100,
    matchJson: {},
    stepsJson: [{ approver_role: "project_manager" }],
    description: "出差（默认）→ 项目负责人审批",
  },
  {
    bizType: "travel_change",
    priority: 100,
    matchJson: {},
    stepsJson: [{ approver_role: "project_manager" }],
    description: "出差关键字段变更（travel_change）→ 项目负责人审批",
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

export async function seedCollab(tx: SeedTx): Promise<void> {
  const pmId = await userIdByEmail(tx, "pm@lexflow.demo");
  const memberId = await userIdByEmail(tx, "member@lexflow.demo");
  const liuchangId = await userIdByEmail(tx, "liuchang@lexflow.demo");
  const huangleiId = await userIdByEmail(tx, "huanglei@lexflow.demo");
  const projectAId = await projectIdByCode(tx, `PRJ-${YEAR}-00001`);

  // 审批策略（arch/05 §7 四条）
  for (const policy of COLLAB_POLICY_SEED) {
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

  /* ===== 项目 A 会议种子 ×3 ===== */

  // 1) planned 会议（含议程 + 内外部参与人）
  const m1Code = `MTG-${YEAR}-00001`;
  const m1Existing = await tx.select({ id: meetings.id }).from(meetings).where(eq(meetings.code, m1Code));
  let m1Id = m1Existing[0]?.id;
  if (!m1Id) {
    const inserted = await tx
      .insert(meetings)
      .values({
        projectId: projectAId,
        code: m1Code,
        type: "project",
        subject: "庭前准备会议",
        agenda: "1. 证据交换安排\n2. 证人出庭方案\n3. 庭前会议提纲分工",
        startAt: at(addDays(TODAY, 3), 6),
        endAt: at(addDays(TODAY, 3), 8),
        location: "第一会议室",
        organizerId: pmId,
        recorderId: memberId,
        status: "planned",
        minutesStatus: "pending_draft",
        createdBy: pmId,
        updatedBy: pmId,
      })
      .returning({ id: meetings.id });
    m1Id = inserted[0].id;
    await tx.insert(meetingParticipants).values([
      { meetingId: m1Id, userId: pmId, role: "required" },
      { meetingId: m1Id, userId: memberId, role: "required" },
      { meetingId: m1Id, userId: liuchangId, role: "optional" },
      { meetingId: m1Id, userId: huangleiId, role: "optional" },
      { meetingId: m1Id, externalName: "张伟", externalOrg: "华宸贸易有限公司", role: "required", notifyContact: "zhangwei@huachen.example" },
    ]);
  }

  // 2) 已结束且纪要 pending_draft（记录人 member）
  const m2Code = `MTG-${YEAR}-00002`;
  const m2Existing = await tx.select({ id: meetings.id }).from(meetings).where(eq(meetings.code, m2Code));
  let m2Id = m2Existing[0]?.id;
  if (!m2Id) {
    const start = at(addDays(TODAY, -4), 2);
    const inserted = await tx
      .insert(meetings)
      .values({
        projectId: projectAId,
        code: m2Code,
        type: "weekly",
        subject: "项目周会（进度同步）",
        agenda: "1. 上周完成\n2. 本周计划\n3. 风险与阻塞",
        startAt: start,
        endAt: at(addDays(TODAY, -4), 3),
        onlineUrl: "https://meet.lexflow.demo/weekly-a",
        organizerId: pmId,
        recorderId: memberId,
        status: "completed",
        minutesStatus: "pending_draft",
        actualStartAt: start,
        actualEndAt: at(addDays(TODAY, -4), 3),
        createdBy: pmId,
        updatedBy: pmId,
      })
      .returning({ id: meetings.id });
    m2Id = inserted[0].id;
    await tx.insert(meetingParticipants).values([
      { meetingId: m2Id, userId: pmId, role: "required", attendance: "attended" },
      { meetingId: m2Id, userId: memberId, role: "required", attendance: "attended" },
      { meetingId: m2Id, userId: liuchangId, role: "optional", attendance: "excused" },
    ]);
    // 纪要草稿 v1（待整理）
    const minutes = await tx
      .insert(meetingMinutes)
      .values({
        meetingId: m2Id,
        versionNo: 1,
        body: "本周完成证据交换材料初核；庭前会议提纲未完成，转下周跟进。",
        disagreements: null,
        risks: "证人出庭时间尚未最终确认。",
        recorderId: memberId,
        createdBy: memberId,
      })
      .returning({ id: meetingMinutes.id });
    void minutes;
  }

  // 3) 已确认纪要会议（含 2 行动项，其一已转任务）
  const m3Code = `MTG-${YEAR}-00003`;
  const m3Existing = await tx.select({ id: meetings.id }).from(meetings).where(eq(meetings.code, m3Code));
  let m3Id = m3Existing[0]?.id;
  if (!m3Id) {
    const start = at(addDays(TODAY, -11), 7);
    const inserted = await tx
      .insert(meetings)
      .values({
        projectId: projectAId,
        code: m3Code,
        type: "quality_review",
        subject: "证据链质量复核会",
        agenda: "1. 严重问题复核意见\n2. 补充证据安排\n3. 行动项确认",
        startAt: start,
        endAt: at(addDays(TODAY, -11), 8),
        location: "第二会议室",
        organizerId: pmId,
        recorderId: pmId,
        status: "completed",
        minutesStatus: "confirmed",
        actualStartAt: start,
        actualEndAt: at(addDays(TODAY, -11), 9),
        createdBy: pmId,
        updatedBy: pmId,
      })
      .returning({ id: meetings.id });
    m3Id = inserted[0].id;
    await tx.insert(meetingParticipants).values([
      { meetingId: m3Id, userId: pmId, role: "required", attendance: "attended" },
      { meetingId: m3Id, userId: memberId, role: "required", attendance: "attended" },
      { meetingId: m3Id, userId: liuchangId, role: "required", attendance: "attended" },
    ]);
    const confirmedAt = at(addDays(TODAY, -10), 3);
    const minutes = await tx
      .insert(meetingMinutes)
      .values({
        meetingId: m3Id,
        versionNo: 1,
        body: "复核结论：证据链缺口需在一周内补充证人询问笔录；文书编号问题已关闭。",
        disagreements: "对是否追加鉴定存在分歧，转决策单跟踪。",
        risks: "证人配合度不确定。",
        recorderId: pmId,
        confirmerId: pmId,
        confirmedAt,
        createdBy: pmId,
      })
      .returning({ id: meetingMinutes.id });
    const minutesVersionId = minutes[0].id;

    // 行动项 ×2：其一 open；另一已转任务（source_type='meeting'，双向定位）
    await tx.insert(meetingActionItems).values({
      meetingId: m3Id,
      minutesVersionId,
      title: "补充证人询问笔录",
      ownerId: memberId,
      dueDate: fmt(addDays(TODAY, 2)),
      deliverable: "询问笔录扫描件",
      checkpoint: "提交前由陈立检查",
      status: "open",
      createdBy: pmId,
      updatedBy: pmId,
    });

    const item2 = await tx
      .insert(meetingActionItems)
      .values({
        meetingId: m3Id,
        minutesVersionId,
        title: "整理客户证据交接清单",
        ownerId: liuchangId,
        dueDate: fmt(addDays(TODAY, 5)),
        status: "converted",
        createdBy: pmId,
        updatedBy: pmId,
      })
      .returning({ id: meetingActionItems.id });

    const convertedTask = await tx
      .insert(tasks)
      .values({
        projectId: projectAId,
        code: `TSK-${YEAR}-00012`,
        title: "整理客户证据交接清单",
        assigneeId: liuchangId,
        plannedStart: fmt(TODAY),
        plannedEnd: fmt(addDays(TODAY, 5)),
        status: "pending",
        sourceType: "meeting",
        sourceId: item2[0].id,
        createdBy: pmId,
        updatedBy: pmId,
      })
      .returning({ id: tasks.id });

    await tx
      .update(meetingActionItems)
      .set({ convertedTaskId: convertedTask[0].id })
      .where(eq(meetingActionItems.id, item2[0].id));
  }

  /* ===== 出差种子 ×2 ===== */

  // 1) member 的 approved 出差（含 3 段行程，可演示完成）
  const t1Code = `TRV-${YEAR}-00001`;
  const t1Existing = await tx.select({ id: travelRequests.id }).from(travelRequests).where(eq(travelRequests.code, t1Code));
  if (!t1Existing[0]) {
    const inserted = await tx
      .insert(travelRequests)
      .values({
        projectId: projectAId,
        code: t1Code,
        applicantId: memberId,
        reason: "外地证据调取与证人访谈",
        destination: "杭州市",
        startOn: fmt(addDays(TODAY, -15)),
        endOn: fmt(addDays(TODAY, -13)),
        estimatedCostCents: 180000,
        borrow: false,
        status: "approved",
        createdBy: memberId,
        updatedBy: memberId,
      })
      .returning({ id: travelRequests.id });
    const travelId = inserted[0].id;
    await tx.insert(travelSegments).values([
      { travelRequestId: travelId, seq: 1, type: "transport", startAt: at(addDays(TODAY, -15), 0), endAt: at(addDays(TODAY, -15), 4), fromPlace: "上海", toPlace: "杭州", description: "高铁前往" },
      { travelRequestId: travelId, seq: 2, type: "client_site", startAt: at(addDays(TODAY, -15), 6), endAt: at(addDays(TODAY, -13), 9), fromPlace: "华宸贸易杭州办事处", toPlace: null, description: "现场取证与证人访谈" },
      { travelRequestId: travelId, seq: 3, type: "transport", startAt: at(addDays(TODAY, -13), 10), endAt: at(addDays(TODAY, -13), 14), fromPlace: "杭州", toPlace: "上海", description: "返程" },
    ]);
    await tx.insert(travelEvents).values([
      { travelRequestId: travelId, actorId: memberId, action: "create", createdAt: at(addDays(TODAY, -18), 2) },
      { travelRequestId: travelId, actorId: memberId, action: "submit", createdAt: at(addDays(TODAY, -18), 3) },
      { travelRequestId: travelId, actorId: pmId, action: "approve", createdAt: at(addDays(TODAY, -17), 1) },
    ]);
  }

  // 2) pm 的 pending_approval 借款出差（演示会签：borrow=true → pm+finance all）
  const t2Code = `TRV-${YEAR}-00002`;
  const t2Existing = await tx.select({ id: travelRequests.id }).from(travelRequests).where(eq(travelRequests.code, t2Code));
  if (!t2Existing[0]) {
    const inserted = await tx
      .insert(travelRequests)
      .values({
        projectId: projectAId,
        code: t2Code,
        applicantId: pmId,
        reason: "异地庭审与客户会谈",
        destination: "北京市",
        startOn: fmt(addDays(TODAY, 7)),
        endOn: fmt(addDays(TODAY, 9)),
        estimatedCostCents: 800000,
        borrow: true,
        borrowAmountCents: 500000,
        status: "pending_approval",
        createdBy: pmId,
        updatedBy: pmId,
      })
      .returning({ id: travelRequests.id });
    const travelId = inserted[0].id;
    await tx.insert(travelSegments).values([
      { travelRequestId: travelId, seq: 1, type: "transport", startAt: at(addDays(TODAY, 7), 1), endAt: at(addDays(TODAY, 7), 5), fromPlace: "上海", toPlace: "北京", description: "高铁前往" },
      { travelRequestId: travelId, seq: 2, type: "accommodation", startAt: at(addDays(TODAY, 7), 14), endAt: at(addDays(TODAY, 9), 11), fromPlace: "北京", toPlace: null, description: "两晚住宿" },
    ]);
    await tx.insert(travelEvents).values([
      { travelRequestId: travelId, actorId: pmId, action: "create", createdAt: at(TODAY, 2) },
      { travelRequestId: travelId, actorId: pmId, action: "submit", createdAt: at(TODAY, 3) },
    ]);
  }

  // 编号序列水位对齐（MTG/TRV 新前缀 + TSK 新增 00012）
  const floors: Array<[string, number]> = [
    ["MTG", 4],
    ["TRV", 3],
    ["TSK", 13],
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
