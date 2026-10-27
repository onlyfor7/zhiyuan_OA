import { z } from "zod";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as service from "../../modules/governance/report";

const cursorPage = {
  cursor: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(100).default(20),
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期须为 YYYY-MM-DD");

export const reportRouter = router({
  list: authedProcedure
    .input(z.object({ projectId: z.uuid(), ...cursorPage }))
    .query(({ ctx, input }) => service.listReports(ctx.db, ctx.user, input)),

  getById: authedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => service.getReport(ctx.db, ctx.user, input.id)),

  generateDraft: authedMutation
    .input(z.object({ projectId: z.uuid(), periodStart: date, periodEnd: date }))
    .mutation(({ ctx, input }) => service.generateDraft(ctx.db, ctx.user, input)),

  updateDraft: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        rowVersion: z.number().int().min(0),
        content: z.record(z.string(), z.unknown()),
      }),
    )
    .mutation(({ ctx, input }) => service.updateDraft(ctx.db, ctx.user, input)),

  confirm: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        rowVersion: z.number().int().min(0),
        idempotencyKey: z.uuid().optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.confirmReport(ctx.db, ctx.user, input)),

  archive: authedMutation
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => service.archiveReport(ctx.db, ctx.user, input.id)),
});
