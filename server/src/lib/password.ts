import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** scrypt 参数（node:crypto 内置，无原生依赖；arch/00 §4） */
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

/**
 * 口令散列，格式：scrypt$N$r$p$salt(hex)$hash(hex)。
 * 供数据会话种子与工单 03 认证复用；散列值不得出现在任何 API 响应与日志中。
 */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(plain, salt, KEY_LENGTH, { N, r: R, p: P }).toString("hex");
  return `scrypt$${N}$${R}$${P}$${salt}$${hash}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, expectedHex] = parts;
  const expected = Buffer.from(expectedHex, "hex");
  const actual = scryptSync(plain, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}
