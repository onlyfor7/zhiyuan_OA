import { z } from "zod";

import { authedMutation, authedProcedure, router } from "../trpc";
import { storageOrphansDryRun, storageOrphansPurge } from "../../modules/admin/storage";

export const adminRouter = router({
  /** dry-run 只读清单（R5：GET 必须安全幂等，实删拆至 mutation） */
  storageOrphans: authedProcedure
    .input(z.object({}).prefault({}))
    .query(({ ctx }) => storageOrphansDryRun(ctx.db, ctx.user, ctx.ip, ctx.session.id)),

  /** 孤儿实删（mutation；审计 admin.storageOrphansPurge） */
  storageOrphansPurge: authedMutation
    .input(z.object({}).prefault({}))
    .mutation(({ ctx }) => storageOrphansPurge(ctx.db, ctx.user, ctx.ip, ctx.session.id)),
});
