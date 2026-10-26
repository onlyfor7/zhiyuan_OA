import { randomBytes } from "node:crypto";

import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";

import { sessions, users } from "../../db/schema";
import { verifyPassword } from "../../lib/password";
import { sessionExpiresAt } from "../../trpc/context";
import type { DbOrTx } from "../../trpc/context";
import { hashSessionToken, type SessionUser } from "./session";

/** 失败统一提示：不区分账号不存在 / 口令错误（arch/00 §4） */
export const INVALID_CREDENTIALS_MESSAGE = "邮箱或密码错误";

export interface LoginInput {
  email: string;
  password: string;
  ip: string | null;
}

export interface LoginResult {
  /** 明文 token 仅经 Set-Cookie 下发一次，服务端只存散列 */
  sessionToken: string;
  user: { id: string; email: string; name: string };
}

/**
 * 登录：email + scrypt 口令校验，成功建服务端会话（arch/00 §4）。
 * 在事务中调用（session 建行 + 审计同事务）。
 */
export async function login(db: DbOrTx, input: LoginInput): Promise<LoginResult> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      passwordHash: users.passwordHash,
      status: users.status,
    })
    .from(users)
    .where(eq(users.email, input.email.trim().toLowerCase()))
    .limit(1);

  const user = rows[0];
  const passwordOk = user ? verifyPassword(input.password, user.passwordHash) : false;
  if (!user || !passwordOk || user.status !== "active") {
    throw new TRPCError({ code: "UNAUTHORIZED", message: INVALID_CREDENTIALS_MESSAGE });
  }

  const sessionToken = randomBytes(32).toString("base64url");
  await db.insert(sessions).values({
    tokenHash: hashSessionToken(sessionToken),
    userId: user.id,
    expiresAt: sessionExpiresAt(),
    ip: input.ip,
  });

  return { sessionToken, user: { id: user.id, email: user.email, name: user.name } };
}

/**
 * 登出：会话立即过期（expires_at=now），不可再用于鉴权。
 * 注：基线冲突已登记 STATUS.md「偏差与仲裁」——arch/00 §4「登出删除服务端会话」与
 * audit_events.session_id → sessions 的外键 RESTRICT（arch/01 §6）冲突：审计行持续引用会话，
 * 物理删除必失败。裁定前按「立即过期」实现，行为等效（登出后会话即刻失效）。
 */
export async function logout(db: DbOrTx, tokenHash: string): Promise<void> {
  await db
    .update(sessions)
    .set({ expiresAt: new Date().toISOString() })
    .where(eq(sessions.tokenHash, tokenHash));
}

export interface MeResult {
  user: { id: string; email: string; name: string; orgUnit: { id: string; name: string } | null };
  globalRoles: string[];
  projects: { id: string; name: string; code: string; projectRole: string }[];
}

/** auth.me：本人可见项目 = 成员项目（与 projectScopeFilter 同口径） */
export async function buildMe(db: DbOrTx, user: SessionUser): Promise<MeResult> {
  const memberships = [...user.projectRoles.entries()];
  let projects: MeResult["projects"] = [];
  if (memberships.length > 0) {
    const rows = await db.query.projects.findMany({
      where: (p, { inArray }) => inArray(p.id, memberships.map(([id]) => id)),
      columns: { id: true, name: true, code: true },
    });
    const roleById = new Map(memberships);
    projects = rows.map((row) => ({
      id: row.id,
      name: row.name,
      code: row.code,
      projectRole: roleById.get(row.id) ?? "member",
    }));
  }

  let orgUnit: MeResult["user"]["orgUnit"] = null;
  const orgUnitId = user.orgUnitId;
  if (orgUnitId) {
    const orgRows = await db.query.orgUnits.findMany({
      where: (o, { eq: eqOp }) => eqOp(o.id, orgUnitId),
      columns: { id: true, name: true },
      limit: 1,
    });
    orgUnit = orgRows[0] ?? null;
  }

  return {
    user: { id: user.id, email: user.email, name: user.name, orgUnit },
    globalRoles: user.globalRoles,
    projects,
  };
}
