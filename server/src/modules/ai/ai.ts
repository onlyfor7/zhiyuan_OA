import { createHash } from "node:crypto";

import { ERROR_CODE } from "@lexflow/shared";

import { BusinessError } from "../../lib/errors";
import { recordAudit } from "../../services/audit";
import { resolveAiProvider, type AiCompletion, type AiContext, type AiMessage } from "../../services/ai/provider";
import { getAiConfig } from "./config";
import { aiUsageEvents } from "../../db/schema";
import {
  capabilityAnswer,
  capabilityFlowDraft,
  capabilityFormPrefill,
  capabilityMinutesDraft,
  capabilityTimeDraft,
  detectCapability,
  type AiAction,
} from "./capabilities";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";

/**
 * ai.chat 会话端点（arch/12 §17）：限流同用户 20 次/分（登录限流器形态复用）；
 * 隐私白名单剥离（密级/口令/token 类键值一律剥离）+上下文 2k 截断；
 * 审计 action=ai.chat 含上下文摘要哈希（不出原文）；写动作一律只产草稿（capabilities 保证不落库）。
 */

const AI_WINDOW_MS = 60_000;
const AI_MAX_PER_MINUTE = 20;
const CONTEXT_SUMMARY_MAX_CHARS = 2000; // 中文 1 字≈1 token 量级（§17.3 封顶 2k tokens）
const aiUsage = new Map<string, number[]>();

function assertAiAllowed(userId: string): void {
  const now = Date.now();
  const window = (aiUsage.get(userId) ?? []).filter((t) => now - t < AI_WINDOW_MS);
  aiUsage.set(userId, window);
  if (window.length >= AI_MAX_PER_MINUTE) {
    throw new BusinessError(ERROR_CODE.RATE_LIMITED, "AI 助手请求过于频繁，请一分钟后再试");
  }
  window.push(now);
}

/** 隐私剥离：密级/口令/token 类键值对一律移除（正则键值对），再 2k 截断 */
export function scrubContextSummary(summary: string): string {
  const scrubbed = summary
    .replace(/\b(password|passwd|pwd|token|secret|api[-_]?key|authorization|cookie|credential|confidentiality)\b\s*[:=：]\s*[^\s，。；;]+/gi, "")
    .replace(/(密级|口令|密码|令牌)\s*[:=：]?\s*[^\s，。；;]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return scrubbed.slice(0, CONTEXT_SUMMARY_MAX_CHARS);
}

export function hashSummary(summary: string): string {
  return createHash("sha256").update(summary, "utf8").digest("hex");
}

export async function aiChat(
  db: DbOrTx,
  user: SessionUser,
  input: { messages: AiMessage[]; context: AiContext; ip: string | null; sessionId: string | null },
): Promise<AiCompletion & { capability: string; provider: string; model: string; usage: { tokensIn: number; tokensOut: number } }> {
  assertAiAllowed(user.id);
  // 统筹配置：enabled=false 拦截（arch/12 §17.6）；system_config 优先于 env（30s 缓存）
  const cfg = await getAiConfig(db);
  if (!cfg.enabled) {
    throw new BusinessError(ERROR_CODE.AI_DISABLED, "AI 助手未启用，请联系管理员（治理→系统配置→AI 配置）");
  }
  const ctx: AiContext = {
    route: input.context.route,
    pageType: input.context.pageType,
    summary: scrubContextSummary(input.context.summary),
  };
  const lastUser = [...input.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const capability = detectCapability(lastUser, ctx);

  let result: AiCompletion & { capability: string; provider: string; model: string; usage: { tokensIn: number; tokensOut: number } };
  try {
    let action: AiAction;
    switch (capability) {
      case "form_prefill":
        action = capabilityFormPrefill(lastUser, ctx);
        break;
      case "time_draft":
        action = await capabilityTimeDraft(db, user, lastUser);
        break;
      case "minutes_draft":
        action = capabilityMinutesDraft(lastUser, ctx);
        break;
      case "flow_draft":
        action = capabilityFlowDraft(lastUser);
        break;
      default:
        action = capabilityAnswer();
    }
    const provider = resolveAiProvider(cfg);
    const completion = await provider.complete(input.messages, ctx, [action]);
    // 用量记账（arch/12 §17.6）：真实取 usage 字段；Mock 按 chars/4 估算
    const inputChars = input.messages.reduce((n, m) => n + m.content.length, 0) + ctx.summary.length;
    const usage = completion.usage ?? {
      tokensIn: Math.ceil(inputChars / 4),
      tokensOut: Math.ceil(completion.text.length / 4),
    };
    const model = cfg.model ?? provider.name;
    await db.insert(aiUsageEvents).values({
      userId: user.id,
      capability,
      model,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
    });
    result = { ...completion, capability, provider: provider.name, model, usage };
    await recordAudit(db, {
      actorId: user.id,
      sessionId: input.sessionId,
      action: "ai.chat",
      targetType: "ai_chat",
      targetId: null,
      result: "success",
      afterJson: {
        capability,
        provider: provider.name,
        messageCount: input.messages.length,
        contextSummaryHash: hashSummary(ctx.summary), // 摘要哈希（原文不出审计）
        actionType: action.type,
      },
      ip: input.ip,
    });
    return result;
  } catch (error) {
    try {
      await recordAudit(db, {
        actorId: user.id,
        sessionId: input.sessionId,
        action: "ai.chat",
        targetType: "ai_chat",
        targetId: null,
        result: "failure",
        afterJson: {
          capability,
          messageCount: input.messages.length,
          contextSummaryHash: hashSummary(ctx.summary),
          error: error instanceof Error ? error.message.slice(0, 200) : String(error),
        },
        ip: input.ip,
      });
    } catch {
      // 审计失败不掩盖原始错误
    }
    throw error;
  }
}
