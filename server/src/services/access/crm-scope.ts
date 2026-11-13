import { or, sql, type SQL } from "drizzle-orm";

import { crmContracts, crmLeads, crmOpportunities, clients } from "../../db/schema";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";

/**
 * CRM 数据范围解析器（arch/13 §4 可见性矩阵 · 服务端唯一口径，arch/13 §4.1 硬规则）：
 * 列表/详情/搜索/报表/导出统一调用本解析器在 SQL 层过滤；禁止菜单隐藏或内存删行替代。
 *
 * 身份 → 范围能力（arch/13 §3.1 角色可组合，D-18-2-4：多角色取并集 SQL OR，不得丢任一来源范围）：
 * - global：partner / operations / ceo / sysadmin（operations 只读全局≠项目写权；sysadmin 按 D3 提升）；
 * - tree：sales（本人）/ sales_manager / regional_vp（本人 + users.manager_id 递归下级，递归结果进 SQL IN）；
 * - presales：presales_id = 本人的商机及关联线索/客户/跟进；
 * - finance（D4）：合同 active 为唯一分界——仅 active 合同及其客户/回款/应收/发票/费用链；
 *   商机/线索明细不可见，合同前只许 crm.summary 聚合（合同前/后同一边界，§4.1 硬规则 4）；
 * - project：project_manager 等交付角色——仅所负责项目关联的必要客户/合同最小信息（§4.1.6 收回全局短路由）；
 * - none：无任何 CRM 能力的角色——无明细，仅 crm.summary 聚合。
 */

export type CrmScopeKind = "global" | "tree" | "presales" | "finance" | "project" | "none";

export interface CrmScope {
  /** 主形态（兼容既有调用；取并集首个非 none） */
  kind: CrmScopeKind;
  /** 能力并集（角色可组合：sales+presales 同时保留 tree 与 presales 两个来源） */
  kinds: CrmScopeKind[];
  /** tree 能力：本人 + 递归下级 id 集合 */
  treeIds: string[];
  /** 本人 userId（presales 指派等按人判定） */
  userId: string;
}

const GLOBAL_ROLES = ["partner", "operations", "ceo", "sysadmin"];
const TREE_ROLES = ["sales", "sales_manager", "regional_vp"];

/** users.manager_id 递归下级（含本人）：WITH RECURSIVE 一次性求授权集合（arch/13 §3.2） */
export async function resolveSubordinateTree(db: DbOrTx, userId: string): Promise<string[]> {
  const rows = await db.execute(sql`
    WITH RECURSIVE sub(id) AS (
      SELECT ${userId}::uuid
      UNION ALL
      SELECT u.id FROM users u JOIN sub s ON u.manager_id = s.id
    )
    SELECT id FROM sub
  `);
  return (rows.rows as Array<{ id: string }>).map((r) => r.id);
}

/** 多级成环校验：把 userId 的上级设为 newManagerId 是否成环（沿 newManager 主管链向上，撞回 userId 即环） */
export async function wouldCreateManagerCycle(db: DbOrTx, userId: string, newManagerId: string): Promise<boolean> {
  const rows = await db.execute(sql`
    WITH RECURSIVE up(id) AS (
      SELECT ${newManagerId}::uuid
      UNION ALL
      SELECT u.manager_id FROM users u JOIN up p ON u.id = p.id WHERE u.manager_id IS NOT NULL
    )
    SELECT 1 FROM up WHERE id = ${userId}::uuid LIMIT 1
  `);
  return rows.rows.length > 0;
}

/** 范围能力并集：global 短路全量；其余按角色集合收集 kinds（D-18-2-4） */
export async function resolveCrmScope(db: DbOrTx, user: SessionUser): Promise<CrmScope> {
  if (user.globalRoles.some((r) => GLOBAL_ROLES.includes(r))) {
    return { kind: "global", kinds: ["global"], treeIds: [user.id], userId: user.id };
  }
  const kinds: CrmScopeKind[] = [];
  if (user.globalRoles.some((r) => TREE_ROLES.includes(r))) kinds.push("tree");
  if (user.globalRoles.includes("presales")) kinds.push("presales");
  if (user.globalRoles.includes("finance")) kinds.push("finance");
  if (user.globalRoles.includes("project_manager")) kinds.push("project");
  if (kinds.length === 0) kinds.push("none");
  const treeIds = kinds.includes("tree") ? await resolveSubordinateTree(db, user.id) : [user.id];
  return { kind: kinds[0], kinds, treeIds, userId: user.id };
}

