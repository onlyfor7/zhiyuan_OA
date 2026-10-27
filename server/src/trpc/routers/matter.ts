import { z } from "zod";

import { authedProcedure, router } from "../trpc";
import * as reference from "../../modules/governance/reference";

const cursorPage = {
  cursor: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(100).default(20),
};

/** 事项参照数据（arch/02 §4.1 v1.2：任意登录用户，最小字段，无行级 ABAC） */
export const matterRouter = router({
  list: authedProcedure
    .input(
      z
        .object({
          keyword: z.string().trim().max(100).optional(),
          clientId: z.uuid().optional(),
          ...cursorPage,
        })
        .prefault({}),
    )
    .query(({ ctx, input }) => reference.listMatters(ctx.db, ctx.user, input)),
});
