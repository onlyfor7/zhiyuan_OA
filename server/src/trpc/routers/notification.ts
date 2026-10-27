import { z } from "zod";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as queries from "../../modules/governance/queries";

export const notificationRouter = router({
  listMine: authedProcedure
    .input(
      z
        .object({
          cursor: z.string().max(300).optional(),
          unreadOnly: z.boolean().optional(),
          limit: z.number().int().min(1).max(100).default(20),
        })
        .prefault({}),
    )
    .query(({ ctx, input }) => queries.listMineNotifications(ctx.db, ctx.user, input)),

  unreadCount: authedProcedure.query(({ ctx }) => queries.unreadCount(ctx.db, ctx.user)),

  markRead: authedMutation
    .input(z.object({ ids: z.array(z.uuid()).min(1).max(200) }))
    .mutation(({ ctx, input }) => queries.markRead(ctx.db, ctx.user, input.ids)),

  markHandled: authedMutation
    .input(z.object({ ids: z.array(z.uuid()).min(1).max(200) }))
    .mutation(({ ctx, input }) => queries.markHandled(ctx.db, ctx.user, input.ids)),
});
