import { z } from "zod";

import { authedProcedure, router } from "../trpc";
import * as queries from "../../modules/governance/queries";

export const auditRouter = router({
  list: authedProcedure
    .input(
      z
        .object({
          cursor: z.string().max(300).optional(),
          limit: z.number().int().min(1).max(100).default(20),
          actorId: z.uuid().optional(),
          targetType: z.string().max(50).optional(),
          action: z.string().max(100).optional(),
          from: z.string().min(10).optional(),
          to: z.string().min(10).optional(),
        })
        .prefault({}),
    )
    .query(({ ctx, input }) => queries.auditList(ctx.db, ctx.user, input)),
});
