import { sql } from "drizzle-orm";

import { ERROR_CODE } from "@lexflow/shared";

import { projects } from "../../db/schema";
import { BusinessError } from "../../lib/errors";
import { projectScopeFilter } from "../../services/access";
import { compileFlow, validateFlowStructure } from "../../services/approval/flow";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import type { AiContext } from "../../services/ai/provider";

/**
 * AI 能力解析器 A1–A5（arch/12 §17.2）——写动作一律只产草稿/预填（不落库），用户确认后走既有端点；
 * A4 审批流 DSL 草稿必须过既有编译/校验管线（非法即报错不产出）。
 */

export type AiAction = Record<string, unknown> & { type: string };

function invalid(field: string, message: string): BusinessError {
  return new BusinessError(ERROR_CODE.VALIDATION_FAILED, message, { [field]: [message] });
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(base: Date, days: number): string {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return fmtDate(d);
}

function parseDate(content: string): string | null {
  if (content.includes("明天")) return addDays(new Date(), 1);
  if (content.includes("后天")) return addDays(new Date(), 2);
  if (content.includes("昨天")) return addDays(new Date(), -1);
  const md = content.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  if (md) {
    const year = new Date().getFullYear();
    return `${year}-${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}`;
  }
  return null; // 缺省今天
}

/* ===== A1 表单预填（仅回传预填值，不落库） ===== */

export function capabilityFormPrefill(content: string, ctx: AiContext): AiAction {
  const values: Record<string, unknown> = {};
  const dest = content.match(/去\s*([\u4e00-\u9fa5]{2,4}?)(?=[两一二三四五六\d天]|[，,。；：\s]|$)/);
  if (dest) values.destination = dest[1];
  const daysCn: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5 };
  const dayWord = content.match(/([一两二三四五])\s*天/);
  const dayNum = content.match(/(\d+)\s*天/);
  if (dayNum) values.days = Number(dayNum[1]);
  else if (dayWord) values.days = daysCn[dayWord[1]] ?? 1;
  const startOn = parseDate(content);
  if (startOn) values.startOn = startOn;
  const transportMap: Record<string, string> = { 高铁: "rail_highspeed", 动车: "rail", 火车: "rail", 飞机: "flight", 航班: "flight", 自驾: "drive", 开车: "drive" };
  for (const [kw, code] of Object.entries(transportMap)) {
    if (content.includes(kw)) values.transport = code;
  }
  const reason = content.match(/(?:事由|原因)[:：是]?([^，。；]+)/);
  if (reason) values.reason = reason[1].trim();
  return { type: "form_prefill", form: ctx.pageType || "generic_form", values };
}

/* ===== A2 工时预填（NL→entries 草稿；0.5 小时步进校验；不落库） ===== */

export async function capabilityTimeDraft(db: DbOrTx, user: SessionUser, content: string): Promise<AiAction> {
  // 项目：「在XX（项目）干/工作…」→ 按用户可见集匹配
  const projectMatch = content.match(/在\s*([\u4e00-\u9fa5A-Za-z0-9]+?)(?:项目)?\s*(?:干|工作|加班|审核|整理|写|参与)/);
  if (!projectMatch) throw invalid("message", "请说明为哪个项目填报工时（如「在比博思特项目干了 4 小时」）");
  const kw = projectMatch[1];
  const visible = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(sql`${projectScopeFilter(user)} AND ${projects.name} LIKE ${"%" + kw + "%"}`)
    .limit(1);
  if (!visible[0]) throw invalid("message", `未在可见项目中找到「${kw}」`);
  // 小时：半天/一天/N 小时（0.5 步进）
  let minutes: number | null = null;
  if (content.includes("半天")) minutes = 240;
  else if (content.includes("一天") || content.includes("一整天")) minutes = 480;
  else {
    const h = content.match(/(\d+(?:\.\d+)?)\s*(?:个)?小时/);
    if (h) minutes = Math.round(Number(h[1]) * 60);
  }
  if (!minutes || minutes <= 0) throw invalid("message", "请说明小时数（如「4 小时」「半天」）");
  if (minutes % 30 !== 0) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "工时须为 0.5 小时（30 分钟）的整数倍", {
      message: [`${minutes} 分钟不是 0.5 小时步进`],
    });
  }
  const workDate = parseDate(content) ?? fmtDate(new Date());
  return {
    type: "time_draft",
    entries: [
      {
        projectId: visible[0].id,
        projectName: visible[0].name,
        workDate,
        minutes,
        hours: minutes / 60,
        description: content,
      },
    ],
  };
}

/* ===== A3 纪要草稿（不落库） ===== */

export function capabilityMinutesDraft(content: string, ctx: AiContext): AiAction {
  const agenda = content.replace(/^.*?(?:纪要|议程)[:：]?/, "").slice(0, 200) || ctx.summary.slice(0, 200) || "（未识别议程，请补充）";
  const draft = `【AI 纪要草稿】\n一、会议议程：${agenda}\n二、讨论要点：（待补充）\n三、决议事项：（待补充）\n四、行动项：（待补充，含负责人与期限）\n\n——草稿由小元生成，请编辑后提交确认。`;
  return { type: "minutes_draft", draft };
}

