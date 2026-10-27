import { authedProcedure, router } from "../trpc";
import * as queries from "../../modules/governance/queries";

export const dashboardRouter = router({
  summary: authedProcedure.query(({ ctx }) => queries.dashboardSummary(ctx.db, ctx.user)),
});
