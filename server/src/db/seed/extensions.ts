import { and, eq, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";

import * as schema from "../schema";
import { clients, flowDefinitions, matters, paymentReceipts, projects, users } from "../schema";

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

/* ===== flow definition_json 构建（arch/09 §3.1 冻结结构） ===== */

interface FlowNode {
  id: string;
  type: "start" | "end" | "approval" | "condition";
  label?: string;
  approver?: { kind: string; role?: string; userId?: string };
  countersign?: string;
  expr?: { field: string; op: string; value: unknown };
}

interface FlowEdge {
  from: string;
  to: string;
  when?: boolean;
}

interface FlowSpec {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

/** 线性流程：start → 各审批节点 → end */
function linearFlow(steps: Array<{ label: string; approver: FlowNode["approver"]; countersign?: string }>): FlowSpec {
  const nodes: FlowNode[] = [{ id: "start", type: "start" }];
  const edges: FlowEdge[] = [];
  let prev = "start";
  steps.forEach((step, i) => {
    const id = `n${i + 1}`;
    nodes.push({ id, type: "approval", label: step.label, approver: step.approver, countersign: step.countersign ?? "any" });
    edges.push({ from: prev, to: id });
    prev = id;
  });
  nodes.push({ id: "end", type: "end" });
  edges.push({ from: prev, to: "end" });
  return { nodes, edges };
}

const role = (r: string): FlowNode["approver"] => ({ kind: "role", role: r });
const PM = { kind: "project_manager" } as FlowNode["approver"];

/** 八条默认流程：既有 approval_policies 种子行的等价迁移（arch/09 §3.1；策略表保留只读兼容） */
const DEFAULT_FLOWS: Array<{ name: string; bizBinding: string; spec: FlowSpec; note: string }> = [
  {
    name: "change_request 默认流程",
    bizBinding: "change_request",
    note: "level=key → partner；否则 project_manager（等价原 p10/p20 两条策略）",
    spec: {
      nodes: [
        { id: "start", type: "start" },
        { id: "c1", type: "condition", label: "关键级延期", expr: { field: "level", op: "==", value: "key" } },
        { id: "n1", type: "approval", label: "管理层审批", approver: role("partner") },
        { id: "n2", type: "approval", label: "项目负责人审批", approver: PM },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "c1" },
        { from: "c1", to: "n1", when: true },
        { from: "c1", to: "n2", when: false },
        { from: "n1", to: "end" },
        { from: "n2", to: "end" },
      ],
    },
  },
  {
    name: "travel 默认流程",
    bizBinding: "travel",
    note: "borrow=true → pm+finance 会签 all；金额≥5万 → pm→partner 两步；默认 pm（等价原 p10/p20/p100 三条）",
    spec: {
      nodes: [
        { id: "start", type: "start" },
        { id: "c1", type: "condition", label: "借款出差", expr: { field: "borrow", op: "==", value: true } },
        { id: "c2", type: "condition", label: "金额≥5万", expr: { field: "amount_cents", op: ">=", value: 5000000 } },
        { id: "n1", type: "approval", label: "项目负责人审批", approver: PM },
        { id: "n2", type: "approval", label: "财务会签", approver: role("finance"), countersign: "all" },
        { id: "n3", type: "approval", label: "项目负责人审批", approver: PM },
        { id: "n4", type: "approval", label: "管理层审批", approver: role("partner") },
        { id: "n5", type: "approval", label: "项目负责人审批", approver: PM },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "c1" },
        { from: "c1", to: "n1", when: true },
        { from: "n1", to: "n2" },
        { from: "n2", to: "end" },
        { from: "c1", to: "c2", when: false },
        { from: "c2", to: "n3", when: true },
        { from: "n3", to: "n4" },
        { from: "n4", to: "end" },
        { from: "c2", to: "n5", when: false },
        { from: "n5", to: "end" },
      ],
    },
  },
  {
    name: "funding 默认流程",
    bizBinding: "funding",
    note: "金额≥5万 → pm→partner 两步；默认 pm（等价原 p10/p100 两条）",
    spec: {
      nodes: [
        { id: "start", type: "start" },
        { id: "c1", type: "condition", label: "金额≥5万", expr: { field: "amount_cents", op: ">=", value: 5000000 } },
        { id: "n1", type: "approval", label: "项目负责人审批", approver: PM },
        { id: "n2", type: "approval", label: "管理层审批", approver: role("partner") },
        { id: "n3", type: "approval", label: "项目负责人审批", approver: PM },
        { id: "end", type: "end" },
      ],
      edges: [
        { from: "start", to: "c1" },
        { from: "c1", to: "n1", when: true },
        { from: "n1", to: "n2" },
        { from: "n2", to: "end" },
        { from: "c1", to: "n3", when: false },
        { from: "n3", to: "end" },
      ],
    },
  },
  {
    name: "expense 默认流程",
    bizBinding: "expense",
    note: "pm → finance（等价原默认策略）",
    spec: linearFlow([
      { label: "项目负责人审批", approver: PM },
      { label: "财务审批", approver: role("finance") },
    ]),
  },
  {
    name: "expense_adjustment 默认流程",
    bizBinding: "expense_adjustment",
    note: "partner 单步终审（迭代 3 R3 特批：调整单发起不限角色，finance 步骤会自审被拦）",
    spec: linearFlow([{ label: "管理层审批", approver: role("partner") }]),
  },
  {
    name: "budget 默认流程",
    bizBinding: "budget",
    note: "partner（等价原默认策略）",
    spec: linearFlow([{ label: "管理层审批", approver: role("partner") }]),
  },
  {
    name: "access_grant 默认流程",
    bizBinding: "access_grant",
    note: "archivist（等价原默认策略）",
    spec: linearFlow([{ label: "档案管理员审批", approver: role("archivist") }]),
  },
  {
    name: "timesheet 默认流程",
    bizBinding: "timesheet",
    note: "审批人运行时解析（arch/07 §4.2：pm→partner 不自审；否则主项目 manager；无项目明细→默认审批人配置）——等价原占位策略",
    spec: linearFlow([{ label: "运行时解析（arch/07 §4.2）", approver: { kind: "initiator_manager" } }]),
  },
];

