import { and, desc, eq, ilike, or, type SQL } from "drizzle-orm";

import { clients, matters, orgUnits, users } from "../../db/schema";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";
import { cursorCondition, encodeCursor } from "./util";

/**
 * 参照数据只读端点（arch/02 §4.1 v1.2）：内部目录性质——任意登录用户可调用、
 * 最小字段、不写审计（查询类本就不经审计中间件）、无行级 ABAC（仅 user.list 按 status=active）。
 */

export async function listUsers(
  db: DbOrTx,
  _user: SessionUser,
  input: { keyword?: string; cursor?: string; limit: number },
) {
  const conditions: (SQL | undefined)[] = [eq(users.status, "active")];
  if (input.keyword) {
    const keyword = input.keyword.replace(/[\\%_]/g, (m) => `\\${m}`);
    conditions.push(or(ilike(users.name, `%${keyword}%`), ilike(users.email, `%${keyword}%`)));
  }
  conditions.push(cursorCondition(input.cursor, users.createdAt, users.id));
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      orgUnitName: orgUnits.name,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(orgUnits, eq(orgUnits.id, users.orgUnitId))
    .where(and(...conditions))
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(({ createdAt: _at, ...item }) => item),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export async function listClients(
  db: DbOrTx,
  _user: SessionUser,
  input: { keyword?: string; cursor?: string; limit: number },
) {
  // 02b：停用客户不下发（参照端点只提供可用主数据）
  const conditions: (SQL | undefined)[] = [eq(clients.status, "active")];
  if (input.keyword) {
    const keyword = input.keyword.replace(/[\\%_]/g, (m) => `\\${m}`);
    conditions.push(or(ilike(clients.name, `%${keyword}%`), ilike(clients.code, `%${keyword}%`)));
  }
  conditions.push(cursorCondition(input.cursor, clients.createdAt, clients.id));
  const rows = await db
    .select({
      id: clients.id,
      code: clients.code,
      name: clients.name,
      createdAt: clients.createdAt,
    })
    .from(clients)
    .where(and(...conditions))
    .orderBy(desc(clients.createdAt), desc(clients.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(({ createdAt: _at, ...item }) => item),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export async function listMatters(
  db: DbOrTx,
  _user: SessionUser,
  input: { keyword?: string; clientId?: string; cursor?: string; limit: number },
) {
  // 02b：停用事项不下发
  const conditions: (SQL | undefined)[] = [eq(matters.status, "active")];
  if (input.keyword) {
    const keyword = input.keyword.replace(/[\\%_]/g, (m) => `\\${m}`);
    conditions.push(or(ilike(matters.name, `%${keyword}%`), ilike(matters.code, `%${keyword}%`)));
  }
  if (input.clientId) conditions.push(eq(matters.clientId, input.clientId));
  conditions.push(cursorCondition(input.cursor, matters.createdAt, matters.id));
  const rows = await db
    .select({
      id: matters.id,
      code: matters.code,
      name: matters.name,
      clientId: matters.clientId,
      clientName: clients.name,
      createdAt: matters.createdAt,
    })
    .from(matters)
    .innerJoin(clients, eq(clients.id, matters.clientId))
    .where(and(...conditions))
    .orderBy(desc(matters.createdAt), desc(matters.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(({ createdAt: _at, ...item }) => item),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
