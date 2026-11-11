import { z } from "zod";

import { authedMutation, authedProcedure, router } from "../trpc";
import { aiMessagesSchema } from "../../services/ai/provider";
import { aiChat } from "../../modules/ai/ai";
import { adminAiUsage, getAiConfigForAdmin, myAiUsage, setAiConfig, testAiConnection } from "../../modules/ai/config";

/**
 * AI 助手「小元」（arch/12 §17/§17.6）：ai.chat 会话端点（写动作一律只产草稿；限流 20 次/分；全审计摘要哈希）+
 * ai.config 统筹（sysadmin 专有：get 脱敏/set 全替换/testConnection 1-token 探测；system_config 优先于 env 30s 缓存）+
 * ai.myUsage（本人近 30 天 日×能力）/ai.usageAdmin（sysadmin 全局 人×日×能力 Top）。
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

  config: router({
    get: authedProcedure.query(({ ctx }) => getAiConfigForAdmin(ctx.db, ctx.user)),
    set: authedMutation
      .input(
        z.object({
          providerUrl: z.string().url().max(500).nullable().optional(),
          apiKey: z.string().max(500).nullable().optional(),
          model: z.string().max(100).nullable().optional(),
          enabled: z.boolean().optional(),
        }),
      )
      .mutation(({ ctx, input }) => setAiConfig(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    testConnection: authedMutation
      .input(z.object({}).prefault({}))
      .mutation(({ ctx }) => testAiConnection(ctx.db, ctx.user)),
  }),

  myUsage: authedProcedure
    .input(z.object({}).prefault({}))
    .query(({ ctx }) => myAiUsage(ctx.db, ctx.user)),

  usageAdmin: authedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).prefault({}))
    .query(({ ctx, input }) => adminAiUsage(ctx.db, ctx.user, input)),
});