/** 演示：带金额条件+会签的 funding 自定义流程（enabled=false，默认流程仍生效，避免同 biz_binding 双启用歧义） */
const FUNDING_DEMO_FLOW = {
  name: "funding 高额双审演示流程",
  bizBinding: "funding",
  spec: {
    nodes: [
      { id: "start", type: "start" as const },
      { id: "c1", type: "condition" as const, label: "金额≥5万", expr: { field: "amount_cents", op: ">=", value: 5000000 } },
      { id: "n1", type: "approval" as const, label: "项目负责人审批", approver: PM },
      { id: "n2", type: "approval" as const, label: "管理层会签", approver: role("partner"), countersign: "all" },
      { id: "n3", type: "approval" as const, label: "项目负责人审批", approver: PM },
      { id: "end", type: "end" as const },
    ],
    edges: [
      { from: "start", to: "c1" },
      { from: "c1", to: "n1", when: true },
      { from: "n1", to: "n2" },
      { from: "n2", to: "end" },
      { from: "c1", to: "n3", when: false },
      { from: "n3", to: "end" },
    ],
  },
  note: "设计器演示数据：金额条件 + 会签 all；默认流程仍启用（enabled=false 待发布）",
};

async function userIdByEmail(tx: SeedTx, email: string): Promise<string> {
  const row = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!row[0]) throw new Error(`种子依赖用户 ${email} 缺失`);
  return row[0].id;
}

async function ensureFlow(
  tx: SeedTx,
  flow: { name: string; bizBinding: string; spec: FlowSpec; note: string; enabled?: boolean },
  actorId: string,
): Promise<void> {
  const existing = await tx
    .select({ id: flowDefinitions.id })
    .from(flowDefinitions)
    .where(and(eq(flowDefinitions.name, flow.name), eq(flowDefinitions.versionNo, 1)));
  if (!existing[0]) {
    await tx.insert(flowDefinitions).values({
      name: flow.name,
      scope: "global",
      bizBinding: flow.bizBinding,
      versionNo: 1,
      definitionJson: flow.spec as unknown as Record<string, unknown>,
      enabled: flow.enabled ?? true,
      createdBy: actorId,
      updatedBy: actorId,
    });
  }
}

