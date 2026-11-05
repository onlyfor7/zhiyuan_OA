import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runSeed } from "../../src/db/seed";
import * as schema from "../../src/db/schema";
import { clients, flowDefinitions, genericRequests, matters, paymentReceipts, projects, users } from "../../src/db/schema";
import { resolveConfigValue } from "../../src/services/approval/flow";
import { ALL_TABLES, migrateFresh, TEST_DATABASE_URL } from "./helpers";

const YEAR = new Date().getFullYear();
const TODAY = new Date().toISOString().slice(0, 10);

type Db = NodePgDatabase<typeof schema>;

interface DbHandle {
  db: Db;
  pool: pg.Pool;
}

async function openDb(): Promise<DbHandle> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  return { pool, db: drizzle(pool, { schema }) };
}

async function expectPgViolation(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e as { cause?: { code?: string } },
  );
  expect(error).not.toBeNull();
  expect(error?.cause?.code).toBe(code);
}

async function countRows(): Promise<Record<string, number>> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  const counts: Record<string, number> = {};
  for (const table of ALL_TABLES) {
    const result = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
    counts[table] = result.rows[0].n;
  }
  await client.end();
  return counts;
}

/* ===== 策略迁移等价性解析器（测试内复刻旧策略语义与新流程语义） ===== */

type Form = Record<string, unknown>;
type StepSpec = { approver: Record<string, unknown>; countersign: string };

interface PolicyRow {
  bizType: string;
  priority: number;
  matchJson: Record<string, unknown>;
  stepsJson: Array<Record<string, unknown>>;
}

interface FlowRow {
  bizBinding: string;
  enabled: boolean;
  projectId: string | null;
  definitionJson: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
}

type ConfigRow = { key: string; valueJson: Record<string, unknown> };

function matchPolicy(matchJson: Record<string, unknown>, form: Form): boolean {
  return Object.entries(matchJson).every(([key, value]) =>
    key === "min_amount_cents" || key === "min_estimated_cost_cents"
      ? Number(form.amount_cents ?? 0) >= Number(value)
      : form[key] === value,
  );
}

/** 旧语义：biz_type+priority 升序，match_json 全命中即中 */
function resolvePolicy(policies: PolicyRow[], bizType: string, form: Form): StepSpec[] | null {
  const rows = policies.filter((p) => p.bizType === bizType).sort((a, b) => a.priority - b.priority);
  const hit = rows.find((r) => matchPolicy(r.matchJson, form));
  if (!hit) return null;
  return hit.stepsJson.map((s) => ({
    approver:
      s.approver_role === "project_manager"
        ? { kind: "project_manager" }
        : { kind: "role", role: s.approver_role },
    countersign: (s.countersign as string) ?? "any",
  }));
}

function evalExpr(expr: Record<string, unknown>, form: Form, configRows: ConfigRow[]): boolean {
  const value = form[expr.field as string];
  // R8：与生产同语义——$config 引用按 system_config 求值（缺键回退字面量 5000000）
  const raw = expr.value;
  const expected =
    raw !== null && typeof raw === "object" && typeof (raw as { $config?: unknown }).$config === "string"
      ? (resolveConfigValue(configRows, (raw as { $config: string }).$config) ?? 5000000)
      : raw;
  return expr.op === ">=" ? Number(value ?? 0) >= Number(expected) : value === expected;
}

/** 新语义：从 start 沿 edges 走，条件节点按 when 求值，收集 approval 节点 */
function resolveFlow(flow: FlowRow, form: Form, configRows: ConfigRow[]): StepSpec[] {
  const { nodes, edges } = flow.definitionJson;
  let nodeId = "start";
  const steps: StepSpec[] = [];
  const visited = new Set<string>();
  while (nodeId !== "end") {
    if (visited.has(nodeId)) throw new Error(`flow cycle at ${nodeId}`);
    visited.add(nodeId);
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`node ${nodeId} missing`);
    if (node.type === "approval") {
      steps.push({
        approver: node.approver as Record<string, unknown>,
        countersign: (node.countersign as string) ?? "any",
      });
    }
    const outs = edges.filter((e) => e.from === nodeId);
    const next =
      node.type === "condition"
        ? outs.find((e) => e.when === evalExpr(node.expr as Record<string, unknown>, form, configRows))
        : outs[0];
    if (!next) throw new Error(`dangling node ${nodeId}`);
    nodeId = next.to as string;
  }
  return steps;
}

