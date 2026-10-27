import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import { ERROR_CODE } from "@lexflow/shared";

import { BusinessError } from "../../lib/errors";

/** 键集游标（updatedAt/createdAt + id），列表分页统一口径（arch/02 §2） */
export function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify({ a: at, i: id }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { a: string; i: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      a?: unknown;
      i?: unknown;
    };
    if (typeof parsed.a !== "string" || typeof parsed.i !== "string") throw new Error("bad cursor");
    return { a: parsed.a, i: parsed.i };
  } catch {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "无效的分页游标", {
      cursor: ["无效的分页游标"],
    });
  }
}

/** keyset 下一页条件（按 at desc, id desc） */
export function cursorCondition(
  cursor: string | undefined,
  atCol: PgColumn,
  idCol: PgColumn,
): SQL | undefined {
  if (!cursor) return undefined;
  const { a, i } = decodeCursor(cursor);
  return or(lt(atCol, a), and(eq(atCol, a), lt(idCol, i)));
}

/** 乐观锁：不匹配返回 STATE_CONFLICT（arch/00 §3.6） */
export function versionConflict(): BusinessError {
  return new BusinessError(ERROR_CODE.STATE_CONFLICT, "数据已被他人修改，请刷新后重试");
}

export function dayString(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export { desc, and, eq, or };
