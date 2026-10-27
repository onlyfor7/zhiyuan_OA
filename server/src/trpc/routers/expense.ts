import { z } from "zod";

import { EXPENSE_CATEGORY, EXPENSE_STATUS } from "@lexflow/shared";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as service from "../../modules/finance/expense";

const cursorPage = {
  cursor: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(100).default(20),
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期须为 YYYY-MM-DD");

const item = z.object({
  projectId: z.uuid(),
  fundingRequestId: z.uuid().optional(),
  date,
  category: z.enum(EXPENSE_CATEGORY),
  amountCents: z.number().int().min(1, "明细金额须为正整数（分）"),
  description: z.string().trim().min(1, "明细说明必填").max(1000),
  payee: z.string().max(200).optional(),
  receiptNo: z.string().max(100).optional(),
  receiptFileVersionId: z.uuid().optional(),
});

export const expenseRouter = router({
  list: authedProcedure
    .input(
      z
        .object({
          projectId: z.uuid().optional(),
          mine: z.boolean().optional(),
          status: z.enum(EXPENSE_STATUS).optional(),
          category: z.enum(EXPENSE_CATEGORY).optional(),
          dateFrom: z.string().min(10).optional(),
          dateTo: z.string().min(10).optional(),
          ...cursorPage,
        })
        .prefault({}),
    )
    .query(({ ctx, input }) => service.listExpenses(ctx.db, ctx.user, input)),

  getById: authedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => service.getExpenseById(ctx.db, ctx.user, input.id)),

  create: authedMutation
    .input(
      z.object({
        reason: z.string().trim().min(1, "事由必填").max(2000),
        items: z.array(item).min(1, "至少一条明细"),
        isCrossProject: z.boolean().optional(),
        travelId: z.uuid().optional(),
        meetingId: z.uuid().optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.createExpense(ctx.db, ctx.user, input)),

  update: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        rowVersion: z.number().int().min(0),
        reason: z.string().trim().min(1).max(2000).optional(),
        items: z.array(item).min(1).optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.updateExpense(ctx.db, ctx.user, input)),

  submit: authedMutation
    .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0), idempotencyKey: z.uuid() }))
    .mutation(({ ctx, input }) => service.submitExpense(ctx.db, ctx.user, input)),

  withdraw: authedMutation
    .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => service.withdrawExpense(ctx.db, ctx.user, input)),

  addItem: authedMutation
    .input(z.object({ id: z.uuid(), item }))
    .mutation(({ ctx, input }) => service.addItem(ctx.db, ctx.user, input)),

  removeItem: authedMutation
    .input(z.object({ id: z.uuid(), itemId: z.uuid() }))
    .mutation(({ ctx, input }) => service.removeItem(ctx.db, ctx.user, input)),

  attachReceipt: authedMutation
    .input(z.object({ itemId: z.uuid(), fileVersionId: z.uuid() }))
    .mutation(({ ctx, input }) => service.attachReceipt(ctx.db, ctx.user, input)),

  markPaid: authedMutation
    .input(z.object({ id: z.uuid(), paymentRef: z.string().trim().min(1, "支付参考号必填").max(200), idempotencyKey: z.uuid() }))
    .mutation(({ ctx, input }) => service.markPaid(ctx.db, ctx.user, input)),

  adjustCreate: authedMutation
    .input(
      z.object({
        expenseId: z.uuid(),
        deltaCents: z.number().int().min(1).or(z.number().int().max(-1)),
        reason: z.string().trim().min(1, "调整须填原因").max(1000),
        idempotencyKey: z.uuid(),
      }),
    )
    .mutation(({ ctx, input }) => service.adjustCreate(ctx.db, ctx.user, input)),

  stats: router({
    byProject: authedProcedure
      .input(z.object({ projectId: z.uuid(), from: z.string().min(10).optional(), to: z.string().min(10).optional() }))
      .query(({ ctx, input }) => service.statsByProject(ctx.db, ctx.user, input)),

    byCategory: authedProcedure
      .input(z.object({ projectId: z.uuid() }))
      .query(({ ctx, input }) => service.statsByCategory(ctx.db, ctx.user, input)),

    byPerson: authedProcedure
      .input(z.object({ projectId: z.uuid() }))
      .query(({ ctx, input }) => service.statsByPerson(ctx.db, ctx.user, input)),

    exportCsv: authedProcedure
      .input(z.object({ projectId: z.uuid().optional(), status: z.enum(EXPENSE_STATUS).optional() }).prefault({}))
      .query(({ ctx, input }) => service.exportCsv(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  }),
});
