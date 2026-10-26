import { createHash } from "node:crypto";

import { and, eq, gt } from "drizzle-orm";

import { db } from "../../db/client";
import { projectMembers, sessions, userRoles, users } from "../../db/schema";
import type { DbOrTx } from "../../trpc/context";

/** 会话 cookie 名（arch/00 §4，冻结） */
export const SESSION_COOKIE = "lexflow_session";

/** 会话主体：全局角色 + 项目成员关系（arch/03 §2 判定输入） */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  orgUnitId: string | null;
  globalRoles: string[];
  /** projectId → projectRole */
  projectRoles: Map<string, string>;
}

export interface ResolvedSession {
  sessionId: string;
  tokenHash: string;
  user: SessionUser;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * cookie token → 服务端会话 → ctx.user（arch/00 §4）。
 * 账号 disabled 或会话过期立即失效（返回 null，上层转 AUTH_REQUIRED）。
 */
export async function resolveSession(
  dbOrTx: DbOrTx,
  token: string | undefined,
): Promise<ResolvedSession | null> {
  if (!token) return null;
  const tokenHash = hashSessionToken(token);

  const rows = await dbOrTx
    .select({
      sessionId: sessions.id,
      tokenHash: sessions.tokenHash,
      userId: users.id,
      email: users.email,
      name: users.name,
      orgUnitId: users.orgUnitId,
      userStatus: users.status,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, tokenHash),
        gt(sessions.expiresAt, new Date().toISOString()),
        eq(users.status, "active"),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const [roles, memberships] = await Promise.all([
    dbOrTx.select({ roleKey: userRoles.roleKey }).from(userRoles).where(eq(userRoles.userId, row.userId)),
    dbOrTx
      .select({ projectId: projectMembers.projectId, projectRole: projectMembers.projectRole })
      .from(projectMembers)
      .where(eq(projectMembers.userId, row.userId)),
  ]);

  return {
    sessionId: row.sessionId,
    tokenHash: row.tokenHash,
    user: {
      id: row.userId,
      email: row.email,
      name: row.name,
      orgUnitId: row.orgUnitId,
      globalRoles: roles.map((r) => r.roleKey),
      projectRoles: new Map(memberships.map((m) => [m.projectId, m.projectRole])),
    },
  };
}

/** 供非 tRPC 场景（文件路由）直接使用的全局池解析 */
export async function resolveSessionFromToken(token: string | undefined) {
  return resolveSession(db, token);
}
