import { eq, sql, and } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import pg from "pg";
import { pathToFileURL } from "node:url";

import { hashPassword } from "../../lib/password";
import { loadEnvFile, requireDatabaseUrl } from "../env";
import * as schema from "../schema";
import { archiveDirectories, clients, companyProfile, matters, orgUnits, projectMembers, projects, roles, systemConfig, userRoles, users } from "../schema";
import { SYSTEM_CONFIG_DEFAULTS } from "./config-defaults";
import { seedClosure } from "./closure";
import { seedCollab } from "./collab";
import { seedCrm } from "./crm";
import { seedDefaultFlows, seedExtensions } from "./extensions";
import { seedFin } from "./fin";
import { seedFinance } from "./finance";
import { seedGovernance, seedTemplates } from "./governance";
import { seedTime } from "./time";

type DbOrTx =
  | NodePgDatabase<typeof schema>
  | NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;

const DEMO_PASSWORD = "Demo@2026";
const YEAR = new Date().getFullYear();

/** 组织树：1 组织 + 3 部门（arch/00 §8） */
const ORG_FIRM = "因诺智元";
const ORG_DEPARTMENTS = ["诉讼业务部", "非诉业务部", "综合管理部"] as const;

/** 8 角色（arch/03 §1，冻结） */
const ROLE_SEED = [
  { key: "partner", name: "管理层/合伙人", description: "项目组合监督、重大审批；按管辖项目范围" },
  { key: "project_manager", name: "项目负责人", description: "项目内全权（受职责分离约束）" },
  { key: "member", name: "项目成员", description: "本人业务创建、项目内按授权查看" },
  { key: "quality_lead", name: "质量负责人", description: "质量工作流 + 涉质量决策参与" },
  { key: "finance", name: "财务/经费管理员", description: "预算/经费/费用/支付处理；不含法律文件内容" },
  { key: "archivist", name: "档案管理员", description: "归档、完整性、授权管理" },
  { key: "sysadmin", name: "权限/系统管理员", description: "组织、角色、参数配置；不默认读取业务内容" },
  { key: "viewer", name: "只读查阅人", description: "仅经 AccessGrant 的限定范围与期限" },
] as const;

interface UserSeed {
  email: string;
  name: string;
  roleKeys: string[];
  org?: string;
  /** arch/12 §9 员工信息：岗位/工号（YN-001 序列）/入职日期 */
  position: string;
  employeeNo: string;
  joinedAt: string;
}

/**
 * 用户名单（arch/11 G1，2026-10-30 用户指定，全虚构演示口径；口令统一 Demo@2026）。
 * 邮箱=姓名拼音全小写；梁奇烽双挂 partner+quality_lead。
 */