/* ===== A4 审批流生成（NL→definitionJson 草稿；必须过既有编译/校验管线，非法即报错不产出） ===== */

const APPROVER_RULES: Array<{ pattern: RegExp; node: { kind: string; role?: string }; label: string }> = [
  { pattern: /负责人|项目经理/, node: { kind: "project_manager" }, label: "项目负责人审批" },
  { pattern: /财务/, node: { kind: "role", role: "finance" }, label: "财务审批" },
  { pattern: /合伙人|管理层/, node: { kind: "role", role: "partner" }, label: "管理层审批" },
  { pattern: /档案/, node: { kind: "role", role: "archivist" }, label: "档案管理员审批" },
];

export function capabilityFlowDraft(content: string): AiAction {
  const thresholdMatch = content.match(/(?:超过|大于|不少于|≥|>=)\s*(\d+(?:\.\d+)?)\s*万/);
  const thresholdCents = thresholdMatch ? Math.round(Number(thresholdMatch[1]) * 100000) : null;
  const approvers: Array<{ node: { kind: string; role?: string }; label: string; pos: number }> = [];
  for (const rule of APPROVER_RULES) {
    const m = content.match(rule.pattern);
    if (m) approvers.push({ node: rule.node, label: rule.label, pos: m.index ?? 0 });
  }
  approvers.sort((a, b) => a.pos - b.pos);

  // 无审批人 → 产出非法定义，走既有管线报错（不产出草稿）
  if (approvers.length === 0) {
    const bad = { nodes: [{ id: "s", type: "start" as const }], edges: [] as Array<{ from: string; to: string }> };
    validateFlowStructure(bad); // 必然抛 FLOW_INVALID/VALIDATION_FAILED
    throw invalid("message", "未识别审批人（支持：负责人/财务/合伙人/档案）");
  }

  const def = thresholdCents && approvers.length >= 2
    ? buildConditionalFlow(thresholdCents, approvers)
    : buildLinearFlow(approvers);
  // 既有编译/校验管线：非法即报错不产出
  validateFlowStructure(def);
  compileFlow(def, {}, true);
  return { type: "flow_draft", definitionJson: def, description: content.slice(0, 200) };
}

function approvalNode(id: string, a: { node: { kind: string; role?: string }; label: string }) {
  return {
    id,
    type: "approval" as const,
    label: a.label,
    approver: a.node.role ? { kind: a.node.kind, role: a.node.role } : { kind: a.node.kind },
  };
}

function buildLinearFlow(approvers: Array<{ node: { kind: string; role?: string }; label: string }>) {
  const nodes: Array<Record<string, unknown>> = [{ id: "s", type: "start" }];
  const edges: Array<{ from: string; to: string }> = [];
  let prev = "s";
  approvers.forEach((a, i) => {
    const id = `a${i + 1}`;
    nodes.push(approvalNode(id, a));
    edges.push({ from: prev, to: id });
    prev = id;
  });
  nodes.push({ id: "e", type: "end" });
  edges.push({ from: prev, to: "e" });
  return { nodes, edges };
}

function buildConditionalFlow(
  thresholdCents: number,
  approvers: Array<{ node: { kind: string; role?: string }; label: string }>,
) {
  const [highChain, lowApprover] = [approvers, approvers[0]];
  const nodes: Array<Record<string, unknown>> = [{ id: "s", type: "start" }];
  const edges: Array<{ from: string; to: string; when?: boolean }> = [];
  nodes.push({
    id: "c1",
    type: "condition",
    label: `金额≥${thresholdCents / 100000}万`,
    expr: { field: "amount_cents", op: "gte", value: thresholdCents },
  });
  edges.push({ from: "s", to: "c1" });
  let prev = "c1";
  highChain.forEach((a, i) => {
    const id = `h${i + 1}`;
    nodes.push(approvalNode(id, a));
    edges.push({ from: prev, to: id, when: i === 0 ? true : undefined });
    prev = id;
  });
  nodes.push({ id: "e", type: "end" });
  edges.push({ from: prev, to: "e" });
  // 低分支单步（同首审批人）
  nodes.push(approvalNode("l1", lowApprover));
  edges.push({ from: "c1", to: "l1", when: false });
  edges.push({ from: "l1", to: "e" });
  return { nodes, edges };
}

/* ===== A5 页面问答（只读） ===== */

export function capabilityAnswer(): AiAction {
  return { type: "answer" };
}

export function detectCapability(content: string, ctx: AiContext): "form_prefill" | "time_draft" | "minutes_draft" | "flow_draft" | "answer" {
  if (/审批流|流程/.test(content)) return "flow_draft";
  if (/工时|打卡/.test(content)) return "time_draft";
  if (/纪要/.test(content)) return "minutes_draft";
  if (/预填|填写|帮我填|回填/.test(content) || (ctx.pageType.endsWith("_form") && /帮我|填/.test(content))) return "form_prefill";
  return "answer";
}