const inList = (ids: string[]): SQL => sql`${sql.join(ids.map((x) => sql`${x}`), sql`, `)}`;

/** 并集组合：多能力用 drizzle or() 组合（自动括号化，防 OR 顶破 AND 链）；全不可见返回 null */
function combine(parts: Array<SQL | null>): SQL | null {
  const valid = parts.filter((p): p is SQL => p !== null);
  if (valid.length === 0) return null;
  return valid.length === 1 ? valid[0] : or(...valid)!;
}

/** 线索可见条件（null=整域不可见）；传入表别名（默认 crm_leads） */
export function leadScopeSql(scope: CrmScope, t: typeof crmLeads = crmLeads): SQL | null {
  return combine(
    scope.kinds.map((k): SQL | null => {
      switch (k) {
        case "global":
          return sql`true`;
        case "tree":
          return sql`${t.ownerId} IN (${inList(scope.treeIds)})`;
        case "presales":
          // 被指派商机带来的来源线索（§4：被指派商机及关联线索）
          return sql`EXISTS (SELECT 1 FROM crm_opportunities o WHERE o.source_lead_id = ${t.id} AND o.presales_id = ${scope.userId})`;
        default:
          return null;
      }
    }),
  );
}

/** 商机可见条件 */
export function opportunityScopeSql(scope: CrmScope, t: typeof crmOpportunities = crmOpportunities): SQL | null {
  return combine(
    scope.kinds.map((k): SQL | null => {
      switch (k) {
        case "global":
          return sql`true`;
        case "tree":
          return sql`${t.ownerId} IN (${inList(scope.treeIds)})`;
        case "presales":
          return sql`${t.presalesId} = ${scope.userId}`;
        default:
          return null;
      }
    }),
  );
}

/** 客户可见条件 */
export function customerScopeSql(scope: CrmScope, t: typeof clients = clients): SQL | null {
  return combine(
    scope.kinds.map((k): SQL | null => {
      switch (k) {
        case "global":
          return sql`true`;
        case "tree":
          return sql`${t.ownerId} IN (${inList(scope.treeIds)})`;
        case "presales":
          return sql`EXISTS (SELECT 1 FROM crm_opportunities o WHERE o.customer_id = ${t.id} AND o.presales_id = ${scope.userId})`;
        case "finance":
          // D4：仅存在 active 合同的客户（该合同链的必要客户明细）
          return sql`EXISTS (SELECT 1 FROM crm_contracts c WHERE c.customer_id = ${t.id} AND c.status = 'active')`;
        case "project":
          // §4.1.6：所负责项目关联客户（经事项链）
          return sql`EXISTS (
            SELECT 1 FROM matters m JOIN projects p ON p.matter_id = m.id
            WHERE m.client_id = ${t.id} AND p.manager_id = ${scope.userId}
          )`;
        default:
          return null;
      }
    }),
  );
}

/** 合同可见条件 */
export function contractScopeSql(scope: CrmScope, t: typeof crmContracts = crmContracts): SQL | null {
  return combine(
    scope.kinds.map((k): SQL | null => {
      switch (k) {
        case "global":
          return sql`true`;
        case "tree":
          return sql`EXISTS (SELECT 1 FROM crm_opportunities o WHERE o.id = ${t.opportunityId} AND o.owner_id IN (${inList(scope.treeIds)}))`;
        case "presales":
          return sql`EXISTS (SELECT 1 FROM crm_opportunities o WHERE o.id = ${t.opportunityId} AND o.presales_id = ${scope.userId})`;
        case "finance":
          return sql`${t.status} = 'active'`;
        case "project":
          return sql`EXISTS (
            SELECT 1 FROM crm_opportunities o JOIN projects p ON p.id = o.project_id
            WHERE o.id = ${t.opportunityId} AND p.manager_id = ${scope.userId}
          )`;
        default:
          return null;
      }
    }),
  );
}

/** 金额可见（§1：记录范围内角色可见本人/管辖商机金额；finance 合同前只见聚合金额→明细剥离） */
export function canSeeAmounts(scope: CrmScope): boolean {
  return scope.kinds.some((k) => k === "global" || k === "tree" || k === "presales");
}