const USER_SEED: UserSeed[] = [
  { email: "liangqifeng@lexflow.demo", name: "梁奇烽", roleKeys: ["partner", "quality_lead"], org: "综合管理部", position: "合伙人", employeeNo: "YN-001", joinedAt: "2015-03-02" },
  { email: "guojingwen@lexflow.demo", name: "郭静文", roleKeys: ["finance"], org: "综合管理部", position: "财务主管", employeeNo: "YN-002", joinedAt: "2016-05-09" },
  { email: "wangying@lexflow.demo", name: "王颖", roleKeys: ["archivist"], org: "综合管理部", position: "档案管理员", employeeNo: "YN-003", joinedAt: "2017-02-13" },
  { email: "zhaokai@lexflow.demo", name: "赵凯", roleKeys: ["sysadmin"], org: "综合管理部", position: "系统管理员", employeeNo: "YN-004", joinedAt: "2017-09-11" },
  { email: "hejing@lexflow.demo", name: "何静", roleKeys: ["viewer"], position: "查阅专员", employeeNo: "YN-005", joinedAt: "2018-03-19" },
  { email: "wangbaozhuo@lexflow.demo", name: "王宝茁", roleKeys: ["project_manager"], org: "诉讼业务部", position: "项目负责人", employeeNo: "YN-006", joinedAt: "2019-04-01" },
  { email: "wangjiayu@lexflow.demo", name: "王家玉", roleKeys: ["project_manager"], org: "诉讼业务部", position: "项目负责人", employeeNo: "YN-007", joinedAt: "2019-06-17" },
  { email: "sunhaoxiang@lexflow.demo", name: "孙浩祥", roleKeys: ["project_manager"], org: "诉讼业务部", position: "项目负责人", employeeNo: "YN-008", joinedAt: "2020-03-23" },
  { email: "liaoyimin@lexflow.demo", name: "廖益敏", roleKeys: ["project_manager"], org: "诉讼业务部", position: "项目负责人", employeeNo: "YN-009", joinedAt: "2020-07-06" },
  { email: "huoda@lexflow.demo", name: "霍达", roleKeys: ["project_manager"], org: "非诉业务部", position: "项目负责人", employeeNo: "YN-010", joinedAt: "2021-02-22" },
  { email: "maozhenyu@lexflow.demo", name: "毛振宇", roleKeys: ["project_manager"], org: "非诉业务部", position: "项目负责人", employeeNo: "YN-011", joinedAt: "2021-08-30" },
  { email: "lijie@lexflow.demo", name: "李洁", roleKeys: ["project_manager"], org: "非诉业务部", position: "项目负责人", employeeNo: "YN-012", joinedAt: "2022-03-14" },
  { email: "guanchen@lexflow.demo", name: "管晨", roleKeys: ["member"], org: "诉讼业务部", position: "项目工程师", employeeNo: "YN-013", joinedAt: "2022-06-20" },
  { email: "zhangchen@lexflow.demo", name: "张琛", roleKeys: ["member"], org: "诉讼业务部", position: "项目工程师", employeeNo: "YN-014", joinedAt: "2022-09-05" },
  { email: "lijianwei@lexflow.demo", name: "李见微", roleKeys: ["member"], org: "诉讼业务部", position: "项目工程师", employeeNo: "YN-015", joinedAt: "2023-01-09" },
  { email: "zhaofengxue@lexflow.demo", name: "赵凤学", roleKeys: ["member"], org: "诉讼业务部", position: "项目工程师", employeeNo: "YN-016", joinedAt: "2023-04-11" },
  { email: "chenyue@lexflow.demo", name: "陈玥", roleKeys: ["member"], org: "诉讼业务部", position: "项目工程师", employeeNo: "YN-017", joinedAt: "2023-07-17" },
  { email: "tianyiming@lexflow.demo", name: "田伊铭", roleKeys: ["member"], org: "诉讼业务部", position: "项目工程师", employeeNo: "YN-018", joinedAt: "2023-10-23" },
  { email: "niuchenchen@lexflow.demo", name: "牛琛琛", roleKeys: ["member"], org: "诉讼业务部", position: "测试工程师", employeeNo: "YN-019", joinedAt: "2024-02-26" },
  { email: "caojiani@lexflow.demo", name: "曹佳妮", roleKeys: ["member"], org: "非诉业务部", position: "法务专员", employeeNo: "YN-020", joinedAt: "2024-05-13" },
  { email: "lishuo@lexflow.demo", name: "李硕", roleKeys: ["member"], org: "非诉业务部", position: "法务专员", employeeNo: "YN-021", joinedAt: "2024-08-19" },
  { email: "liumingle@lexflow.demo", name: "刘明乐", roleKeys: ["member"], org: "非诉业务部", position: "法务专员", employeeNo: "YN-022", joinedAt: "2024-11-25" },
];

/**
 * 5 客户 + 5 事项 + 5 项目（arch/11 G1 名单配套，虚构演示口径）。
 * 权限验收布局保持（工单 00 场景 1/2 语义）：王宝茁负责 00001 且为 00002 成员（可见两个）；
 * 管晨仅 00001 成员；00003 对二者均不可见。
 */
