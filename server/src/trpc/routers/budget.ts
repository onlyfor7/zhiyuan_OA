import { z } from "zod";

import { EXPENSE_CATEGORY } from "@lexflow/shared";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as service from "../../modules/finance/budget";

const cursorPage = {
  cursor: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(100).default(20),
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期须为 YYYY-MM-DD");

export const budgetRouter = router({
  list: authedProcedure
    .input(z.object({ projectId: z.uuid().optional(), ...cursorPage }).prefault({}))
    .query(({ ctx, input }) => service.listBudgets(ctx.db, ctx.user, input)),

  getById: authedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => service.getBudgetById(ctx.db, ctx.user, input.id)),

  create: authedMutation
    .input(
      z.object({
        projectId: z.uuid(),
        periodStart: date,
        periodEnd: date,
        totalCents: z.number().int().min(1),
        description: z.string().max(1000).optional(),
        categories: z
          .array(z.object({ category: z.enum(EXPENSE_CATEGORY), amountCents: z.number().int().min(1) }))
          .optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.createBudget(ctx.db, ctx.user, input)),

  submit: authedMutation
    .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0), idempotencyKey: z.uuid() }))
    .mutation(({ ctx, input }) => service.submitBudget(ctx.db, ctx.user, input)),

  withdraw: authedMutation
    .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => service.withdrawBudget(ctx.db, ctx.user, input)),

  adjust: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        deltaCents: z.number().int().min(1).or(z.number().int().max(-1)),
        reason: z.string().trim().min(1, "调整须填原因").max(1000),
        idempotencyKey: z.uuid(),
      }),
    )
    .mutation(({ ctx, input }) => service.adjustBudget(ctx.db, ctx.user, input)),

  close: authedMutation
    .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => service.closeBudget(ctx.db, ctx.user, input)),

  ledger: authedProcedure
    .input(
      z
        .object({ budgetId: z.uuid().optional(), projectId: z.uuid().optional(), ...cursorPage })
        .prefault({}),
    )
    .query(({ ctx, input }) => service.ledgerDetail(ctx.db, ctx.user, input)),
});
