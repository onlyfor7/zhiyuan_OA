import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { nextCode } from "../../src/db/code";
import { migrateFlowV1toV2, FlowMigrateAnomaly, type FlowV1Definition, type FlowV1Node } from "../../src/db/migrate/flow-v2";
import { runFlowV2Migration } from "../../src/db/migrate/run-flow-v2";
import { runSeed } from "../../src/db/seed";
import * as schema from "../../src/db/schema";
import { flowDefinitions } from "../../src/db/schema";
import { migrateFresh, migrateToLatest, TEST_DATABASE_URL } from "./helpers";

type Db = NodePgDatabase<typeof schema>;

interface DbHandle {
  db: Db;
  pool: pg.Pool;
}

async function openDb(): Promise<DbHandle> {
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
  return { pool, db: drizzle(pool, { schema }) };
}

/** 读取种子中某条默认流程的 v1 定义（用于纯函数单测的真实样例） */
async function readV1Flow(db: Db, name: string): Promise<FlowV1Definition> {
  const row = await db.select().from(flowDefinitions).where(eq(flowDefinitions.name, name));
  if (!row[0]) throw new Error(`流程 ${name} 缺失`);
  return row[0].definitionJson as unknown as FlowV1Definition;
}

describe("迭代 20 · 数据模型与 v1→v2 迁移（arch/14）", () => {
  it("干净库重放：custom_form_defs 新表/新列就位，迁移重复执行零漂移", async () => {
    await migrateFresh();
    await runSeed(TEST_DATABASE_URL);
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    const cols = await client.query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND (
         (table_name = 'custom_form_defs') OR
         (table_name = 'generic_requests' AND column_name IN ('payload','form_id','form_version')) OR
         (table_name = 'flow_definitions' AND column_name = 'definition_version')
       ) ORDER BY 1, 2`,
    );
    await client.end();
    const names = cols.rows.map((r) => `${r.table_name}.${r.column_name}`);
    expect(names).toContain("custom_form_defs.code");
    expect(names).toContain("custom_form_defs.visibility");
    expect(names).toContain("custom_form_defs.form_schema");
    expect(names).toContain("custom_form_defs.flow_id");
    expect(names).toContain("generic_requests.payload");
    expect(names).toContain("generic_requests.form_id");
    expect(names).toContain("generic_requests.form_version");
    expect(names).toContain("flow_definitions.definition_version");

    await migrateToLatest(); // 重复 migrate 零漂移（幂等）
  });

  it("migrateFlowV1toV2 纯函数：线性链/含条件双边/嵌套条件/$config 表达式原样保留；异常形态进 anomalies", async () => {
    // 20-02 §5 种子翻转后种子库不再含 v1 定义——纯函数用例改内联 v1 fixtures（等价旧种子形态）
    {
      const V = (id: string, label: string, approver: object): FlowV1Node => ({ id, type: "approval", label, approver } as FlowV1Node);
      const fixtures: Record<string, FlowV1Definition> = {
        "budget 默认流程": {
          nodes: [{ id: "start", type: "start" }, V("n1", "管理层审批", { kind: "role", role: "partner" }), { id: "end", type: "end" }],
          edges: [{ from: "start", to: "n1" }, { from: "n1", to: "end" }],
        },
        "change_request 默认流程": {
          nodes: [
            { id: "start", type: "start" },
            { id: "c1", type: "condition", label: "关键级延期", expr: { field: "level", op: "==", value: "key" } },
            V("n1", "管理层审批", { kind: "role", role: "partner" }),
            V("n2", "项目负责人审批", { kind: "project_manager" }),
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
        "travel 默认流程": {
          nodes: [
            { id: "start", type: "start" },
            { id: "c1", type: "condition", label: "借款出差", expr: { field: "borrow", op: "eq", value: true } },
            V("n1", "项目负责人审批", { kind: "project_manager" }),
            V("n2", "财务审批", { kind: "role", role: "finance" }),
            { id: "c2", type: "condition", label: "高额升级", expr: { field: "amount_cents", op: ">=", value: { $config: "approval.amount_thresholds.fundingManagementReviewCents" } } },
            V("n3", "项目负责人审批", { kind: "project_manager" }),
            V("n4", "管理层审批", { kind: "role", role: "partner" }),
            V("n5", "项目负责人审批", { kind: "project_manager" }),
            { id: "end", type: "end" },
          ],
          edges: [
            { from: "start", to: "c1" },
            { from: "c1", to: "n1", when: true },
            { from: "c1", to: "c2", when: false },
            { from: "n1", to: "n2" },
            { from: "n2", to: "end" },
            { from: "c2", to: "n3", when: true },
            { from: "c2", to: "n5", when: false },
            { from: "n3", to: "n4" },
            { from: "n4", to: "end" },
            { from: "n5", to: "end" },
          ],
        },
        "funding 高额双审演示流程": {
          nodes: [
            { id: "start", type: "start" },
            { id: "c1", type: "condition", label: "高额双审", expr: { field: "amount_cents", op: ">=", value: 5000000 } },
            V("n1", "项目负责人审批", { kind: "project_manager" }),
            V("n2", "管理层审批", { kind: "role", role: "partner" }),
            { id: "end", type: "end" },
          ],
          edges: [
            { from: "start", to: "c1" },
            { from: "c1", to: "n1", when: true },
            { from: "c1", to: "end", when: false },
            { from: "n1", to: "n2" },
            { from: "n2", to: "end" },
          ],
        },
        "funding 默认流程": {
          nodes: [
            { id: "start", type: "start" },
            { id: "c1", type: "condition", label: "高额升级", expr: { field: "amount_cents", op: ">=", value: { $config: "approval.amount_thresholds.fundingManagementReviewCents" } } },
            V("n1", "项目负责人审批", { kind: "project_manager" }),
            V("n2", "管理层审批", { kind: "role", role: "partner" }),
            V("n3", "项目负责人审批", { kind: "project_manager" }),
            { id: "end", type: "end" },
          ],
          edges: [
            { from: "start", to: "c1" },
            { from: "c1", to: "n1", when: true },
            { from: "c1", to: "n3", when: false },
            { from: "n1", to: "n2" },
            { from: "n2", to: "end" },
            { from: "n3", to: "end" },
          ],
        },
        "timesheet 默认流程": {
          nodes: [{ id: "start", type: "start" }, V("n1", "负责人审批", { kind: "initiator_manager" }), { id: "end", type: "end" }],
          edges: [{ from: "start", to: "n1" }, { from: "n1", to: "end" }],
        },
        "generic_request 默认流程": {
          nodes: [{ id: "start", type: "start" }, V("n1", "指定审批人", { kind: "initiator_choice" }), { id: "end", type: "end" }],
          edges: [{ from: "start", to: "n1" }, { from: "n1", to: "end" }],
        },
      };
      const readV1Flow = (name: string): FlowV1Definition => fixtures[name];
      // 线性链：budget 默认流程（partner 单步）
      const budget = migrateFlowV1toV2(readV1Flow("budget 默认流程"));
      expect(budget.schemaVersion).toBe(2);
      expect(budget.settings).toMatchObject({ allowWithdrawPending: true, dedupeApprover: "once" });
      expect(budget.nodes).toHaveLength(1);
      expect(budget.nodes[0]).toMatchObject({
        type: "approval",
        name: "管理层审批",
        approvalType: "manual",
        approver: { kind: "role", role: "partner" },
        sameAsInitiator: "skip",
        ops: { transfer: true, returnBack: "none", requireCommentOnReject: true, requireCommentOnApprove: false },
      });

      // 含条件双边：change_request（level=key→partner，else→pm）
      const change = migrateFlowV1toV2(readV1Flow("change_request 默认流程"));
      expect(change.nodes).toHaveLength(1);
      const changeCond = change.nodes[0] as Extract<(typeof change.nodes)[number], { type: "condition" }>;
      expect(changeCond.type).toBe("condition");
      expect(changeCond.branches).toHaveLength(2);
      expect(changeCond.branches[0]).toMatchObject({ name: "关键级延期", expr: { field: "level", op: "==", value: "key" } });
      expect(changeCond.branches[0].nodes[0]).toMatchObject({ type: "approval", approver: { kind: "role", role: "partner" } });
      expect(changeCond.branches[1].name).toBe("其他情况");
      expect(changeCond.branches[1].nodes[0]).toMatchObject({ type: "approval", approver: { kind: "project_manager" } });
      expect(changeCond.branches[1].expr).toBeUndefined(); // else 无 expr

      // 嵌套条件（else 内继续条件）：travel 默认流程
      const travel = migrateFlowV1toV2(readV1Flow("travel 默认流程"));
      const travelCond = travel.nodes[0] as Extract<(typeof travel.nodes)[number], { type: "condition" }>;
      expect(travelCond.branches[0].nodes.map((n) => (n as { approver?: { role?: string } }).approver?.role)).toEqual([
        undefined, // project_manager kind
        "finance",
      ]);
      const nested = travelCond.branches[1].nodes[0] as Extract<(typeof travel.nodes)[number], { type: "condition" }>;
      expect(nested.type).toBe("condition");
      // travel 金额条件已被 R9 改为 $config 阈值——迁移原样保留
      expect(nested.branches[0].expr).toMatchObject({
        field: "amount_cents",
        op: ">=",
        value: { $config: "approval.amount_thresholds.fundingManagementReviewCents" },
      });
      expect(nested.branches[1].name).toBe("其他情况");

      // 字面量阈值原样保留：funding 高额双审演示流程（5000000 字面量）
      const demo = migrateFlowV1toV2(readV1Flow("funding 高额双审演示流程"));
      const demoCond = demo.nodes[0] as Extract<(typeof demo.nodes)[number], { type: "condition" }>;
      expect(demoCond.branches[0].expr).toMatchObject({ field: "amount_cents", op: ">=", value: 5000000 });
      // $config 表达式原样保留：funding 默认流程
      const funding = migrateFlowV1toV2(readV1Flow("funding 默认流程"));
      const fundingCond = funding.nodes[0] as Extract<(typeof funding.nodes)[number], { type: "condition" }>;
      expect(fundingCond.branches[0].expr).toMatchObject({
        field: "amount_cents",
        op: ">=",
        value: { $config: "approval.amount_thresholds.fundingManagementReviewCents" },
      });

      // timesheet（initiator_manager 平移）+ generic_request（initiator_choice 平移）
      const timesheet = migrateFlowV1toV2(readV1Flow("timesheet 默认流程"));
      expect(timesheet.nodes[0]).toMatchObject({ type: "approval", approver: { kind: "initiator_manager" } });
      const generic = migrateFlowV1toV2(readV1Flow("generic_request 默认流程"));
      expect(generic.nodes[0]).toMatchObject({ type: "approval", approver: { kind: "initiator_choice" } });

      // 异常形态：缺 false 分支 → 抛 FlowMigrateAnomaly 且 anomalies 有细节
      const broken: FlowV1Definition = {
        nodes: [
          { id: "start", type: "start" },
          { id: "c1", type: "condition", expr: { field: "level", op: "==", value: "key" } },
          { id: "n1", type: "approval", label: "A", approver: { kind: "role", role: "partner" } },
          { id: "end", type: "end" },
        ],
        edges: [
          { from: "start", to: "c1" },
          { from: "c1", to: "n1", when: true },
          { from: "n1", to: "end" },
        ],
      };
      let caught: FlowMigrateAnomaly | null = null;
      try {
        migrateFlowV1toV2(broken);
      } catch (error) {
        caught = error as FlowMigrateAnomaly;
      }
      expect(caught).toBeInstanceOf(FlowMigrateAnomaly);
      expect(caught!.anomalies.some((a) => a.includes("双边分支不齐"))).toBe(true);
    }
  });

  it("迁移脚本：种子已 v2（20-02 §5 翻转）+ 合成 v1 存量行转换实证（备份+回执+二次零变更）", async () => {
    await migrateFresh();
    await runSeed(TEST_DATABASE_URL);
    const { db, pool } = await openDb();
    try {
      // 种子翻转后：全部种子流已 v2（脚本零待迁移）
      const all = await db.select({ definitionVersion: flowDefinitions.definitionVersion, definitionJson: flowDefinitions.definitionJson }).from(flowDefinitions);
      expect(all.length).toBeGreaterThanOrEqual(11);
      expect(all.every((f) => f.definitionVersion === 2)).toBe(true);
      expect(all.every((f) => (f.definitionJson as { schemaVersion?: number }).schemaVersion === 2)).toBe(true);

      // 合成一条 v1 存量行（模拟历史库）→ 脚本转换实证
      await db.insert(flowDefinitions).values({
        name: "legacy v1 flow",
        scope: "global",
        bizBinding: "legacy_biz",
        versionNo: 1,
        definitionJson: {
          nodes: [
            { id: "start", type: "start" },
            { id: "n1", type: "approval", label: "旧审批", approver: { kind: "role", role: "partner" } },
            { id: "end", type: "end" },
          ],
          edges: [{ from: "start", to: "n1" }, { from: "n1", to: "end" }],
        },
        definitionVersion: 1,
        enabled: false,
      });
      const receipt = await runFlowV2Migration(TEST_DATABASE_URL);
      expect(receipt.processed).toBe(1);
      expect(receipt.converted).toBe(1);
      expect(receipt.anomalies).toBe(0);
      expect(receipt.backupRows).toBe(all.length + 1); // 备份为全量快照（含种子 v2 行）
      expect(receipt.lines).toHaveLength(1);
      const converted = await db.select({ definitionJson: flowDefinitions.definitionJson }).from(flowDefinitions).where(eq(flowDefinitions.name, "legacy v1 flow"));
      expect((converted[0].definitionJson as { schemaVersion?: number }).schemaVersion).toBe(2);

      // 二次运行零变更（幂等）
      const second = await runFlowV2Migration(TEST_DATABASE_URL);
      expect(second.processed).toBe(0);
      expect(second.converted).toBe(0);
      expect(second.anomalies).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it("CF 编号：next_code('CF') 连续两号不重（水位=1 起步）", async () => {
    await migrateFresh();
    await runSeed(TEST_DATABASE_URL);
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    const db = drizzle(pool, { schema });
    try {
      // 水位行已就位（GREATEST 语义），next_code 连续取号不重号且递增
      const c1 = await nextCode("CF", db);
      const c2 = await nextCode("CF", db);
      expect(c1).not.toBe(c2);
      expect(Number(c1.split("-")[2]) + 1).toBe(Number(c2.split("-")[2]));
      expect(c1.startsWith("CF-")).toBe(true);
    } finally {
      await pool.end();
    }
  });
});
