import { createHmac, timingSafeEqual } from "node:crypto";

import { env } from "../../env";

/**
 * 短期下载令牌（arch/00 §5：≤15min，HMAC 签名，无状态）。
 * payload = fileVersionId + 过期毫秒时间戳，签名用 SESSION_SECRET。
 * 仅用于 /files/:fileVersionId/download|preview 的 ?token= 鉴权。
 */

const TTL_MS = 15 * 60 * 1000;

function signature(payload: string): string {
  return createHmac("sha256", env.SESSION_SECRET).update(payload).digest("base64url");
}

export function signDownloadToken(fileVersionId: string, ttlMs: number = TTL_MS): string {
  const exp = Date.now() + ttlMs;
  const payload = `${fileVersionId}.${exp}`;
  return `${payload}.${signature(payload)}`;
}

/** 校验并返回 fileVersionId；无效/过期一律 null（不区分原因，防探测） */
export function verifyDownloadToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [fileVersionId, expRaw, sig] = parts;
  if (!fileVersionId || !expRaw || !sig) return null;
  const payload = `${fileVersionId}.${expRaw}`;
  const expected = signature(payload);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now()) return null;
  return fileVersionId;
}
