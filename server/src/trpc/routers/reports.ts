import { z } from "zod";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as service from "../../modules/report/report";

const filter = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    projectId: z.uuid().optional(),
    customerId: z.uuid().optional(),
    orgUnitId: z.uuid().optional(),
    view: z.enum(["person", "project", "department"]).optional(),
  })
  .prefault({});

/**
 * 报表中心（arch/12 §8/§11）：九张一期报表统一 {columns,rows,summaryCards}；
 * 权限=登录全员（report.read/export 注册），行级按各数据域既有口径过滤（member 本人口径/partner 穿透）。
 * 注：既有 `report.*` 为周报治理域，本期报表挂 `reports.*`（前端 /reports 工作台对应）。
 */
export const reportsRouter = router({
  projectHealth: authedProcedure.input(filter).query(({ ctx, input }) => service.reportProjectHealth(ctx.db, ctx.user, input)),
  projectDelay: authedProcedure.input(filter).query(({ ctx, input }) => service.reportProjectDelay(ctx.db, ctx.user, input)),
  projectCosting: authedProcedure.input(filter).query(({ ctx, input }) => service.reportProjectCosting(ctx.db, ctx.user, input)),
  receivableAging: authedProcedure.input(filter).query(({ ctx, input }) => service.reportReceivableAging(ctx.db, ctx.user, input)),
  expenseCategory: authedProcedure.input(filter).query(({ ctx, input }) => service.reportExpenseCategory(ctx.db, ctx.user, input)),
  monthlyCashflow: authedProcedure.input(filter).query(({ ctx, input }) => service.reportMonthlyCashflow(ctx.db, ctx.user, input)),
  timeSummary: authedProcedure.input(filter).query(({ ctx, input }) => service.reportTimeSummary(ctx.db, ctx.user, { ...input, view: input.view ?? "person" })),
  utilization: authedProcedure.input(filter).query(({ ctx, input }) => service.reportUtilization(ctx.db, ctx.user, input)),
  opportunityFunnel: authedProcedure.input(filter).query(({ ctx, input }) => service.reportOpportunityFunnel(ctx.db, ctx.user, input)),
  customerContribution: authedProcedure.input(filter).query(({ ctx, input }) => service.reportCustomerContribution(ctx.db, ctx.user, input)),

  exportCsv: authedMutation
    .input(
      z.object({
        key: z.string().trim().min(1).max(50),
        filter: filter.optional(),
        idempotencyKey: z.uuid().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      service.exportReportCsv(
        ctx.db,
        ctx.user,
        { key: input.key, filter: input.filter ?? {}, idempotencyKey: input.idempotencyKey ?? null },
        ctx.ip,
        ctx.session.id,
      ),
    ),
});
