import { eq, sql } from "drizzle-orm";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase, NodePgTransaction } from "drizzle-orm/node-postgres";
import pg from "pg";
import { pathToFileURL } from "node:url";

import { hashPassword } from "../../lib/password";
import { loadEnvFile, requireDatabaseUrl } from "../env";
import * as schema from "../schema";
import { clients, matters, orgUnits, projectMembers, projects, roles, systemConfig, userRoles, users } from "../schema";
import { SYSTEM_CONFIG_DEFAULTS } from "./config-defaults";
import { seedCollab } from "./collab";
import { seedFinance } from "./finance";
import { seedGovernance } from "./governance";

type DbOrTx =
  | NodePgDatabase<typeof schema>
  | NodePgTransaction<typeof schema, ExtractTablesWithRelations<typeof schema>>;

const DEMO_PASSWORD = "Demo@2026";
const YEAR = new Date().getFullYear();

/** 组织树：1 律所 + 3 部门（arch/00 §8） */
const ORG_FIRM = "示例律师事务所";
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
  roleKey: string;
  org?: string;
}

/** ≥10 用户，口令统一 Demo@2026（arch/00 §8） */
const USER_SEED: UserSeed[] = [
  { email: "pm@lexflow.demo", name: "陈立", roleKey: "project_manager", org: "诉讼业务部" },
  { email: "member@lexflow.demo", name: "林晓", roleKey: "member", org: "诉讼业务部" },
  { email: "partner@lexflow.demo", name: "周正", roleKey: "partner", org: "综合管理部" },
  { email: "finance@lexflow.demo", name: "吴敏", roleKey: "finance", org: "综合管理部" },
  { email: "archivist@lexflow.demo", name: "郑楠", roleKey: "archivist", org: "综合管理部" },
  { email: "sysadmin@lexflow.demo", name: "赵凯", roleKey: "sysadmin", org: "综合管理部" },
  { email: "quality@lexflow.demo", name: "孙倩", roleKey: "quality_lead", org: "非诉业务部" },
  { email: "viewer@lexflow.demo", name: "何静", roleKey: "viewer" },
  { email: "liuchang@lexflow.demo", name: "刘畅", roleKey: "member", org: "诉讼业务部" },
  { email: "huanglei@lexflow.demo", name: "黄蕾", roleKey: "member", org: "诉讼业务部" },
  { email: "xubin@lexflow.demo", name: "徐斌", roleKey: "member", org: "非诉业务部" },
  { email: "mayue@lexflow.demo", name: "马悦", roleKey: "member", org: "综合管理部" },
];

/** 2 客户（虚构，arch/00 §8） */
const CLIENT_SEED = [
  { code: `CLT-${YEAR}-00001`, name: "华宸贸易有限公司", level: "internal" as const },
  { code: `CLT-${YEAR}-00002`, name: "星澜科技有限公司", level: "confidential" as const },
];

/** 2 事项 */
const MATTER_SEED = [
  { code: `MTR-${YEAR}-00001`, clientCode: `CLT-${YEAR}-00001`, name: "华宸贸易合同纠纷", type: "诉讼" },
  { code: `MTR-${YEAR}-00002`, clientCode: `CLT-${YEAR}-00002`, name: "星澜科技常年法律顾问", type: "非诉" },
];

/**
 * 3 项目（验收场景布局，工单 00 §迭代验收场景 1/2）：
 * pm 是 A/B 负责人；member 仅是 A 成员；C 对二者均不可见（负责人为 partner）。
 */
const PROJECT_SEED = [
  {
    code: `PRJ-${YEAR}-00001`,
    matterCode: `MTR-${YEAR}-00001`,
    name: "华宸贸易合同纠纷代理·一审",
    type: "诉讼",
    managerEmail: "pm@lexflow.demo",
    level: "internal" as const,
    lifecycle: "in_progress" as const,
    health: "normal" as const,
    members: [
      { email: "pm@lexflow.demo", projectRole: "manager" },
      { email: "member@lexflow.demo", projectRole: "member" },
      { email: "liuchang@lexflow.demo", projectRole: "member" },
      { email: "huanglei@lexflow.demo", projectRole: "member" },
    ],
  },
  {
    code: `PRJ-${YEAR}-00002`,
    matterCode: `MTR-${YEAR}-00002`,
    name: "星澜科技常年法律顾问服务",
    type: "非诉",
    managerEmail: "pm@lexflow.demo",
    level: "confidential" as const,
    lifecycle: "in_progress" as const,
    health: "warning" as const,
    members: [
      { email: "pm@lexflow.demo", projectRole: "manager" },
      { email: "xubin@lexflow.demo", projectRole: "member" },
    ],
  },
  {
    code: `PRJ-${YEAR}-00003`,
    matterCode: `MTR-${YEAR}-00001`,
    name: "华宸贸易合同纠纷·执行阶段",
    type: "诉讼",
    managerEmail: "partner@lexflow.demo",
    level: "secret" as const,
    lifecycle: "preparing" as const,
    health: "normal" as const,
    members: [
      { email: "partner@lexflow.demo", projectRole: "manager" },
      { email: "mayue@lexflow.demo", projectRole: "member" },
    ],
  },
];

