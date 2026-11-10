import { z } from "zod";

import { authedMutation, router } from "../trpc";
import { aiMessagesSchema } from "../../services/ai/provider";
import { aiChat } from "../../modules/ai/ai";

/**
 * AI 助手「小元」（arch/12 §17）：ai.chat 会话端点——
 * 写动作一律只产草稿/预填（用户确认后走既有端点）；限流 20 次/分；全审计（摘要哈希）；
 * 上下文字段白名单（route/pageType/summary）+密级/口令/token 键值剥离+2k 截断。
 */
export const aiRouter = router({
  chat: authedMutation
    .input(
      z.object({
        messages: aiMessagesSchema,
        context: z
          .object({
            route: z.string().max(200).default(""),
            pageType: z.string().max(50).default(""),
            summary: z.string().max(10000).default(""),
          })
          .prefault({}),
      }),
    )
    .mutation(({ ctx, input }) =>
      aiChat(
        ctx.db,
        ctx.user,
        { messages: input.messages, context: input.context, ip: ctx.ip, sessionId: ctx.session.id },
      ),
    ),
});
