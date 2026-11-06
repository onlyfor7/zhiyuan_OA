import { z } from "zod";

import { ERROR_CODE, INVOICE_STATUS, RECEIVABLE_STATUS } from "@lexflow/shared";

import { authedMutation, authedProcedure, router } from "../trpc";
import { BusinessError } from "../../lib/errors";
import * as service from "../../modules/fin/fin";
import { computeProjectCosting, listProjectCostings } from "../../services/fin/costing";

const cursorPage = {
  cursor: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(100).default(20),
};

/** 财务核算域（arch/12 §7）：应收（账龄/生成/勾稽）/发票（红冲）/成本率/项目核算（口径在 services/fin/costing 唯一处） */
export const finRouter = router({
  receivables: router({
    list: authedProcedure
      .input(z.object({ ...cursorPage, status: z.enum(RECEIVABLE_STATUS).optional(), customerId: z.uuid().optional() }).prefault({}))
      .query(({ ctx, input }) => service.listReceivables(ctx.db, ctx.user, input)),
    generate: authedMutation
      .input(z.object({}).prefault({}))
      .mutation(({ ctx }) => service.generateReceivables(ctx.db, ctx.user, ctx.ip, ctx.session.id)),
  }),

  invoices: router({
    list: authedProcedure
      .input(z.object({ ...cursorPage, status: z.enum(INVOICE_STATUS).optional(), customerId: z.uuid().optional() }).prefault({}))
      .query(({ ctx, input }) => service.listInvoices(ctx.db, ctx.user, input)),
    create: authedMutation
      .input(
        z.object({
          customerId: z.uuid(),
          contractId: z.uuid().nullable().optional(),
          receivableId: z.uuid().nullable().optional(),
          amountCents: z.number().int().min(1).optional(),
          taxRate: z.number().int().min(0).max(100).optional(),
        }),
      )
      .mutation(({ ctx, input }) => service.createInvoice(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    issue: authedMutation
      .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0) }))
      .mutation(({ ctx, input }) => service.issueInvoice(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    markSent: authedMutation
      .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0) }))
      .mutation(({ ctx, input }) => service.markInvoiceSent(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    void: authedMutation
      .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0), reason: z.string().trim().min(1, "红冲原因必填").max(500) }))
      .mutation(({ ctx, input }) => service.voidInvoice(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  }),

  costRates: router({
    list: authedProcedure.query(({ ctx }) => service.listCostRates(ctx.db, ctx.user)),
    upsert: authedMutation
      .input(
        z.object({
          userId: z.uuid().nullable().optional(),
          role: z.string().trim().max(50).nullable().optional(),
          hourlyRateCents: z.number().int().min(1, "成本率须为正整数（分/时）"),
          effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "生效日须为 YYYY-MM-DD"),
        }),
      )
      .mutation(({ ctx, input }) => service.upsertCostRate(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  }),

  projectCosting: router({
    get: authedProcedure.input(z.object({ projectId: z.uuid() })).query(async ({ ctx, input }) => {
      // 项目负责人本项目管理口径：本项目 manager 放行（fin.read 全局角色外）
      const isManager = ctx.user.projectRoles.get(input.projectId) === "manager";
      if (!isManager) {
        try {
          await service.requireFinRead(ctx.db, ctx.user);
        } catch (error) {
          throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "财务核算记录不存在或无权访问");
        }
      }
      const costing = await computeProjectCosting(ctx.db, input.projectId);
      if (!costing) throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "财务核算记录不存在或无权访问");
      return costing;
    }),
    list: authedProcedure.query(async ({ ctx }) => {
      await service.requireFinRead(ctx.db, ctx.user);
      return listProjectCostings(ctx.db);
    }),
  }),
});
