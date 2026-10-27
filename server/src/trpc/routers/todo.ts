import { z } from "zod";

import { authedProcedure, router } from "../trpc";
import * as queries from "../../modules/governance/queries";

export const todoRouter = router({
  mine: authedProcedure
    .input(
      z
        .object({
          cursor: z.string().max(300).optional(),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .prefault({}),
    )
    .query(({ ctx }) => queries.todoMine(ctx.db, ctx.user)),
});
