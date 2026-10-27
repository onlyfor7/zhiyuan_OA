import "./env-setup";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { closeDb } from "../../src/db/client";
import { getApp, loginAs, setupDatabase, trpc, trpcError } from "./helpers";
import { TEST_DATABASE_URL } from "../db/helpers";

/**
 * 迭代 1 验收套件·核心治理（arch/04 §8）：A1 模板创建 / A2 基线不可变+延期闭环 /
 * A3 严重质量复核分离 / A4 决策闭环 / A11 结项检查（阻断解除后真实结项）。
 * 与后端自测互补：本套件以验收口径独立走完整业务链并做跨层（API+DB）断言。
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

async function meId(app: Awaited<ReturnType<typeof getApp>>, cookie: string): Promise<string> {
  const result = await trpc(app, "auth.me", { cookie, method: "GET" });
  return (result.json as { result: { data: { user: { id: string } } } }).result.data.user.id;
}

async function projectIdByCode(app: Awaited<ReturnType<typeof getApp>>, cookie: string, code: string) {
  const list = await trpc(app, "project.list", { cookie, method: "GET" });
  const items = (list.json as { result: { data: { items: { id: string; code: string }[] } } })
    .result.data.items;
  return items.find((p) => p.code === code)!.id;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "requestId")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

describe("迭代 1 验收 A1–A4/A11（arch/04 §8）", () => {
  let app: Awaited<ReturnType<typeof getApp>>;
  let partnerCookie: string;
  let pmCookie: string;
  let memberCookie: string;
  let qualityCookie: string;
  let projectAId: string;

  beforeAll(async () => {
    await setupDatabase();
    app = await getApp();
    partnerCookie = (await loginAs(app, "partner@lexflow.demo")).cookie;
    pmCookie = (await loginAs(app, "pm@lexflow.demo")).cookie;
    memberCookie = (await loginAs(app, "member@lexflow.demo")).cookie;
    qualityCookie = (await loginAs(app, "quality@lexflow.demo")).cookie;
    projectAId = await projectIdByCode(app, pmCookie, `PRJ-${YEAR}-00001`);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("A1 模板创建项目：阶段/任务/检查项/十一目录/基线 items 全自动生成；必填缺失被拒；编号唯一", async () => {
    const templates = await trpc(app, "project.listTemplates", { cookie: partnerCookie, method: "GET" });
    const templateId = (
      (templates.json as { result: { data: { id: string; name: string }[] } }).result.data
    ).find((t) => t.name === "诉讼案件标准模板")!.id;
    const matters = await trpc(app, "matter.list", { cookie: partnerCookie, method: "GET" });
    const matterId = (
      matters.json as { result: { data: { items: { id: string }[] } } }
    ).result.data.items[0].id;
    const startDate = new Date().toISOString().slice(0, 10);

    // 必填缺失：name / matterId / templateId 逐项 400 + 字段映射
    for (const [field, input] of [
      ["name", { templateId, matterId, startDate }],
      ["matterId", { templateId, name: "缺事项", startDate }],
      ["templateId", { matterId, name: "缺模板", startDate }],
    ] as const) {
      const bad = await trpc(app, "project.create", { cookie: partnerCookie, input });
      expect(bad.status).toBe(400);
      expect(trpcError(bad).businessCode).toBe("VALIDATION_FAILED");
      expect(trpcError(bad).fieldErrors).toHaveProperty(field);
    }

    const created = await trpc(app, "project.create", {
      cookie: partnerCookie,
      input: { templateId, matterId, name: "A1 验收立项", startDate },
    });
    expect(created.status).toBe(200);
    const project = (created.json as { result: { data: { id: string; code: string } } }).result.data;
    expect(project.code).toMatch(new RegExp(`^PRJ-${YEAR}-\\d{5}$`));

    // 模板事务产物（DB 直查）
    const counts = await query<{
      stages: number; tasks: number; checks: number; dirs: number; versions: number; items: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM stages WHERE project_id = $1) AS stages,
         (SELECT count(*)::int FROM tasks WHERE project_id = $1) AS tasks,
         (SELECT count(*)::int FROM quality_check_items WHERE project_id = $1) AS checks,
         (SELECT count(*)::int FROM archive_directories WHERE project_id = $1) AS dirs,
         (SELECT count(*)::int FROM plan_versions WHERE project_id = $1) AS versions,
         (SELECT count(*)::int FROM plan_items pi JOIN plan_versions pv ON pv.id = pi.plan_version_id
           WHERE pv.project_id = $1) AS items`,
      [project.id],
    );
    expect(counts[0].stages).toBe(4);
    expect(counts[0].tasks).toBe(5); // 诉讼模板 structure.tasks（02c 落地）
    expect(counts[0].checks).toBe(4);
    expect(counts[0].dirs).toBe(11);
    expect(counts[0].versions).toBe(1);
    expect(counts[0].items).toBe(9); // 4 阶段 + 5 任务同步写入 v1

    // 任务日期全部落在所属阶段区间内
    const outOfRange = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tasks t JOIN stages s ON s.id = t.stage_id
       WHERE t.project_id = $1 AND (t.planned_start < s.planned_start OR t.planned_end > s.planned_end)`,
      [project.id],
    );
    expect(outOfRange[0].n).toBe(0);

    // 创建人自动成为 manager 成员
    const overview = await trpc(app, "project.overview", {
      cookie: partnerCookie,
      method: "GET",
      input: { projectId: project.id },
    });
    expect((overview.json as { result: { data: { myRole: string } } }).result.data.myRole).toBe("manager");

    // 编号唯一：再次创建必得不同 code
    const second = await trpc(app, "project.create", {
      cookie: partnerCookie,
      input: { templateId, matterId, name: "A1 验收立项·第二件", startDate },
    });
    expect(second.status).toBe(200);
    const secondCode = (second.json as { result: { data: { code: string } } }).result.data.code;
    expect(secondCode).not.toBe(project.code);
  });

  it("A2 基线不可变 + 延期闭环：V1 快照不变；key 级书面延期通过 → V2 生效且 live 同步；三轨可区分", async () => {
    // V1 快照（含名称快照 arch/04 §2.3 v1.1）
    const versions = await trpc(app, "plan.versions", {
      cookie: pmCookie, method: "GET", input: { projectId: projectAId },
    });
    const v1 = (versions.json as { result: { data: { id: string; versionNo: number }[] } }).result.data
      .find((v) => v.versionNo === 1)!;
    const v1Before = await trpc(app, "plan.versionGet", {
      cookie: pmCookie, method: "GET", input: { id: v1.id },
    });
    const v1Snapshot = canonical(
      (v1Before.json as { result: { data: { items: unknown[] } } }).result.data.items,
    );
    const v1ItemCount = (
      (v1Before.json as { result: { data: { items: unknown[] } } }).result.data.items
    ).length;

    // member 书面延期（key 级 → 管理层 partner 审批）
    const task = (
      await query<{ id: string; planned_start: string; planned_end: string }>(
        `SELECT id, planned_start::text, planned_end::text FROM tasks WHERE code = $1`,
        [`TSK-${YEAR}-00005`],
      )
    )[0];
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const newStart = new Date(Date.now() + 30 * 86_400_000);
    const newEnd = new Date(Date.now() + 39 * 86_400_000);
    const created = await trpc(app, "change.create", {
      cookie: memberCookie,
      input: {
        projectId: projectAId,
        title: "A2 书面延期：关键任务后移",
        level: "key",
        targetItems: [
          { ref_id: task.id, item_type: "task", new_start: fmt(newStart), new_end: fmt(newEnd) },
        ],
        reason: "证人行程冲突，证据交换需整体后移（A2 验收）",
        impact: "庭前准备顺延，关键路径延长约 10 天（A2 验收）",
        recoveryMeasures: [
          {
            measure: "每日核对证人行程并同步书面记录（A2 验收）",
            owner_id: await meId(app, memberCookie),
            checkpoint_date: fmt(new Date(Date.now() + 3 * 86_400_000)),
          },
        ],
      },
    });
    expect(created.status).toBe(200);
    const crId = (created.json as { result: { data: { id: string } } }).result.data.id;
    const crRow = (
      (await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" })).json as {
        result: { data: { rowVersion: number } };
      }
    ).result.data;
    const submitted = await trpc(app, "change.submit", {
      cookie: memberCookie,
      input: { id: crId, rowVersion: crRow.rowVersion, idempotencyKey: crypto.randomUUID() },
    });
    expect(submitted.status).toBe(200);
    const cr = (
      (await trpc(app, "change.getById", { cookie: memberCookie, input: { id: crId }, method: "GET" })).json as {
        result: { data: { approvalInstanceId: string } };
      }
    ).result.data;

    // partner（key 级审批人）通过
    const partnerAct = await trpc(app, "approval.act", {
      cookie: partnerCookie,
      input: { instanceId: cr.approvalInstanceId, stepSeq: 1, action: "approve", comment: "同意，注意检查点" },
    });
    expect(partnerAct.status).toBe(200);

    // V2 生效、V1 superseded、快照不可变、live 同步
    const versionsAfter = await query<{ version_no: number; status: string; kind: string }>(
      `SELECT version_no, status, kind FROM plan_versions WHERE project_id = $1 ORDER BY version_no`,
      [projectAId],
    );
    expect(versionsAfter.map((v) => v.version_no)).toEqual([1, 2]);
    expect(versionsAfter[0].status).toBe("superseded");
    expect(versionsAfter[1]).toMatchObject({ status: "active", kind: "change" });

    const v1After = await trpc(app, "plan.versionGet", {
      cookie: pmCookie, method: "GET", input: { id: v1.id },
    });
    const v1ItemsNow = (v1After.json as { result: { data: { items: unknown[] } } }).result.data.items;
    expect(canonical(v1ItemsNow)).toBe(v1Snapshot); // PLN-I1：历史版本内容零变化

    const versionsApi = await trpc(app, "plan.versions", {
      cookie: pmCookie, method: "GET", input: { projectId: projectAId },
    });
    const v2 = (versionsApi.json as { result: { data: { id: string; versionNo: number }[] } }).result.data
      .find((v) => v.versionNo === 2)!;
    const v2Detail = await trpc(app, "plan.versionGet", {
      cookie: pmCookie, method: "GET", input: { id: v2.id },
    });
    const v2Items = (v2Detail.json as {
      result: { data: { items: { refId: string; plannedStart: string; plannedEnd: string }[] } };
    }).result.data.items;
    expect(v2Items).toHaveLength(v1ItemCount);
    const replaced = v2Items.find((i) => i.refId === task.id)!;
    expect(replaced.plannedStart).toBe(fmt(newStart));
    expect(replaced.plannedEnd).toBe(fmt(newEnd));

    const live = (
      await query<{ planned_start: string; planned_end: string }>(
        `SELECT planned_start::text, planned_end::text FROM tasks WHERE id = $1`,
        [task.id],
      )
    )[0];
    expect(live.planned_start).toBe(fmt(newStart));
    expect(live.planned_end).toBe(fmt(newEnd));

    // 恢复措施生成任务（source 链）
    const recovery = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'change_request' AND source_id = $1`,
      [crId],
    );
    expect(recovery[0].n).toBe(1);

    // 甘特三轨可区分：基线轨（V1 目标项日期）≠ 当前轨（V2/live）；实际轨有 live actual_* 数据源
    const v1Target = (
      (v1Before.json as {
        result: { data: { items: { refId: string; plannedStart: string }[] } };
      }).result.data.items
    ).find((i) => i.refId === task.id)!;
    expect(v1Target.plannedStart).not.toBe(fmt(newStart));
    const current = await trpc(app, "plan.current", {
      cookie: pmCookie, method: "GET", input: { projectId: projectAId },
    });
    const currentData = (current.json as {
      result: {
        data: {
          versionNo: number;
          tasks: { code: string; actualStart: string | null; actualEnd: string | null }[];
        };
      };
    }).result.data;
    expect(currentData.versionNo).toBe(2);
    expect(currentData.tasks.some((t) => t.actualEnd !== null)).toBe(true);
  });

  it("A3 严重质量复核分离：自审 SELF_REVIEW_BLOCKED；退回留事件历史；未关闭阻断结项（A11）", async () => {
    const memberId = await meId(app, memberCookie);
    const pmId = await meId(app, pmCookie);

    // 种子 QLT-00001：severe pending_review（handler=member≠reviewer=pm）阻断中
    const seeded = (
      await query<{ id: string; status: string; is_blocking: boolean }>(
        `SELECT id, status, is_blocking FROM quality_issues WHERE code = $1`,
        [`QLT-${YEAR}-00001`],
      )
    )[0];
    expect(seeded).toMatchObject({ status: "pending_review", is_blocking: true });

    // A11 前半：阻断问题未关闭 → 结项检查 blocked 且清单列明
    const project = (
      (await trpc(app, "project.getById", { cookie: pmCookie, input: { id: projectAId }, method: "GET" })).json as {
        result: { data: { rowVersion: number } };
      }
    ).result.data;
    const closeAttempt = await trpc(app, "project.close", {
      cookie: pmCookie,
      input: { projectId: projectAId, rowVersion: project.rowVersion },
    });
    expect(closeAttempt.status).toBe(200);
    const closeData = (closeAttempt.json as {
      result: { data: { closed: boolean; blockers: string[]; warnings: string[] } };
    }).result.data;
    expect(closeData.closed).toBe(false);
    expect(closeData.blockers.join(" ")).toContain(`QLT-${YEAR}-00001`);

    // 同一人复核 severe → 403 SELF_REVIEW_BLOCKED（分离硬规则，独立探测件）
    const probe = await trpc(app, "quality.create", {
      cookie: pmCookie,
      input: {
        projectId: projectAId,
        title: "A3 自审探测件",
        description: "处理人与复核人同一人时复核必须通过服务端拦截",
        severity: "severe",
        handlerId: memberId,
        reviewerId: memberId,
      },
    });
    expect(probe.status).toBe(200);
    const probeId = (probe.json as { result: { data: { id: string } } }).result.data.id;
    await trpc(app, "quality.submitHandling", {
      cookie: memberCookie,
      input: { id: probeId, note: "处理完成，提交复核" },
    });
    const selfReview = await trpc(app, "quality.review", {
      cookie: memberCookie,
      input: { id: probeId, action: "pass", comment: "自己复核自己" },
    });
    expect(selfReview.status).toBe(403);
    expect(trpcError(selfReview).businessCode).toBe("SELF_REVIEW_BLOCKED");
    // 探测件收尾：改派 pm 复核并关闭，避免遗留阻断项影响 A11 结项断言
    await trpc(app, "quality.assign", {
      cookie: pmCookie,
      input: { id: probeId, handlerId: memberId, reviewerId: pmId },
    });
    const probeClosed = await trpc(app, "quality.review", {
      cookie: pmCookie,
      input: { id: probeId, action: "pass", comment: "探测件关闭" },
    });
    expect(probeClosed.status).toBe(200);

    // 主线：handler=member ≠ reviewer=pm；退回必须留 note 且事件历史完整
    const issue = await trpc(app, "quality.create", {
      cookie: pmCookie,
      input: {
        projectId: projectAId,
        title: "A3 复核分离主线",
        description: "退回留痕与补齐通过主线",
        severity: "severe",
        handlerId: memberId,
        reviewerId: pmId,
      },
    });
    expect(issue.status).toBe(200);
    const issueId = (issue.json as { result: { data: { id: string } } }).result.data.id;
    await trpc(app, "quality.submitHandling", {
      cookie: memberCookie,
      input: { id: issueId, note: "处理完成，提交复核" },
    });
    const returned = await trpc(app, "quality.review", {
      cookie: pmCookie,
      input: { id: issueId, action: "return", comment: "根因分析不足，退回补充" },
    });
    expect(returned.status).toBe(200);
    const events = await query<{ action: string }>(
      `SELECT action FROM quality_issue_events WHERE issue_id = $1 ORDER BY created_at`,
      [issueId],
    );
    expect(events.map((e) => e.action)).toEqual(["create", "handle_submit", "review_return"]);

    // 补齐后复核通过 → closed 且解除阻断
    await trpc(app, "quality.submitHandling", {
      cookie: memberCookie,
      input: { id: issueId, note: "已补充根因" },
    });
    const passed = await trpc(app, "quality.review", {
      cookie: pmCookie,
      input: { id: issueId, action: "pass", comment: "复核通过" },
    });
    expect(passed.status).toBe(200);

    // 关闭种子阻断问题（reviewer=pm 复核通过）
    const seededPass = await trpc(app, "quality.review", {
      cookie: pmCookie,
      input: { id: seeded.id, action: "pass", comment: "种子 severe 关闭" },
    });
    expect(seededPass.status).toBe(200);
    const blockingLeft = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM quality_issues WHERE project_id = $1 AND is_blocking = true`,
      [projectAId],
    );
    expect(blockingLeft[0].n).toBe(0);

    // A11 后半：阻断解除 → 结项真实生效（警告仍在但 closed=true）
    const fresh = (
      (await trpc(app, "project.getById", { cookie: pmCookie, input: { id: projectAId }, method: "GET" })).json as {
        result: { data: { rowVersion: number } };
      }
    ).result.data;
    const closed = await trpc(app, "project.close", {
      cookie: pmCookie,
      input: { projectId: projectAId, rowVersion: fresh.rowVersion },
    });
    expect(closed.status).toBe(200);
    const closedData = (closed.json as {
      result: { data: { closed: boolean; blockers: string[]; warnings: string[] } };
    }).result.data;
    expect(closedData.blockers).toHaveLength(0);
    expect(closedData.warnings.length).toBeGreaterThan(0); // 未完成任务/未归档周报仍提示
    expect(closedData.closed).toBe(true);
    const lifecycle = await query<{ lifecycle_status: string }>(
      `SELECT lifecycle_status FROM projects WHERE id = $1`,
      [projectAId],
    );
    expect(lifecycle[0].lifecycle_status).toBe("closed");
  });

  it("A4 决策闭环：双意见+四必填 → 检查点生成任务 → verify 回写可溯", async () => {
    const pmId = await meId(app, pmCookie);
    const qualityId = await meId(app, qualityCookie);
    await trpc(app, "project.addMember", {
      cookie: pmCookie,
      input: { projectId: projectAId, userId: qualityId, projectRole: "member" },
    });

    const created = await trpc(app, "decision.create", {
      cookie: pmCookie,
      input: {
        projectId: projectAId,
        title: "A4 是否追加鉴定申请",
        context: "证据链强度评估后的决策（A4 验收）",
        options: [
          { key: "delay", summary: "追加鉴定", impact: "周期延长两周", risk: "结论不利风险" },
          { key: "risk_accept", summary: "不追加", impact: "维持现状", risk: "举证不足风险" },
        ],
      },
    });
    expect(created.status).toBe(200);
    const decisionId = (created.json as { result: { data: { id: string } } }).result.data.id;

    // 未决定即 verify → 状态机拦截
    await trpc(app, "decision.submitOpinions", {
      cookie: pmCookie,
      input: { id: decisionId, pmOpinion: "倾向追加" },
    });
    const earlyVerify = await trpc(app, "decision.verify", {
      cookie: pmCookie,
      input: { id: decisionId, note: "提前验证" },
    });
    expect(earlyVerify.status).toBe(409);
    expect(trpcError(earlyVerify).businessCode).toBe("STATE_CONFLICT");

    // 双意见不齐 → decide 被拦（质量意见缺失）
    const noQuality = await trpc(app, "decision.decide", {
      cookie: pmCookie,
      input: {
        id: decisionId,
        finalOption: "delay",
        finalReason: "证据链补强优先",
        conditions: "两周内未受理则降级",
        checkpoints: [],
        rowVersion: 2,
      },
    });
    expect(noQuality.status).toBe(400);
    expect(trpcError(noQuality).businessCode).toBe("VALIDATION_FAILED");

    await trpc(app, "decision.submitOpinions", {
      cookie: qualityCookie,
      input: { id: decisionId, qualityOpinion: "同意追加，注意机构资质" },
    });
    const memberId = await meId(app, memberCookie);
    const decided = await trpc(app, "decision.decide", {
      cookie: pmCookie,
      input: {
        id: decisionId,
        finalOption: "delay",
        finalReason: "证据链补强优先（A4）",
        conditions: "两周内未取得结论则降级为不追加",
        checkpoints: [{ point: "提交鉴定申请", date: "2027-02-01", owner_id: memberId }],
        rowVersion: 2,
      },
    });
    expect(decided.status).toBe(200);

    // 检查点生成任务（source_type='decision' 可溯）
    const cpTasks = await query<{ code: string; source_id: string; title: string }>(
      `SELECT code, source_id, title FROM tasks WHERE source_type = 'decision' AND source_id = $1`,
      [decisionId],
    );
    expect(cpTasks).toHaveLength(1);
    expect(cpTasks[0].title).toContain("提交鉴定申请");

    // verify 回写
    const verify = await trpc(app, "decision.verify", {
      cookie: pmCookie,
      input: { id: decisionId, note: "鉴定申请已提交并受理（A4）" },
    });
    expect(verify.status).toBe(200);
    const final = await query<{ status: string; verification_note: string | null; verified_by: string | null }>(
      `SELECT status, verification_note, verified_by FROM decisions WHERE id = $1`,
      [decisionId],
    );
    expect(final[0].status).toBe("verified");
    expect(final[0].verification_note).toContain("鉴定申请");
    expect(final[0].verified_by).toBe(pmId);

    // 关键动作审计留痕
    const audits = await query<{ action: string }>(
      `SELECT action FROM audit_events WHERE action IN ('decision.decide', 'decision.verify')`,
    );
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("decision.decide");
    expect(actions).toContain("decision.verify");
  });
});