describe("扩展域种子与约束（arch/09）", () => {
  it("干净库重放 53 表齐备：八默认流程+演示流程/佳力奇/收款三笔/类型配置，二次执行幂等", async () => {
    await migrateFresh();
    await runSeed(TEST_DATABASE_URL);
    const counts = await countRows();
    expect(counts.payment_receipts).toBe(3);
    expect(counts.flow_definitions).toBe(11); // 10 默认（含 09b 补的 travel_change/generic_request）+ 1 演示（disabled）
    expect(counts.generic_requests).toBe(0);
    expect(counts.code_sequences).toBe(22); // 19 + LD/OPP/CTR（9c）
    expect(counts.system_config).toBe(17); // + timesheet.step_minutes（arch/11）+ 保留期两键（9a-04 §14.5）

    const { db, pool } = await openDb();
    try {
      // 佳力奇主数据（承工单 06）
      const jia = await db.select({ name: clients.name }).from(clients).where(eq(clients.code, `CLT-${YEAR}-00003`));
      expect(jia[0].name).toBe("佳力奇（虚构）");
      const jiaMatter = await db
        .select({ name: matters.name })
        .from(matters)
        .where(eq(matters.code, `MTR-${YEAR}-00003`));
      expect(jiaMatter[0].name).toBe("佳力奇技术服务");

      // 收款口径：A 实收 = Σregistered − Σvoided（原额）= 500,000+300,000−200,000
      const projectA = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.code, `PRJ-${YEAR}-00001`));
      const receiptAgg = await db
        .select({
          registered: sql<string>`coalesce(sum(${paymentReceipts.amountCents}) filter (where ${paymentReceipts.status} = 'registered'), 0)::text`,
          voided: sql<string>`coalesce(sum(${paymentReceipts.amountCents}) filter (where ${paymentReceipts.status} = 'voided'), 0)::text`,
        })
        .from(paymentReceipts)
        .where(eq(paymentReceipts.projectId, projectA[0].id));
      expect(Number(receiptAgg[0].registered) - Number(receiptAgg[0].voided)).toBe(600000);

      // 通用申请单类型配置
      const cfg = await db
        .select({ valueJson: schema.systemConfig.valueJson })
        .from(schema.systemConfig)
        .where(eq(schema.systemConfig.key, "generic_request.types"));
      expect((cfg[0].valueJson as { types: Array<{ key: string }> }).types.map((t) => t.key)).toEqual([
        "leave",
        "procurement",
        "seal",
        "other",
      ]);

      // 演示流程存在且未启用（默认 funding 流程仍唯一生效）
      const demo = await db
        .select({ enabled: flowDefinitions.enabled })
        .from(flowDefinitions)
        .where(eq(flowDefinitions.name, "funding 高额双审演示流程"));
      expect(demo[0].enabled).toBe(false);
    } finally {
      await pool.end();
    }

    await runSeed(TEST_DATABASE_URL);
    const before = await countRows();
    await runSeed(TEST_DATABASE_URL);
    const after = await countRows();
    expect(after).toEqual(before);
  });

  it("收款/流程/申请单约束：金额>0、unique(name,version)、每 name 单 enabled", async () => {
    const { db, pool } = await openDb();
    try {
      const projectA = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.code, `PRJ-${YEAR}-00001`));
      const client1 = await db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.code, `CLT-${YEAR}-00001`));
      const finance = await db.select({ id: users.id }).from(users).where(eq(users.email, "guojingwen@lexflow.demo"));

      await expectPgViolation(
        db.insert(paymentReceipts).values({
          code: `RCV-${YEAR}-90001`,
          projectId: projectA[0].id,
          clientId: client1[0].id,
          amountCents: 0,
          receivedOn: TODAY,
          referenceNo: "X",
          createdBy: finance[0].id,
          updatedBy: finance[0].id,
        }),
        "23514",
      );

      // 同 name 同 version 必败
      await expectPgViolation(
        db.insert(flowDefinitions).values({
          name: "budget 默认流程",
          scope: "global",
          bizBinding: "budget",
          versionNo: 1,
          definitionJson: { nodes: [], edges: [] },
        }),
        "23505",
      );
      // 同 name 双 enabled 必败（部分唯一索引）
      await expectPgViolation(
        db.insert(flowDefinitions).values({
          name: "budget 默认流程",
          scope: "global",
          bizBinding: "budget",
          versionNo: 2,
          definitionJson: { nodes: [], edges: [] },
          enabled: true,
        }),
        "23505",
      );
      // 新版本 + enabled=false 可建
      await expect(
        db
          .insert(flowDefinitions)
          .values({
            name: "budget 默认流程",
            scope: "global",
            bizBinding: "budget",
            versionNo: 2,
            definitionJson: { nodes: [], edges: [] },
            enabled: false,
          })
          .returning({ id: flowDefinitions.id }),
      ).resolves.toHaveLength(1);

      // 通用申请单五态可写
      const member = await db.select({ id: users.id }).from(users).where(eq(users.email, "guanchen@lexflow.demo"));
      for (const [i, status] of ["draft", "pending_approval", "approved", "rejected", "withdrawn"].entries()) {
        await expect(
          db
            .insert(genericRequests)
            .values({
              code: `REQ-${YEAR}-900${i}`,
              requestType: "leave",
              title: "枚举测试",
              reason: "测试",
              applicantId: member[0].id,
              status: status as never,
            })
            .returning({ id: genericRequests.id }),
        ).resolves.toHaveLength(1);
      }
    } finally {
      await pool.end();
    }
  });

  it("种子自愈（09b 打回修复）：同名种子默认流旧规格行重跑 seed 被修正为当前规格（initiator_choice）", async () => {
    const { db, pool } = await openDb();
    try {
      const stale = await db
        .select({ id: flowDefinitions.id, definitionJson: flowDefinitions.definitionJson })
        .from(flowDefinitions)
        .where(eq(flowDefinitions.name, "generic_request 默认流程"));
      expect(stale).toHaveLength(1);
      // 预置旧规格（project_manager 单步）模拟 09b 首版遗留行
      await db
        .update(flowDefinitions)
        .set({
          definitionJson: {
            nodes: [
              { id: "start", type: "start" },
              { id: "n1", type: "approval", label: "项目负责人审批", approver: { kind: "project_manager" }, countersign: "any" },
              { id: "end", type: "end" },
            ],
            edges: [
              { from: "start", to: "n1" },
              { from: "n1", to: "end" },
            ],
          },
        })
        .where(eq(flowDefinitions.id, stale[0].id));

      await runSeed(TEST_DATABASE_URL);

      const healed = await db
        .select({ definitionJson: flowDefinitions.definitionJson })
        .from(flowDefinitions)
        .where(eq(flowDefinitions.id, stale[0].id));
      const nodes = (healed[0].definitionJson as { nodes: Array<{ type: string; approver?: { kind: string; role?: string } }> }).nodes;
      const approval = nodes.find((n) => n.type === "approval");
      expect(approval?.approver).toEqual({ kind: "initiator_choice" });
    } finally {
      await pool.end();
    }
  });

  it("策略迁移等价性：新旧解析出的步骤集一致（既有审批行为不变）", async () => {
    const { db, pool } = await openDb();
    try {
      const policies = (await db.select().from(schema.approvalPolicies)) as unknown as PolicyRow[];
      const flows = (await db.select().from(flowDefinitions)) as unknown as FlowRow[];
      const configRows = (await db.select().from(schema.systemConfig)) as unknown as ConfigRow[];

      const scenarios: Array<[string, Form]> = [
        ["change_request", { level: "key" }],
        ["change_request", { level: "normal" }],
        ["travel", { borrow: true }],
        ["travel", { borrow: false, amount_cents: 6000000 }],
        ["travel", { borrow: false, amount_cents: 100000 }],
        ["travel_change", {}],
        ["funding", { amount_cents: 6000000 }],
        ["funding", { amount_cents: 100000 }],
        ["expense", {}],
        ["expense_adjustment", {}],
        ["budget", {}],
        ["access_grant", {}],
      ];
      for (const [bizType, form] of scenarios) {
        const fromPolicy = resolvePolicy(policies, bizType, form);
        const flow = flows.find((f) => f.bizBinding === bizType && f.enabled && f.projectId === null);
        expect(flow, `${bizType} 应有唯一 enabled 默认流程`).toBeTruthy();
        const fromFlow = resolveFlow(flow!, form, configRows);
        expect(fromFlow, `${bizType} ${JSON.stringify(form)}`).toEqual(fromPolicy);
      }

      // 09b 补强：每个引擎接入的 biz_type 恰有 ≥1 条 enabled 全局默认流程（防策略迁移再漏）
      const ENGINE_BIZ_TYPES = [
        "change_request",
        "travel",
        "travel_change",
        "funding",
        "expense",
        "expense_adjustment",
        "budget",
        "access_grant",
        "timesheet",
        "generic_request",
      ];
      for (const bizType of ENGINE_BIZ_TYPES) {
        const defaults = flows.filter(
          (f) => f.bizBinding === bizType && f.enabled && f.projectId === null,
        );
        expect(defaults.length, `${bizType} 应有 ≥1 条 enabled 默认流程`).toBeGreaterThanOrEqual(1);
      }

      // arch/11 G3：generic_request 全局默认流解析必须为 [initiator_choice]（发起人指定；09b partner 兜底被 G3 取代）
      const genericFlow = flows.find((f) => f.bizBinding === "generic_request" && f.enabled && f.projectId === null)!;
      expect(resolveFlow(genericFlow, {}, configRows)).toEqual([
        { approver: { kind: "initiator_choice" }, countersign: "any" },
      ]);

      // timesheet：占位策略 ↔ 运行时解析节点（initiator_manager）
      const tsPolicy = policies.find((p) => p.bizType === "timesheet");
      expect((tsPolicy!.stepsJson[0] as { runtime_resolve?: boolean }).runtime_resolve).toBe(true);
      const tsFlow = flows.find((f) => f.bizBinding === "timesheet" && f.enabled);
      const approvalNodes = tsFlow!.definitionJson.nodes.filter((n) => n.type === "approval");
      expect(approvalNodes).toHaveLength(1);
      expect((approvalNodes[0].approver as { kind: string }).kind).toBe("initiator_manager");
    } finally {
      await pool.end();
    }
  });
});
