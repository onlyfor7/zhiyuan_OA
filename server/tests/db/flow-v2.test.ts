import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { nextCode } from "../../src/db/code";
import { migrateFlowV1toV2, FlowMigrateAnomaly, type FlowV1Definition } from "../../src/db/migrate/flow-v2";
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
    await migrateFresh();
    await runSeed(TEST_DATABASE_URL);
    const { db, pool } = await openDb();
    try {
      // 线性链：budget 默认流程（partner 单步）
      const budget = migrateFlowV1toV2(await readV1Flow(db, "budget 默认流程"));
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
      const change = migrateFlowV1toV2(await readV1Flow(db, "change_request 默认流程"));
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
      const travel = migrateFlowV1toV2(await readV1Flow(db, "travel 默认流程"));
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
      const demo = migrateFlowV1toV2(await readV1Flow(db, "funding 高额双审演示流程"));
      const demoCond = demo.nodes[0] as Extract<(typeof demo.nodes)[number], { type: "condition" }>;
      expect(demoCond.branches[0].expr).toMatchObject({ field: "amount_cents", op: ">=", value: 5000000 });
      // $config 表达式原样保留：funding 默认流程
      const funding = migrateFlowV1toV2(await readV1Flow(db, "funding 默认流程"));
      const fundingCond = funding.nodes[0] as Extract<(typeof funding.nodes)[number], { type: "condition" }>;
      expect(fundingCond.branches[0].expr).toMatchObject({
        field: "amount_cents",
        op: ">=",
        value: { $config: "approval.amount_thresholds.fundingManagementReviewCents" },
      });

      // timesheet（initiator_manager 平移）+ generic_request（initiator_choice 平移）
      const timesheet = migrateFlowV1toV2(await readV1Flow(db, "timesheet 默认流程"));
      expect(timesheet.nodes[0]).toMatchObject({ type: "approval", approver: { kind: "initiator_manager" } });
      const generic = migrateFlowV1toV2(await readV1Flow(db, "generic_request 默认流程"));
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
    } finally {
      await pool.end();
    }
  });

  it("迁移脚本：种子库全量转换（备份表+回执+二次零变更）", async () => {
    await migrateFresh();
    await runSeed(TEST_DATABASE_URL);
    const flowCount = 11; // 10 默认 + 1 演示

    const receipt = await runFlowV2Migration(TEST_DATABASE_URL);
    expect(receipt.processed).toBe(flowCount);
    expect(receipt.converted).toBe(flowCount);
    expect(receipt.anomalies).toBe(0);
    expect(receipt.backupRows).toBe(flowCount);
    expect(receipt.lines).toHaveLength(flowCount);

    const { db, pool } = await openDb();
    try {
      const remaining = await db.select({ id: flowDefinitions.id }).from(flowDefinitions).where(eq(flowDefinitions.definitionVersion, 1));
      expect(remaining).toHaveLength(0);
      const all = await db.select({ definitionVersion: flowDefinitions.definitionVersion, definitionJson: flowDefinitions.definitionJson }).from(flowDefinitions);
      expect(all.every((f) => f.definitionVersion === 2)).toBe(true);
      expect(all.every((f) => (f.definitionJson as { schemaVersion?: number }).schemaVersion === 2)).toBe(true);
    } finally {
      await pool.end();
    }

    // 二次运行零变更（幂等）
    const second = await runFlowV2Migration(TEST_DATABASE_URL);
    expect(second.processed).toBe(0);
    expect(second.converted).toBe(0);
    expect(second.anomalies).toBe(0);
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
