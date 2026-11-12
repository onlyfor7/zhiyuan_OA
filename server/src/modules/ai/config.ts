import { eq, sql } from "drizzle-orm";

import { CONFIG_KEY, ERROR_CODE } from "@lexflow/shared";

import { systemConfig } from "../../db/schema";
import { BusinessError } from "../../lib/errors";
import { can } from "../../services/access";
import { recordAudit } from "../../services/audit";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";

/**
 * AI 配置统筹（arch/12 §17.6 v2.2）：管理员统一配置、全局生效（不设每用户自配）。
 * 读序=system_config 优先于 env，30s 缓存（set 即刻失效）；key 脱敏仅后 4 位，审计不含明文；
 * testConnection 1-token 探测返回 {ok, latencyMs, error?}。
 */

export interface AiRuntimeConfig {
  providerUrl: string | null;
  apiKey: string | null;
  model: string | null;
  enabled: boolean;
  /** 配置来源：system_config / env / default（缓存键随来源失效） */
  source: "system_config" | "env" | "default";
}

const CACHE_MS = 30_000;
let cache: { value: AiRuntimeConfig; expiresAt: number } | null = null;

async function readSystemConfig(db: DbOrTx, key: string): Promise<Record<string, unknown> | null> {
  const [row] = await db.select().from(systemConfig).where(eq(systemConfig.key, key)).limit(1);
  return (row?.valueJson as Record<string, unknown> | undefined) ?? null;
}

/** 读序：system_config 优先于 env；30s 缓存（ai.config.set 调用 invalidateAiConfigCache 即刻生效） */
export async function getAiConfig(db: DbOrTx): Promise<AiRuntimeConfig> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;

  const [sysUrl, sysKey, sysModel, sysEnabled] = await Promise.all([
    readSystemConfig(db, CONFIG_KEY.AI_PROVIDER_URL),
    readSystemConfig(db, CONFIG_KEY.AI_API_KEY),
    readSystemConfig(db, CONFIG_KEY.AI_MODEL),
    readSystemConfig(db, CONFIG_KEY.AI_ENABLED),
  ]);
  const value: AiRuntimeConfig = {
    providerUrl: (sysUrl?.value as string | undefined) ?? process.env.AI_PROVIDER_URL ?? null,
    apiKey: (sysKey?.value as string | undefined) ?? process.env.AI_API_KEY ?? null,
    model: (sysModel?.value as string | undefined) ?? process.env.AI_MODEL ?? null,
    enabled: (sysEnabled?.enabled as boolean | undefined) ?? true,
    source: sysUrl || sysKey || sysModel || sysEnabled ? "system_config" : process.env.AI_PROVIDER_URL || process.env.AI_API_KEY || process.env.AI_MODEL ? "env" : "default",
  };
  cache = { value, expiresAt: now + CACHE_MS };
  return value;
}

export function invalidateAiConfigCache(): void {
  cache = null;
}

/** 脱敏：仅后 4 位（不足 4 位全掩） */
export function maskApiKey(key: string | null): string | null {
  if (!key) return null;
  return key.length <= 4 ? "****" : `****${key.slice(-4)}`;
}

async function requireSysadmin(db: DbOrTx, user: SessionUser): Promise<void> {
  const allowed = await can(db, user, "admin.config", { type: "project", projectId: "" });
  if (!allowed) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "AI 配置不存在或无权访问");
}

export async function getAiConfigForAdmin(db: DbOrTx, user: SessionUser) {
  await requireSysadmin(db, user);
  const cfg = await getAiConfig(db);
  return {
    providerUrl: cfg.providerUrl,
    model: cfg.model,
    enabled: cfg.enabled,
    apiKeyMasked: maskApiKey(cfg.apiKey),
    source: cfg.source,
  };
}

async function writeConfigKey(db: DbOrTx, key: string, value: Record<string, unknown>): Promise<void> {
  await db
    .insert(systemConfig)
    .values({ key, valueJson: value })
    .onConflictDoUpdate({ target: systemConfig.key, set: { valueJson: value, updatedAt: new Date().toISOString() } });
}

