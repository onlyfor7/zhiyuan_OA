import { randomBytes } from "node:crypto";

import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";

import { sessions, users } from "../../db/schema";
import { ERROR_CODE } from "@lexflow/shared";
import { BusinessError } from "../../lib/errors";
import { verifyPassword } from "../../lib/password";
import { sessionExpiresAt } from "../../trpc/context";
import type { DbOrTx } from "../../trpc/context";
import { hashSessionToken, type SessionUser } from "./session";

/** 失败统一提示：不区分账号不存在 / 口令错误（arch/00 §4） */
export const INVALID_CREDENTIALS_MESSAGE = "邮箱或密码错误";

/**
 * 登录限流（arch/12 §14.4）：同 IP+账号 5 次失败/分钟，超限 429（TOO_MANY_REQUESTS），
 * 提示与口令错误同形策略一致（不泄账号存在性）；成功登录清零窗口。
 * 内存滑动窗口（单进程部署形态，§14.1）；键 = ip|email。
 */
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_FAILURES = 5;
const loginFailures = new Map<string, number[]>();

function loginRateKey(ip: string | null, email: string): string {
  return `${ip ?? "unknown"}|${email.trim().toLowerCase()}`;
}

function assertLoginAllowed(key: string): void {
  const now = Date.now();
  const window = (loginFailures.get(key) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  loginFailures.set(key, window);
  if (window.length >= LOGIN_MAX_FAILURES) {
    throw new BusinessError(ERROR_CODE.RATE_LIMITED, "登录尝试过于频繁，请一分钟后再试");
  }
}

function recordLoginFailure(key: string): void {
  const now = Date.now();
  const window = (loginFailures.get(key) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  window.push(now);
  loginFailures.set(key, window);
}

function clearLoginFailures(key: string): void {
  loginFailures.delete(key);
}

export interface LoginInput {
  email: string;
  password: string;
  ip: string | null;
}

export interface LoginResult {
  /** 明文 token 仅经 Set-Cookie 下发一次，服务端只存散列 */
  sessionToken: string;
  sessionId: string;
  tokenHash: string;
  user: { id: string; email: string; name: string; position: string };
}

/**
 * 登录：email + scrypt 口令校验，成功建服务端会话（arch/00 §4）。
 * 在事务中调用（session 建行 + 审计同事务）。
 */
export async function login(db: DbOrTx, input: LoginInput): Promise<LoginResult & { mustChangePassword: boolean }> {
  const rateKey = loginRateKey(input.ip, input.email);
  assertLoginAllowed(rateKey);
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      position: users.position,
      passwordHash: users.passwordHash,
      status: users.status,
    })
    .from(users)
    .where(eq(users.email, input.email.trim().toLowerCase()))
    .limit(1);

  const user = rows[0];
  const passwordOk = user ? verifyPassword(input.password, user.passwordHash) : false;
  if (!user || !passwordOk || user.status !== "active") {
    recordLoginFailure(rateKey);
    throw new TRPCError({ code: "UNAUTHORIZED", message: INVALID_CREDENTIALS_MESSAGE });
  }
  clearLoginFailures(rateKey);

  const sessionToken = randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(sessionToken);
  const [session] = await db
    .insert(sessions)
    .values({
      tokenHash,
      userId: user.id,
      expiresAt: sessionExpiresAt(),
      ip: input.ip,
    })
    .returning({ id: sessions.id });
  if (!session) throw new Error("会话插入失败");

  const { mustChangePasswordFlag } = await import("../admin/admin");
  return {
    sessionToken,
    sessionId: session.id,
    tokenHash,
    user: { id: user.id, email: user.email, name: user.name, position: user.position },
    mustChangePassword: await mustChangePasswordFlag(db, user.id),
  };
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
  user: { id: string; email: string; name: string; position: string; orgUnit: { id: string; name: string } | null };
  globalRoles: string[];
  projects: { id: string; name: string; code: string; projectRole: string }[];
}

/** auth.me：本人可见项目 = 成员项目（与 projectScopeFilter 同口径） */
export async function buildMe(db: DbOrTx, user: SessionUser): Promise<MeResult & { mustChangePassword: boolean }> {
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

  const { mustChangePasswordFlag } = await import("../admin/admin");
  return {
    user: { id: user.id, email: user.email, name: user.name, position: user.position, orgUnit },
    globalRoles: user.globalRoles,
    projects,
    mustChangePassword: await mustChangePasswordFlag(db, user.id),
  };
}
