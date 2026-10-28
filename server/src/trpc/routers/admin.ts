import { z } from "zod";

import { authedProcedure, router } from "../trpc";
import { storageOrphans } from "../../modules/admin/storage";

export const adminRouter = router({
  storageOrphans: authedProcedure
    .input(z.object({ confirm: z.boolean().optional() }).prefault({}))
    .query(({ ctx, input }) => storageOrphans(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
});