async function ensureOrgUnit(db: DbOrTx, name: string, parentId: string | null): Promise<string> {
  const existing = await db.select({ id: orgUnits.id }).from(orgUnits).where(eq(orgUnits.name, name));
  if (existing[0]) return existing[0].id;
  const inserted = await db.insert(orgUnits).values({ name, parentId }).returning({ id: orgUnits.id });
  return inserted[0].id;
}

async function ensureUser(db: DbOrTx, seed: UserSeed, orgId: string | undefined, passwordHash: string): Promise<string> {
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, seed.email));
  if (existing[0]) return existing[0].id;
  const inserted = await db
    .insert(users)
    .values({ email: seed.email, name: seed.name, passwordHash, orgUnitId: orgId ?? null })
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

async function seedSchema(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  try {
    await db.transaction(async (tx) => {
      // 组织树
      const firmId = await ensureOrgUnit(tx, ORG_FIRM, null);
      const deptIds = new Map<string, string>();
      for (const dept of ORG_DEPARTMENTS) {
        deptIds.set(dept, await ensureOrgUnit(tx, dept, firmId));
      }

      // 角色
      for (const role of ROLE_SEED) {
        await tx
          .insert(roles)
          .values({ key: role.key, name: role.name, description: role.description })
          .onConflictDoNothing();
      }

      // 用户 + 全局角色分配（二次执行不重复建行、不重算口令散列）
      const passwordHash = hashPassword(DEMO_PASSWORD);
      const userIds = new Map<string, string>();
      for (const userSeed of USER_SEED) {
        const orgId = userSeed.org ? deptIds.get(userSeed.org) : undefined;
        const userId = await ensureUser(tx, userSeed, orgId, passwordHash);
        userIds.set(userSeed.email, userId);
        await tx.insert(userRoles).values({ userId, roleKey: userSeed.roleKey }).onConflictDoNothing();
      }
      const pmId = userIds.get("pm@lexflow.demo");
      if (!pmId) throw new Error("种子用户 pm@lexflow.demo 缺失");

      // 客户（按 code 幂等）
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

      // 事项
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

      // 项目 + 成员
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
      }

      // system_config 默认配置（需求基线 §18 全量）
      for (const config of SYSTEM_CONFIG_DEFAULTS) {
        await tx
          .insert(systemConfig)
          .values({ key: config.key, valueJson: config.value, updatedBy: pmId })
          .onConflictDoUpdate({
            target: systemConfig.key,
            set: { valueJson: config.value, updatedBy: pmId, updatedAt: new Date().toISOString() },
          });
      }

      // 迭代 1 治理域种子（模板/审批策略/计划基线/阶段/任务/质量/决策/周报/档案目录，全幂等）
      await seedGovernance(tx);

      // 迭代 2 会议与出差域种子（审批策略/会议/纪要/行动项/出差/行程/事件，全幂等）
      await seedCollab(tx);

      // 迭代 3 财务域种子（预算/经费/报销/台账，台账分录与预算经费自洽——五公式可重算）
      await seedFinance(tx);

      // 编号序列水位对齐到种子最大序号，避免后续 next_code 撞号
      await tx.execute(
        sql.raw(
          `INSERT INTO code_sequences (prefix, year, next_value) VALUES ('CLT', ${YEAR}, 4), ('MTR', ${YEAR}, 4), ('PRJ', ${YEAR}, 4) ` +
            `ON CONFLICT (prefix, year) DO UPDATE SET next_value = GREATEST(code_sequences.next_value, 4)`,
        ),
      );
    });
  } finally {
    await pool.end();
  }
}

export async function runSeed(databaseUrl?: string): Promise<void> {
  loadEnvFile();
  await seedSchema(databaseUrl ?? requireDatabaseUrl());
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runSeed()
    .then(() => {
      console.log("[db:seed] 种子完成（幂等）");
    })
    .catch((error) => {
      console.error("[db:seed] 种子失败：", error);
      process.exitCode = 1;
    });
}