export async function setAiConfig(
  db: DbOrTx,
  user: SessionUser,
  input: { providerUrl?: string | null; apiKey?: string | null; model?: string | null; enabled?: boolean },
  ip: string | null,
  sessionId: string | null,
) {
  await requireSysadmin(db, user);
  const before = await getAiConfig(db);
  // 写时全替换（整键覆盖）；null 显式清除 system_config 层（回落 env）
  if (input.providerUrl !== undefined) {
    await writeConfigKey(db, CONFIG_KEY.AI_PROVIDER_URL, { value: input.providerUrl ?? "" });
  }
  if (input.apiKey !== undefined) {
    await writeConfigKey(db, CONFIG_KEY.AI_API_KEY, { value: input.apiKey ?? "" });
  }
  if (input.model !== undefined) {
    await writeConfigKey(db, CONFIG_KEY.AI_MODEL, { value: input.model ?? "" });
  }
  if (input.enabled !== undefined) {
    await writeConfigKey(db, CONFIG_KEY.AI_ENABLED, { enabled: input.enabled });
  }
  invalidateAiConfigCache(); // 改后即刻生效（缓存即刻失效）
  const after = await getAiConfig(db);
  // 审计同事务：before/after 只存脱敏形态，不含明文
  await recordAudit(db, {
    actorId: user.id,
    sessionId,
    action: "ai.config.set",
    targetType: "system_config",
    targetId: null,
    result: "success",
    beforeJson: { providerUrl: before.providerUrl, model: before.model, enabled: before.enabled, apiKeyMasked: maskApiKey(before.apiKey) },
    afterJson: { providerUrl: after.providerUrl, model: after.model, enabled: after.enabled, apiKeyMasked: maskApiKey(after.apiKey) },
    ip,
  });
  return { ok: true as const, enabled: after.enabled, apiKeyMasked: maskApiKey(after.apiKey) };
}

/** 测试联通：1-token 探测；mock 提供方直接 ok（无网络），OpenAI 走真实 1-token 调用 */
export async function testAiConnection(db: DbOrTx, user: SessionUser) {
  await requireSysadmin(db, user);
  const cfg = await getAiConfig(db);
  const model = cfg.model ?? "mock";
  if (!cfg.apiKey || !cfg.providerUrl) {
    return { ok: true as const, latencyMs: 0, model: "mock", note: "未配置外部提供方——内置 MockProvider 可用" };
  }
  const startedAt = Date.now();
  try {
    const response = await fetch(`${cfg.providerUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return { ok: false as const, latencyMs, model, error: `HTTP ${response.status}` };
    }
    return { ok: true as const, latencyMs, model };
  } catch (error) {
    return { ok: false as const, latencyMs: Date.now() - startedAt, model, error: error instanceof Error ? error.message.slice(0, 200) : String(error) };
  }
}

/** 用量聚合：本人近 30 天按日×能力；sysadmin 全局按人×日×能力 Top */
export async function myAiUsage(db: DbOrTx, user: SessionUser) {
  const rows = await db.execute(sqlForUsage("user", user.id));
  return { items: rows.rows };
}

export async function adminAiUsage(db: DbOrTx, user: SessionUser, input: { limit: number }) {
  const allowed = await can(db, user, "admin.config", { type: "project", projectId: "" });
  if (!allowed) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "AI 用量不存在或无权访问");
  const rows = await db.execute(sqlForUsage("admin", null, Math.min(input.limit, 200)));
  return { items: rows.rows };
}

function sqlForUsage(scope: "user" | "admin", userId: string | null, limit = 200) {
  if (scope === "user") {
    return sql`
      SELECT to_char(created_at, 'YYYY-MM-DD') AS day, capability,
             count(*)::int AS calls, sum(tokens_in)::int AS tokens_in, sum(tokens_out)::int AS tokens_out
      FROM ai_usage_events
      WHERE user_id = ${userId} AND created_at >= now() - interval '30 days'
      GROUP BY 1, 2 ORDER BY 1 DESC, (sum(tokens_in) + sum(tokens_out)) DESC
      LIMIT ${limit}
    `;
  }
  return sql`
    SELECT u.name AS user_name, to_char(e.created_at, 'YYYY-MM-DD') AS day, e.capability,
           count(*)::int AS calls, sum(e.tokens_in)::int AS tokens_in, sum(e.tokens_out)::int AS tokens_out
    FROM ai_usage_events e JOIN users u ON u.id = e.user_id
    WHERE e.created_at >= now() - interval '30 days'
    GROUP BY 1, 2, 3 ORDER BY (sum(e.tokens_in) + sum(e.tokens_out)) DESC
    LIMIT ${limit}
  `;
}
