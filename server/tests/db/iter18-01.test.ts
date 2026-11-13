import { and, eq, isNull, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { runSeed } from "../../src/db/seed";
import * as schema from "../../src/db/schema";
import {
  auditEvents,
  crmContracts,
  crmLeads,
  crmOpportunities,
  matters,
  planItems,
  planVersions,
  projectMembers,
  projects,
  projectTemplates,
  roles,
  stages,
  userRoles,
  users,
} from "../../src/db/schema";
import { ALL_TABLES, migrateFresh, TEST_DATABASE_URL } from "./helpers";

const YEAR = new Date().getFullYear();

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

interface BackfillReceipt {
  processed: number;
  reused: number;
  created: number;
  lost_backfilled: number;
  lost_fallback: number;
  anomalies: number;
}

async function runBackfill(): Promise<BackfillReceipt> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  const result = await client.query<BackfillReceipt>(`SELECT * FROM crm_backfill_opportunity_projects()`);
  await client.end();
  return result.rows[0];
}

describe("迭代 18 工单 01：角色层级与商机立项数据模型（arch/13 §3/§5）", () => {
  it("干净库重放：新列/索引/约束/补齐函数全部就位", async () => {
    await migrateFresh();
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await client.connect();
    try {
      // 新列与可空性（arch/13 §3.2/§5.2/§5.3 + 工单 01b 幂等键）
      const cols = await client.query<{ table_name: string; column_name: string; is_nullable: string }>(
        `SELECT table_name, column_name, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND (
           (table_name = 'users' AND column_name = 'manager_id') OR
           (table_name = 'crm_leads' AND column_name = 'code') OR
           (table_name = 'crm_opportunities' AND column_name IN ('source_lead_id', 'presales_id', 'project_id', 'closed_reason', 'closed_at', 'idempotency_key'))
         )`,
      );
      const nullable = new Map(cols.rows.map((r) => [`${r.table_name}.${r.column_name}`, r.is_nullable]));
      expect(nullable.get("users.manager_id")).toBe("YES");
      expect(nullable.get("crm_leads.code")).toBe("YES"); // 线索去编号：历史值保留、新数据可空
      for (const col of ["source_lead_id", "presales_id", "project_id", "closed_reason", "closed_at", "idempotency_key"]) {
        expect(nullable.get(`crm_opportunities.${col}`), `${col} 应可空`).toBe("YES");
      }

      // 索引与唯一约束
      const idx = await client.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
           'users_manager_id_idx', 'crm_opportunities_project_id_unique',
           'crm_opportunities_source_lead_id_idx', 'crm_opportunities_presales_id_idx',
           'crm_opportunities_idempotency_key_unique')`,
      );
      const byName = new Map(idx.rows.map((r) => [r.indexname, r.indexdef]));
      expect(byName.size).toBe(5);
      expect(byName.get("crm_opportunities_project_id_unique")).toContain("UNIQUE");
      // 工单 01b：幂等键部分唯一索引（仅约束非空键，历史/未传键行 NULL 不互撞）
      const idemIdx = byName.get("crm_opportunities_idempotency_key_unique") ?? "";
      expect(idemIdx).toContain("UNIQUE");
      expect(idemIdx.toLowerCase()).toContain("where");
      expect(idemIdx.toLowerCase()).toContain("idempotency_key is not null");

      // 自引用 check 与补齐函数
      const chk = await client.query(`SELECT conname FROM pg_constraint WHERE conname = 'users_manager_not_self'`);
      expect(chk.rows).toHaveLength(1);
      const fn = await client.query(`SELECT proname FROM pg_proc WHERE proname = 'crm_backfill_opportunity_projects'`);
      expect(fn.rows).toHaveLength(1);

      // 干净库空跑补齐：全零、无异常、不写回执审计行
      const receipt = await client.query<BackfillReceipt>(`SELECT * FROM crm_backfill_opportunity_projects()`);
      expect(receipt.rows[0]).toEqual({ processed: 0, reused: 0, created: 0, lost_backfilled: 0, lost_fallback: 0, anomalies: 0 });
    } finally {
      await client.end();
    }
  });

  it("种子就位：六角色/演示主管树/售前模板/演示商机 D5 完备；二次执行幂等不重复立项", async () => {
    await runSeed(TEST_DATABASE_URL);
    const counts = await countRows();
    // 计数口径（18-01 合理变化，详见交接）：14 角色、29 用户、商机唯一项目 ×2（1 新建 + 1 复用）、售前计划 ×2、档案目录 +11
    expect(counts.roles).toBe(14);
    expect(counts.users).toBe(29);
    expect(counts.user_roles).toBe(30);
    expect(counts.clients).toBe(5);
    expect(counts.matters).toBe(6);
    expect(counts.projects).toBe(6);
    expect(counts.project_members).toBe(17);
    expect(counts.stages).toBe(12);
    expect(counts.plan_versions).toBe(4);
    expect(counts.plan_items).toBe(26);
    expect(counts.project_templates).toBe(3);
    expect(counts.archive_directories).toBe(66);
    expect(counts.code_sequences).toBe(24);

    const { db, pool } = await openDb();
    try {
      // 六角色（arch/13 §3.1 名称口径）
      const roleRows = await db.select().from(roles);
      const roleByKey = new Map(roleRows.map((r) => [r.key, r.name]));
      expect(roleByKey.get("sales")).toBe("销售");
      expect(roleByKey.get("sales_manager")).toBe("销售主管");
      expect(roleByKey.get("presales")).toBe("售前");
      expect(roleByKey.get("operations")).toBe("运营");
      expect(roleByKey.get("regional_vp")).toBe("大区 VP");
      expect(roleByKey.get("ceo")).toBe("CEO");

      // 演示主管树：销售 A/B、售前 → 销售主管 → 大区 VP → CEO；运营 → CEO；CEO 无主管
      const tree = await db.execute(sql`
        SELECT u.email AS email, m.email AS manager_email
        FROM users u LEFT JOIN users m ON m.id = u.manager_id
        WHERE u.email IN (
          'sumingxuan@lexflow.demo', 'linwanqing@lexflow.demo', 'hezhiyuan@lexflow.demo',
          'zhenghaoran@lexflow.demo', 'gaojunling@lexflow.demo', 'xuwenjing@lexflow.demo', 'songqiming@lexflow.demo')
      `);
      const managerOf = new Map(tree.rows.map((r) => [r.email as string, r.manager_email as string | null]));
      expect(managerOf.get("sumingxuan@lexflow.demo")).toBe("zhenghaoran@lexflow.demo");
      expect(managerOf.get("linwanqing@lexflow.demo")).toBe("zhenghaoran@lexflow.demo");
      expect(managerOf.get("hezhiyuan@lexflow.demo")).toBe("zhenghaoran@lexflow.demo");
      expect(managerOf.get("zhenghaoran@lexflow.demo")).toBe("gaojunling@lexflow.demo");
      expect(managerOf.get("gaojunling@lexflow.demo")).toBe("songqiming@lexflow.demo");
      expect(managerOf.get("xuwenjing@lexflow.demo")).toBe("songqiming@lexflow.demo");
      expect(managerOf.get("songqiming@lexflow.demo")).toBeNull();
      // 角色分配
      const demoRoles = await db
        .select({ email: users.email, roleKey: userRoles.roleKey })
        .from(userRoles)
        .innerJoin(users, eq(users.id, userRoles.userId));
        const roleOf = (email: string) => demoRoles.filter((r) => r.email === email).map((r) => r.roleKey);
      expect(roleOf("sumingxuan@lexflow.demo")).toEqual(["sales"]);
      expect(roleOf("zhenghaoran@lexflow.demo")).toEqual(["sales_manager"]);
      expect(roleOf("hezhiyuan@lexflow.demo")).toEqual(["presales"]);
      expect(roleOf("xuwenjing@lexflow.demo")).toEqual(["operations"]);
      expect(roleOf("gaojunling@lexflow.demo")).toEqual(["regional_vp"]);
      expect(roleOf("songqiming@lexflow.demo")).toEqual(["ceo"]);

      // 售前模板（两档种子均含；节点=需求调研/方案与报价/商务签约）
      const tpl = await db.select().from(projectTemplates).where(eq(projectTemplates.name, "售前项目模板"));
      expect(tpl).toHaveLength(1);
      const tplStages = (tpl[0].structureJson as { stages: Array<{ name: string; seq: number; days?: number }> }).stages;
      expect(tplStages.map((s) => [s.name, s.seq, s.days ?? 14])).toEqual([
        ["需求调研", 1, 14],
        ["方案与报价", 2, 14],
        ["商务签约", 3, 14],
      ]);

      // 演示商机 D5：OPP-00001 新建唯一项目（preparing/售前/王宝茁 manager+owner/首版售前计划/售前指派）
      const opp1 = await db.select().from(crmOpportunities).where(eq(crmOpportunities.code, `OPP-${YEAR}-00001`));
      expect(opp1[0].projectId).toBeTruthy();
      const presalesUser = await db.select({ id: users.id }).from(users).where(eq(users.email, "hezhiyuan@lexflow.demo"));
      expect(opp1[0].presalesId).toBe(presalesUser[0].id);
      const p1 = await db.select().from(projects).where(eq(projects.id, opp1[0].projectId!));
      expect(p1[0]).toMatchObject({ lifecycleStatus: "preparing", type: "售前", name: "比博思特运维续约商机项目" });
      const pmUser = await db.select({ id: users.id }).from(users).where(eq(users.email, "wangbaozhuo@lexflow.demo"));
      expect(p1[0].managerId).toBe(pmUser[0].id);
      const m1 = await db.select().from(matters).where(eq(matters.id, p1[0].matterId));
      expect(m1[0]).toMatchObject({ name: "比博思特运维续约商机", type: "售前", clientId: opp1[0].customerId });
      const mem1 = await db.select().from(projectMembers).where(eq(projectMembers.projectId, p1[0].id));
      expect(mem1.map((m) => [m.userId, m.projectRole])).toEqual([[pmUser[0].id, "manager"]]);

      // 演示商机 D5：OPP-00002 唯一确认复用 PRJ-00005（禁止新建）、in_progress、成员与首版售前计划
      const opp2 = await db.select().from(crmOpportunities).where(eq(crmOpportunities.code, `OPP-${YEAR}-00002`));
      const gdProject = await db.select().from(projects).where(eq(projects.code, `PRJ-${YEAR}-00005`));
      expect(opp2[0].projectId).toBe(gdProject[0].id); // 复用既有项目，未新建
      expect(gdProject[0].lifecycleStatus).toBe("in_progress"); // won + active 合同
      const gdMatterProjects = await db.select({ id: projects.id }).from(projects).where(eq(projects.matterId, gdProject[0].matterId));
      expect(gdMatterProjects).toHaveLength(1); // 一项目最多一商机、未因商机重复建项目

      // 两演示商机项目均具备首版售前计划（v1 baseline active + 三阶段 plan_items）
      for (const projectId of [p1[0].id, gdProject[0].id]) {
        const plan = await db
          .select()
          .from(planVersions)
          .where(and(eq(planVersions.projectId, projectId), eq(planVersions.versionNo, 1)));
        expect(plan).toHaveLength(1);
        expect(plan[0]).toMatchObject({ kind: "baseline", status: "active" });
        const items = await db
          .select({ name: planItems.name, seq: planItems.seq, itemType: planItems.itemType })
          .from(planItems)
          .where(eq(planItems.planVersionId, plan[0].id))
          .orderBy(planItems.seq);
        expect(items.map((i) => [i.name, i.seq, i.itemType])).toEqual([
          ["需求调研", 1, "stage"],
          ["方案与报价", 2, "stage"],
          ["商务签约", 3, "stage"],
        ]);
        const projectStages = await db.select({ name: stages.name }).from(stages).where(eq(stages.projectId, projectId));
        expect(projectStages.map((s) => s.name).sort()).toEqual(["商务签约", "方案与报价", "需求调研"]);
      }

      // 种子级存量勾稽：全部商机均已关联唯一项目，补齐函数复跑全零（无重复立项）
      const unlinked = await db.select({ id: crmOpportunities.id }).from(crmOpportunities).where(isNull(crmOpportunities.projectId));
      expect(unlinked).toHaveLength(0);
    } finally {
      await pool.end();
    }
    const receiptAfterSeed = await runBackfill();
    expect(receiptAfterSeed).toEqual({ processed: 0, reused: 0, created: 0, lost_backfilled: 0, lost_fallback: 0, anomalies: 0 });

    // 二次种子幂等：行数不变、不重复立项
    await runSeed(TEST_DATABASE_URL);
    const again = await countRows();
    expect(again).toEqual(counts);
  });

  it("约束：多行 NULL 线索 code 共存、历史 LD 唯一不冲突；一项目挂两商机 23505；主管自引用 23514", async () => {
    const { db, pool } = await openDb();
    try {
      // 线索去编号：同表多行 code = null 可共存（PG 唯一约束允许多 NULL）
      const inserted = await db
        .insert(crmLeads)
        .values([{ name: "无编号线索甲" }, { name: "无编号线索乙" }])
        .returning({ id: crmLeads.id });
      expect(inserted).toHaveLength(2);
      // 历史非空 code 唯一约束仍在
      await expectPgViolation(
        db.insert(crmLeads).values({ code: `LD-${YEAR}-00001`, name: "撞号线索" }),
        "23505",
      );

      // 一项目最多一商机
      const opp1 = await db.select().from(crmOpportunities).where(eq(crmOpportunities.code, `OPP-${YEAR}-00001`));
      await expectPgViolation(
        db.insert(crmOpportunities).values({
          code: "OPP-TEST-DUP-PROJECT",
          customerId: opp1[0].customerId,
          name: "抢占既有项目的商机",
          projectId: opp1[0].projectId,
        }),
        "23505",
      );

      // 工单 01b：幂等键部分唯一索引——多行 NULL 共存；相同非空 key 第二行 23505
      const idemNulls = await db
        .insert(crmOpportunities)
        .values([
          { code: "OPP-TEST-IDEM-1", customerId: opp1[0].customerId, name: "无幂等键商机甲" },
          { code: "OPP-TEST-IDEM-2", customerId: opp1[0].customerId, name: "无幂等键商机乙" },
        ])
        .returning({ id: crmOpportunities.id });
      expect(idemNulls).toHaveLength(2);
      await db
        .insert(crmOpportunities)
        .values({ code: "OPP-TEST-IDEM-3", customerId: opp1[0].customerId, name: "幂等键商机", idempotencyKey: "idem-test-18-01b" });
      await expectPgViolation(
        db.insert(crmOpportunities).values({
          code: "OPP-TEST-IDEM-4",
          customerId: opp1[0].customerId,
          name: "幂等键重放商机",
          idempotencyKey: "idem-test-18-01b",
        }),
        "23505",
      );

      // 主管不得自引用
      await expectPgViolation(
        db.execute(sql`UPDATE users SET manager_id = id WHERE email = 'sumingxuan@lexflow.demo'`),
        "23514",
      );

      // 自清：删掉本用例新建的两条无编号线索与三条幂等键商机（均无业务引用；商机 project_id 均为 NULL，不干扰后续补齐勾稽用例）
      await db.delete(crmLeads).where(sql`${crmLeads.id} IN (${inserted[0].id}, ${inserted[1].id})`);
      await db.delete(crmOpportunities).where(sql`${crmOpportunities.code} IN ('OPP-TEST-IDEM-1', 'OPP-TEST-IDEM-2', 'OPP-TEST-IDEM-3')`);
    } finally {
      await pool.end();
    }
  });

  it("存量补齐回执与实际行勾稽：复用/新建/lost 审计快照回填分类计数，复跑全零", async () => {
    const { db, pool } = await openDb();
    const createdIds = { opps: [] as string[], matters: [] as string[], contracts: [] as string[] };
    try {
      const pm = await db.select({ id: users.id }).from(users).where(eq(users.email, "wangbaozhuo@lexflow.demo"));
      const client = await db.select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.code, `CLT-${YEAR}-00002`));
      const pmId = pm[0].id;
      const customerId = client[0].id;

      // L1：lost 存量商机（无项目、无关闭信息）+ markLost 审计快照
      const l1 = await db
        .insert(crmOpportunities)
        .values({ code: "OPP-TEST-BF-1", customerId, name: "存量输单商机", stage: "lost", ownerId: pmId, createdBy: pmId, updatedBy: pmId })
        .returning({ id: crmOpportunities.id });
      createdIds.opps.push(l1[0].id);
      await db.insert(auditEvents).values({
        action: "crm.opportunities.markLost",
        targetType: "crm_opportunity",
        targetId: l1[0].id,
        result: "success",
        afterJson: { reason: "客户预算冻结" },
        createdAt: "2026-10-01T08:00:00.000Z",
      });

      // L2：开放存量商机（无项目）
      const l2 = await db
        .insert(crmOpportunities)
        .values({ code: "OPP-TEST-BF-2", customerId, name: "存量开放商机", stage: "proposal", ownerId: pmId, createdBy: pmId, updatedBy: pmId })
        .returning({ id: crmOpportunities.id });
      createdIds.opps.push(l2[0].id);

      // L3：won 存量商机 + 合同挂既有事项（该事项恰一个既有项目 → 唯一确认复用）
      const m3 = await db
        .insert(matters)
        .values({ code: "MTR-TEST-BF-3", clientId: customerId, name: "存量既有事项", type: "技术服务", createdBy: pmId, updatedBy: pmId })
        .returning({ id: matters.id });
      createdIds.matters.push(m3[0].id);
      const p3 = await db
        .insert(projects)
        .values({ code: "PRJ-TEST-BF-3", matterId: m3[0].id, name: "存量既有项目", managerId: pmId, lifecycleStatus: "preparing", createdBy: pmId, updatedBy: pmId })
        .returning({ id: projects.id });
      const l3 = await db
        .insert(crmOpportunities)
        .values({ code: "OPP-TEST-BF-3", customerId, name: "存量赢单商机", stage: "won", ownerId: pmId, createdBy: pmId, updatedBy: pmId })
        .returning({ id: crmOpportunities.id });
      createdIds.opps.push(l3[0].id);
      const c3 = await db
        .insert(crmContracts)
        .values({ code: "CTR-TEST-BF-3", opportunityId: l3[0].id, customerId, matterId: m3[0].id, title: "存量赢单合同", amountCents: 100000, status: "active", createdBy: pmId, updatedBy: pmId })
        .returning({ id: crmContracts.id });
      createdIds.contracts.push(c3[0].id);
      await db.update(crmOpportunities).set({ wonContractId: c3[0].id }).where(eq(crmOpportunities.id, l3[0].id));

      const projectsBefore = (await db.select({ id: projects.id }).from(projects)).length;
      const mattersBefore = (await db.select({ id: matters.id }).from(matters)).length;

      // 执行补齐并核验回执分类计数
      const receipt = await runBackfill();
      expect(receipt).toEqual({ processed: 3, reused: 1, created: 2, lost_backfilled: 1, lost_fallback: 0, anomalies: 0 });

      // 回执与实际行勾稽
      expect((await db.select({ id: projects.id }).from(projects)).length).toBe(projectsBefore + 2);
      expect((await db.select({ id: matters.id }).from(matters)).length).toBe(mattersBefore + 2);

      // L1：新建 closed 项目 + 审计快照回填关闭原因/时间
      const l1After = await db.select().from(crmOpportunities).where(eq(crmOpportunities.id, l1[0].id));
      expect(l1After[0].projectId).toBeTruthy();
      expect(l1After[0].closedReason).toBe("客户预算冻结");
      expect(new Date(l1After[0].closedAt as unknown as string).toISOString()).toBe("2026-10-01T08:00:00.000Z");
      const l1Project = await db.select().from(projects).where(eq(projects.id, l1After[0].projectId!));
      expect(l1Project[0].lifecycleStatus).toBe("closed");
      expect(l1Project[0].managerId).toBe(pmId); // 无既有项目负责人 → 商机负责人

      // L2：新建 preparing 项目 + 成员（manager=owner 一行）
      const l2After = await db.select().from(crmOpportunities).where(eq(crmOpportunities.id, l2[0].id));
      const l2Project = await db.select().from(projects).where(eq(projects.id, l2After[0].projectId!));
      expect(l2Project[0].lifecycleStatus).toBe("preparing");
      const l2Members = await db.select().from(projectMembers).where(eq(projectMembers.projectId, l2Project[0].id));
      expect(l2Members.map((m) => [m.userId, m.projectRole])).toEqual([[pmId, "manager"]]);

      // L3：复用既有项目（未新建），won+active 合同 → in_progress；成员补 manager
      const l3After = await db.select().from(crmOpportunities).where(eq(crmOpportunities.id, l3[0].id));
      expect(l3After[0].projectId).toBe(p3[0].id);
      const p3After = await db.select().from(projects).where(eq(projects.id, p3[0].id));
      expect(p3After[0].lifecycleStatus).toBe("in_progress");
      const p3Members = await db.select().from(projectMembers).where(eq(projectMembers.projectId, p3[0].id));
      expect(p3Members.map((m) => [m.userId, m.projectRole])).toEqual([[pmId, "manager"]]);

      // 迁移补齐只负责关联/成员/生命周期/关闭回填，不代建售前计划（计划归种子与 18-02 运行时）
      const l2Plans = await db.select({ id: planVersions.id }).from(planVersions).where(eq(planVersions.projectId, l2Project[0].id));
      expect(l2Plans).toHaveLength(0);

      // 复跑幂等：无待处理商机 → 全零
      const again = await runBackfill();
      expect(again).toEqual({ processed: 0, reused: 0, created: 0, lost_backfilled: 0, lost_fallback: 0, anomalies: 0 });

      // 自清（后续 db 测试文件均 migrateFresh，但保持库内不残留本用例业务行；audit_events 只追加由触发器保护，快照行留存至下次重放）
      // 顺序：成员（按项目全量）→ 解除 opp.won_contract_id 循环引用 → 合同 → 商机 → 项目/事项
      const cleanupProjectIds = [l1After[0].projectId, l2After[0].projectId, p3[0].id].filter((x): x is string => Boolean(x));
      for (const projectId of cleanupProjectIds) {
        await db.delete(projectMembers).where(eq(projectMembers.projectId, projectId));
      }
      await db.update(crmOpportunities).set({ wonContractId: null }).where(eq(crmOpportunities.id, l3[0].id));
      for (const contractId of createdIds.contracts) {
        await db.delete(crmContracts).where(eq(crmContracts.id, contractId));
      }
      for (const oppId of createdIds.opps) {
        await db.delete(crmOpportunities).where(eq(crmOpportunities.id, oppId));
      }
      // 补齐新建的项目/事项（L1/L2）一并清理
      for (const opp of [l1After[0], l2After[0]]) {
        if (opp.projectId) {
          const proj = await db.select({ matterId: projects.matterId }).from(projects).where(eq(projects.id, opp.projectId));
          await db.delete(projects).where(eq(projects.id, opp.projectId));
          if (proj[0]) await db.delete(matters).where(eq(matters.id, proj[0].matterId));
        }
      }
      await db.delete(projects).where(eq(projects.id, p3[0].id));
      await db.delete(matters).where(eq(matters.id, m3[0].id));
    } finally {
      await pool.end();
    }
  });
});
