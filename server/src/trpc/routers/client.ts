import { z } from "zod";

import { authedProcedure, router } from "../trpc";
import * as reference from "../../modules/governance/reference";

const cursorPage = {
  cursor: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(100).default(20),
};

/** 客户参照数据（arch/02 §4.1 v1.2：任意登录用户，最小字段，无行级 ABAC） */
export const clientRouter = router({
  list: authedProcedure
    .input(z.object({ keyword: z.string().trim().max(100).optional(), ...cursorPage }).prefault({}))
    .query(({ ctx, input }) => reference.listClients(ctx.db, ctx.user, input)),
});