const ARCHIVE_DIRECTORIES = [
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

async function ensureArchiveDirs(tx: DbOrTx, projectId: string): Promise<void> {
  for (const dir of ARCHIVE_DIRECTORIES) {
    const existing = await tx
      .select({ id: archiveDirectories.id })
      .from(archiveDirectories)
      .where(and(eq(archiveDirectories.projectId, projectId), eq(archiveDirectories.dirKey, dir.dirKey)));
    if (!existing[0]) {
      await tx.insert(archiveDirectories).values({ projectId, ...dir });
    }
  }
}

const CLIENT_SEED = [
  { code: `CLT-${YEAR}-00001`, name: "比博思特（虚构）", level: "internal" as const },
  { code: `CLT-${YEAR}-00002`, name: "金通灵（虚构）", level: "confidential" as const },
  { code: `CLT-${YEAR}-00003`, name: "佳力奇（虚构）", level: "internal" as const },
  { code: `CLT-${YEAR}-00004`, name: "合规运作规则引擎上市公司（虚构）", level: "confidential" as const },
  { code: `CLT-${YEAR}-00005`, name: "GD（虚构）", level: "internal" as const },
];

const MATTER_SEED = [
  { code: `MTR-${YEAR}-00001`, clientCode: `CLT-${YEAR}-00001`, name: "比博思特技术服务", type: "技术服务" },
  { code: `MTR-${YEAR}-00002`, clientCode: `CLT-${YEAR}-00002`, name: "金通灵技术服务", type: "技术服务" },
  { code: `MTR-${YEAR}-00003`, clientCode: `CLT-${YEAR}-00003`, name: "佳力奇技术服务", type: "技术服务" },
  { code: `MTR-${YEAR}-00004`, clientCode: `CLT-${YEAR}-00004`, name: "合规运作规则引擎上市公司 1.0", type: "软件开发" },
  { code: `MTR-${YEAR}-00005`, clientCode: `CLT-${YEAR}-00005`, name: "GD 法律服务", type: "法律服务" },
];

const PROJECT_SEED = [
  {
    code: `PRJ-${YEAR}-00001`,
    matterCode: `MTR-${YEAR}-00001`,
    name: "比博思特技术服务项目",
    type: "技术服务",
    managerEmail: "wangbaozhuo@lexflow.demo",
    level: "internal" as const,
    lifecycle: "in_progress" as const,
    health: "normal" as const,
    members: [
      { email: "wangbaozhuo@lexflow.demo", projectRole: "manager" },
      { email: "guanchen@lexflow.demo", projectRole: "member" },
      { email: "zhangchen@lexflow.demo", projectRole: "member" },
      { email: "lijianwei@lexflow.demo", projectRole: "member" },
    ],
  },
  {
    code: `PRJ-${YEAR}-00002`,
    matterCode: `MTR-${YEAR}-00002`,
    name: "金通灵技术服务项目",
    type: "技术服务",
    managerEmail: "wangjiayu@lexflow.demo",
    level: "confidential" as const,
    lifecycle: "in_progress" as const,
    health: "warning" as const,
    members: [
      { email: "wangjiayu@lexflow.demo", projectRole: "manager" },
      { email: "wangbaozhuo@lexflow.demo", projectRole: "member" },
      { email: "zhaofengxue@lexflow.demo", projectRole: "member" },
    ],
  },
  {
    code: `PRJ-${YEAR}-00003`,
    matterCode: `MTR-${YEAR}-00003`,
    name: "佳力奇技术服务项目",
    type: "技术服务",
    managerEmail: "sunhaoxiang@lexflow.demo",
    level: "internal" as const,
    lifecycle: "preparing" as const,
    health: "normal" as const,
    members: [
      { email: "sunhaoxiang@lexflow.demo", projectRole: "manager" },
      { email: "tianyiming@lexflow.demo", projectRole: "member" },
    ],
  },
  {
    code: `PRJ-${YEAR}-00004`,
    matterCode: `MTR-${YEAR}-00004`,
    name: "合规运作规则引擎上市公司 1.0 项目",
    type: "软件开发",
    managerEmail: "liaoyimin@lexflow.demo",
    level: "confidential" as const,
    lifecycle: "in_progress" as const,
    health: "at_risk" as const,
    members: [
      { email: "liaoyimin@lexflow.demo", projectRole: "manager" },
      { email: "chenyue@lexflow.demo", projectRole: "member" },
      { email: "niuchenchen@lexflow.demo", projectRole: "member" },
    ],
  },
  {
    code: `PRJ-${YEAR}-00005`,
    matterCode: `MTR-${YEAR}-00005`,
    name: "GD 法律服务项目",
    type: "法律服务",
    managerEmail: "huoda@lexflow.demo",
    level: "public" as const,
    lifecycle: "preparing" as const,
    health: "normal" as const,
    members: [
      { email: "huoda@lexflow.demo", projectRole: "manager" },
      { email: "caojiani@lexflow.demo", projectRole: "member" },
      { email: "lishuo@lexflow.demo", projectRole: "member" },
      { email: "liumingle@lexflow.demo", projectRole: "member" },
    ],
  },
];

async function ensureOrgUnit(db: DbOrTx, name: string, parentId: string | null, sort = 0): Promise<string> {
  const existing = await db.select({ id: orgUnits.id, sort: orgUnits.sort }).from(orgUnits).where(eq(orgUnits.name, name));
  if (existing[0]) {
    if (existing[0].sort !== sort) {
      await db.update(orgUnits).set({ sort }).where(eq(orgUnits.id, existing[0].id));
    }
    return existing[0].id;
  }
  const inserted = await db.insert(orgUnits).values({ name, parentId, sort }).returning({ id: orgUnits.id });
  return inserted[0].id;
}

async function ensureUser(db: DbOrTx, seed: UserSeed, orgId: string | undefined, passwordHash: string): Promise<string> {
  const existing = await db
    .select({ id: users.id, employeeNo: users.employeeNo })
    .from(users)
    .where(eq(users.email, seed.email));
  if (existing[0]) {
    // 存量行回填（arch/12 §9 升级列；仅当工号未填时补齐，不覆盖运行期编辑）
    if (existing[0].employeeNo === null) {
      await db
        .update(users)
        .set({ position: seed.position, employeeNo: seed.employeeNo, joinedAt: seed.joinedAt, orgUnitId: orgId ?? null })
        .where(eq(users.id, existing[0].id));
    }
    return existing[0].id;
  }
  const inserted = await db
    .insert(users)
    .values({
      email: seed.email,
      name: seed.name,
      passwordHash,
      orgUnitId: orgId ?? null,
      position: seed.position,
      employeeNo: seed.employeeNo,
      joinedAt: seed.joinedAt,
    })
    .returning({ id: users.id });
  return inserted[0].id;
}

async function idByCode<T extends { id: string }>(
  db: DbOrTx,
  select: Promise<T[]>,
  insert: () => Promise<unknown>,
): Promise<string> {
  const existing = await select;
  if (!existing[0]) {
    await insert();
    const inserted = await select;
    if (!inserted[0]) throw new Error("插入后回读失败");
    return inserted[0].id;
  }
  return existing[0].id;
}

export type SeedProfile = "full" | "minimal";

/** 全部编号前缀水位（minimal 档亦建全表，full 档经 GREATEST 上移不冲突） */
const WATER_FLOORS: Array<[string, number]> = [
  ["CLT", 6],
  ["MTR", 6],
  ["PRJ", 6],
  ["STG", 11],
  ["MLS", 4],
  ["TSK", 17],
  ["DLV", 4],
  ["QLT", 3],
  ["DEC", 2],
  ["RPT", 2],
  ["MTG", 4],
  ["TRV", 3],
  ["BUD", 3],
  ["FND", 4],
  ["EXP", 3],
  ["LED", 8],
  ["TS", 4],
  ["RCV", 4],
  ["REQ", 1],
];

async function seedWaterLevels(tx: DbOrTx): Promise<void> {
  for (const [prefix, next] of WATER_FLOORS) {
    await tx.execute(
      sql.raw(
        `INSERT INTO code_sequences (prefix, year, next_value) VALUES ('${prefix}', ${YEAR}, ${next}) ` +
          `ON CONFLICT (prefix, year) DO UPDATE SET next_value = GREATEST(code_sequences.next_value, ${next})`,
      ),
    );
  }
}

/** 基础件：组织树 + 8 角色 + 12 用户 + system_config 全量默认配置（两档共用） */
async function seedFoundation(tx: DbOrTx): Promise<void> {
  // 组织树
  // 品牌更名兼容（迭代 9b）：旧根名就地改名，幂等——二次执行无旧名行即空操作；prod 下次种子时同步生效
  await tx.update(orgUnits).set({ name: ORG_FIRM }).where(eq(orgUnits.name, "示例律师事务所"));
  const firmId = await ensureOrgUnit(tx, ORG_FIRM, null, 0);
  const deptIds = new Map<string, string>();
  for (const [i, dept] of ORG_DEPARTMENTS.entries()) {
    deptIds.set(dept, await ensureOrgUnit(tx, dept, firmId, i + 1)); // 根级部门 sort 1..3
  }


  // 角色
  for (const role of ROLE_SEED) {
    await tx
      .insert(roles)
      .values({ key: role.key, name: role.name, description: role.description })
      .onConflictDoNothing();
  }

  // 用户 + 全局角色分配（二次执行不重复建行、不重算口令散列；支持双角色）
  const passwordHash = hashPassword(DEMO_PASSWORD);
  const userIds = new Map<string, string>();
  for (const userSeed of USER_SEED) {
    const orgId = userSeed.org ? deptIds.get(userSeed.org) : undefined;
    const userId = await ensureUser(tx, userSeed, orgId, passwordHash);
    userIds.set(userSeed.email, userId);
    for (const roleKey of userSeed.roleKeys) {
      await tx.insert(userRoles).values({ userId, roleKey }).onConflictDoNothing();
    }
  }
  if (!userIds.get("wangbaozhuo@lexflow.demo")) throw new Error("种子用户 wangbaozhuo@lexflow.demo 缺失");
  // 公司信息（单记录，arch/12 §9；既有行不覆盖运行期编辑）
  const profileExisting = await tx.select({ id: companyProfile.id }).from(companyProfile).limit(1);
  if (!profileExisting[0]) {
    await tx.insert(companyProfile).values({
      name: "因诺智元",
      creditCode: "91320500MA1YNZY66A",
      address: "苏州市工业园区星湖街328号创意产业园A座5层（虚构）",
      phone: "0512-6688-9900（虚构）",
      bankName: "中国工商银行苏州星湖支行（虚构）",
      bankAccount: "1102 0290 0900 1234 567（虚构）",
      createdBy: userIds.get("zhaokai@lexflow.demo"),
      updatedBy: userIds.get("zhaokai@lexflow.demo"),
    });
  }
  const pmId = userIds.get("wangbaozhuo@lexflow.demo")!;

  // system_config 默认配置（需求基线 §18 全量 + 迭代 4/6 增补键）
  for (const config of SYSTEM_CONFIG_DEFAULTS) {
    await tx
      .insert(systemConfig)
      .values({ key: config.key, valueJson: config.value, updatedBy: pmId })
      .onConflictDoUpdate({
        target: systemConfig.key,
        set: { valueJson: config.value, updatedBy: pmId, updatedAt: new Date().toISOString() },
      });
  }
}

/** 演示基座：2 客户 + 2 事项 + 3 项目验收布局（仅 full 档） */
async function seedDemoFoundation(tx: DbOrTx): Promise<void> {
  const userIds = new Map<string, string>();
  for (const userSeed of USER_SEED) {
    const row = await tx.select({ id: users.id }).from(users).where(eq(users.email, userSeed.email));
    if (row[0]) userIds.set(userSeed.email, row[0].id);
  }
  const pmId = userIds.get("wangbaozhuo@lexflow.demo")!;
  const clientIds = new Map<string, string>();
  for (const client of CLIENT_SEED) {
    const id = await idByCode(
      tx,
      tx.select({ id: clients.id }).from(clients).where(eq(clients.code, client.code)),
      () =>
        tx
          .insert(clients)
          .values({
            code: client.code,
            name: client.name,
            confidentialityLevel: client.level,
            createdBy: pmId,
            updatedBy: pmId,
          })
          .onConflictDoNothing(),
    );
    clientIds.set(client.code, id);
  }

  const matterIds = new Map<string, string>();
  for (const matter of MATTER_SEED) {
    const clientId = clientIds.get(matter.clientCode);
    if (!clientId) throw new Error(`种子客户 ${matter.clientCode} 缺失`);
    const id = await idByCode(
      tx,
      tx.select({ id: matters.id }).from(matters).where(eq(matters.code, matter.code)),
      () =>
        tx
          .insert(matters)
          .values({
            code: matter.code,
            clientId,
            name: matter.name,
            type: matter.type,
            createdBy: pmId,
            updatedBy: pmId,
          })
          .onConflictDoNothing(),
    );
    matterIds.set(matter.code, id);
  }

  for (const project of PROJECT_SEED) {
    const matterId = matterIds.get(project.matterCode);
    const managerId = userIds.get(project.managerEmail);
    if (!matterId || !managerId) throw new Error(`种子项目 ${project.code} 依赖缺失`);
    const projectId = await idByCode(
      tx,
      tx.select({ id: projects.id }).from(projects).where(eq(projects.code, project.code)),
      () =>
        tx
          .insert(projects)
          .values({
            code: project.code,
            matterId,
            name: project.name,
            type: project.type,
            managerId,
            confidentialityLevel: project.level,
            lifecycleStatus: project.lifecycle,
            healthStatus: project.health,
            createdBy: managerId,
            updatedBy: managerId,
          })
          .onConflictDoNothing(),
    );
    for (const member of project.members) {
      const memberId = userIds.get(member.email);
      if (!memberId) throw new Error(`种子成员 ${member.email} 缺失`);
      await tx
        .insert(projectMembers)
        .values({ projectId, userId: memberId, projectRole: member.projectRole })
        .onConflictDoNothing();
    }
    // 十一项目档案目录（§12.1；5 项目各一套，仅 full 档）
    await ensureArchiveDirs(tx, projectId);
  }
}

async function seedSchema(databaseUrl: string, profile: SeedProfile): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  try {
    await db.transaction(async (tx) => {
      await seedFoundation(tx);

      if (profile === "minimal") {
        // 清库档：只留基础件 + 模板 + 默认审批流 + 编号水位，零演示业务数据（工单 07）
        await seedTemplates(tx);
        await seedDefaultFlows(tx);
        await seedWaterLevels(tx);
        return;
      }

      await seedDemoFoundation(tx);

      // 迭代 1 治理域种子（模板/审批策略/计划基线/阶段/任务/质量/决策/周报/档案目录，全幂等）
      await seedGovernance(tx);

      // 迭代 2 会议与出差域种子（审批策略/会议/纪要/行动项/出差/行程/事件，全幂等）
      await seedCollab(tx);

      // 迭代 3 财务域种子（预算/经费/报销/台账，台账分录与预算经费自洽——五公式可重算）
      await seedFinance(tx);

      // 迭代 4 工时域种子（timesheet 策略/默认审批人配置/draft/approved/locked 三周期演示态）
      await seedTime(tx);

      // 迭代 5 收口种子（客户 3/项目 5、项目 A 全链闭环核销/归档/授权）
      await seedClosure(tx);

      // 迭代 6 扩展域种子（默认流程等价迁移/演示流程/佳力奇主数据/收款演示）
      await seedExtensions(tx);

      // 迭代 9c CRM 种子（2 线索/五客户级别行业/2 商机/1 合同+2 付款计划/3 跟进）
      await seedCrm(tx);

      // 迭代 9d 财务核算种子（GD 2 应收含逾期演示/1 发票 issued/三档成本率）
      await seedFin(tx);

      // 编号序列水位对齐（全前缀）
      await seedWaterLevels(tx);
    });
  } finally {
    await pool.end();
  }
}

export async function runSeed(databaseUrl?: string, profile: SeedProfile = "full"): Promise<void> {
  loadEnvFile();
  const effective = (process.env.SEED_PROFILE as SeedProfile | undefined) ?? profile;
  await seedSchema(databaseUrl ?? requireDatabaseUrl(), effective);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runSeed()
    .then(() => {
      const profile = process.env.SEED_PROFILE ?? "full";
      console.log(`[db:seed] 种子完成（profile=${profile}，幂等）`);
    })
    .catch((error) => {
      console.error("[db:seed] 种子失败：", error);
      process.exitCode = 1;
    });
}