export async function seedExtensions(tx: SeedTx): Promise<void> {
  const pmId = await userIdByEmail(tx, "pm@lexflow.demo");
  const memberId = await userIdByEmail(tx, "member@lexflow.demo");
  const financeId = await userIdByEmail(tx, "finance@lexflow.demo");

  // 1) 八条默认流程（策略等价迁移）+ 一条演示流程
  for (const flow of DEFAULT_FLOWS) {
    await ensureFlow(tx, flow, pmId);
  }
  await ensureFlow(tx, { ...FUNDING_DEMO_FLOW, enabled: false }, pmId);

  // 2) 佳力奇客户/事项（承工单 06 试用单；主数据无 UI 属已知缺口，种子提供）
  const cltCode = `CLT-${YEAR}-00004`;
  const cltExisting = await tx.select({ id: clients.id }).from(clients).where(eq(clients.code, cltCode));
  if (!cltExisting[0]) {
    await tx.insert(clients).values({
      code: cltCode,
      name: "佳力奇科技（虚构）",
      confidentialityLevel: "internal",
      createdBy: pmId,
      updatedBy: pmId,
    });
  }
  const clientId = (
    await tx.select({ id: clients.id }).from(clients).where(eq(clients.code, cltCode))
  )[0].id;
  const mtrCode = `MTR-${YEAR}-00004`;
  const mtrExisting = await tx.select({ id: matters.id }).from(matters).where(eq(matters.code, mtrCode));
  if (!mtrExisting[0]) {
    await tx.insert(matters).values({
      code: mtrCode,
      clientId,
      name: "佳力奇咨询",
      type: "非诉",
      createdBy: pmId,
      updatedBy: pmId,
    });
  }

  // 3) 收款演示数据：项目 A（华宸）两笔 registered + 一笔 voided（更正=作废+新登记，不删行）
  const projectA = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.code, `PRJ-${YEAR}-00001`));
  const client1Id = (
    await tx.select({ id: clients.id }).from(clients).where(eq(clients.code, `CLT-${YEAR}-00001`))
  )[0].id;

  const receipts = [
    {
      code: `RCV-${YEAR}-00001`,
      amountCents: 500000,
      receivedOn: fmt(addDays(TODAY, -20)),
      referenceNo: "BK20261008-001",
      payerName: "华宸贸易有限公司",
      note: "一审代理费首期到账",
      status: "registered" as const,
      voidReason: null,
    },
    {
      code: `RCV-${YEAR}-00002`,
      amountCents: 300000,
      receivedOn: fmt(addDays(TODAY, -8)),
      referenceNo: "BK20261020-002",
      payerName: "华宸贸易有限公司",
      note: "专项服务费到账",
      status: "registered" as const,
      voidReason: null,
    },
    {
      code: `RCV-${YEAR}-00003`,
      amountCents: 200000,
      receivedOn: fmt(addDays(TODAY, -15)),
      referenceNo: "BK20261010-003",
      payerName: "华宸贸易有限公司",
      note: "重复登记冲正（原单作废，不删行）",
      status: "voided" as const,
      voidReason: "重复登记：与 RCV-00001 系同笔回款",
    },
  ];
  for (const r of receipts) {
    const existing = await tx.select({ id: paymentReceipts.id }).from(paymentReceipts).where(eq(paymentReceipts.code, r.code));
    if (!existing[0]) {
      await tx.insert(paymentReceipts).values({
        code: r.code,
        projectId: projectA[0].id,
        clientId: client1Id,
        amountCents: r.amountCents,
        receivedOn: r.receivedOn,
        referenceNo: r.referenceNo,
        payerName: r.payerName,
        note: r.note,
        status: r.status,
        voidReason: r.voidReason,
        voidedBy: r.status === "voided" ? financeId : null,
        voidedAt: r.status === "voided" ? addDays(TODAY, -14).toISOString() : null,
        createdBy: financeId,
        updatedBy: financeId,
      });
    }
  }

  // 4) 编号序列水位对齐（RCV/REQ，各自独立 GREATEST）
  for (const [prefix, next] of [["RCV", 4], ["REQ", 1]] as const) {
    await tx.execute(
      sql.raw(
        `INSERT INTO code_sequences (prefix, year, next_value) VALUES ('${prefix}', ${YEAR}, ${next}) ` +
          `ON CONFLICT (prefix, year) DO UPDATE SET next_value = GREATEST(code_sequences.next_value, ${next})`,
      ),
    );
  }
}
