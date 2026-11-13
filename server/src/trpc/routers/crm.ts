import { z } from "zod";

import { CONTRACT_STATUS, LEAD_STATUS, OPPORTUNITY_STAGE } from "@lexflow/shared";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as service from "../../modules/crm/crm";

const cursorPage = {
  cursor: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(100).default(20),
};

/** CRM 域（arch/12 §6/§11 + arch/13 §4/§5）：线索/客户/联系人/商机/合同/付款计划/跟进；
 * 权限门在 service 层（crm-scope SQL 范围解析、member 同形 404、金额按范围形态剥离） */
export const crmRouter = router({
  /** 只读聚合（arch/13 §4.1.3）：计数与金额汇总，无名称/uuid 清单/联系人/跟进；tree/presales 按范围聚合 */
  summary: authedProcedure.query(({ ctx }) => service.crmSummary(ctx.db, ctx.user)),
  leads: router({
    list: authedProcedure
      .input(z.object({ ...cursorPage, status: z.enum(LEAD_STATUS).optional(), keyword: z.string().trim().max(100).optional() }).prefault({}))
      .query(({ ctx, input }) => service.listLeads(ctx.db, ctx.user, input)),
    create: authedMutation
      .input(
        z.object({
          name: z.string().trim().min(1, "线索名称必填").max(200),
          source: z.string().trim().max(100).optional(),
          contactName: z.string().trim().max(100).nullable().optional(),
          contactPhone: z.string().trim().max(50).nullable().optional(),
          ownerId: z.uuid().nullable().optional(),
        }),
      )
      .mutation(({ ctx, input }) => service.createLead(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    update: authedMutation
      .input(
        z.object({
          id: z.uuid(),
          rowVersion: z.number().int().min(0),
          name: z.string().trim().min(1).max(200).optional(),
          source: z.string().trim().max(100).optional(),
          contactName: z.string().trim().max(100).nullable().optional(),
          contactPhone: z.string().trim().max(50).nullable().optional(),
          ownerId: z.uuid().nullable().optional(),
          status: z.enum(["new", "contacted", "qualified"]).optional(),
        }),
      )
      .mutation(({ ctx, input }) => service.updateLead(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    disqualify: authedMutation
      .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0), reason: z.string().trim().min(1, "作废原因必填").max(500) }))
      .mutation(({ ctx, input }) => service.disqualifyLead(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    convert: authedMutation
      .input(
        z.object({
          id: z.uuid(),
          rowVersion: z.number().int().min(0),
          customerId: z.uuid().optional(),
          customer: z
            .object({
              name: z.string().trim().min(1).max(200),
              level: z.string().trim().max(50).optional(),
              industry: z.string().trim().max(100).optional(),
              address: z.string().trim().max(300).optional(),
            })
            .optional(),
          opportunityId: z.uuid().optional(),
          projectManagerId: z.uuid().optional(),
          idempotencyKey: z.uuid().optional(),
          opportunity: z
            .object({
              name: z.string().trim().min(1, "商机名称必填").max(200),
              expectedAmountCents: z.number().int().min(1).nullable().optional(),
              winRate: z.number().int().min(0).max(100).nullable().optional(),
              /** 售前指派（18-02c：转化新建商机随表单提交；服务端 active 校验在立项 helper） */
              presalesId: z.uuid().nullable().optional(),
            })
            .optional(),
        }),
      )
      .mutation(({ ctx, input }) => service.convertLead(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  }),

  customers: router({
    list: authedProcedure
      .input(z.object({ ...cursorPage, level: z.string().trim().max(50).optional(), keyword: z.string().trim().max(100).optional() }).prefault({}))
      .query(({ ctx, input }) => service.listCustomers(ctx.db, ctx.user, input)),
    getById: authedProcedure
      .input(z.object({ id: z.uuid() }))
      .query(({ ctx, input }) => service.getCustomerById(ctx.db, ctx.user, input.id)),
    update: authedMutation
      .input(
        z.object({
          id: z.uuid(),
          rowVersion: z.number().int().min(0),
          name: z.string().trim().min(1).max(200).optional(),
          level: z.string().trim().max(50).optional(),
          industry: z.string().trim().max(100).optional(),
          address: z.string().trim().max(300).optional(),
          ownerId: z.uuid().nullable().optional(),
        }),
      )
      .mutation(({ ctx, input }) => service.updateCustomer(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  }),

  contacts: router({
    create: authedMutation
      .input(
        z.object({
          customerId: z.uuid(),
          name: z.string().trim().min(1, "联系人姓名必填").max(100),
          title: z.string().trim().max(100).nullable().optional(),
          phone: z.string().trim().max(50).nullable().optional(),
          email: z.string().trim().max(200).nullable().optional(),
          isPrimary: z.boolean().optional(),
        }),
      )
      .mutation(({ ctx, input }) => service.createContact(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    update: authedMutation
      .input(
        z.object({
          id: z.uuid(),
          rowVersion: z.number().int().min(0),
          name: z.string().trim().min(1).max(100).optional(),
          title: z.string().trim().max(100).nullable().optional(),
          phone: z.string().trim().max(50).nullable().optional(),
          email: z.string().trim().max(200).nullable().optional(),
          isPrimary: z.boolean().optional(),
        }),
      )
      .mutation(({ ctx, input }) => service.updateContact(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    delete: authedMutation
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => service.deleteContact(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  }),

  opportunities: router({
    list: authedProcedure
      .input(z.object({ ...cursorPage, stage: z.enum(OPPORTUNITY_STAGE).optional(), customerId: z.uuid().optional() }).prefault({}))
      .query(({ ctx, input }) => service.listOpportunities(ctx.db, ctx.user, input)),
    create: authedMutation
      .input(
        z.object({
          customerId: z.uuid(),
          name: z.string().trim().min(1, "商机名称必填").max(200),
          expectedAmountCents: z.number().int().min(1).nullable().optional(),
          winRate: z.number().int().min(0).max(100).nullable().optional(),
          presalesId: z.uuid().nullable().optional(),
          projectManagerId: z.uuid({ message: "项目负责人必填" }),
          idempotencyKey: z.uuid({ message: "幂等键必填" }),
        }),
      )
      .mutation(({ ctx, input }) => service.createOpportunity(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    getById: authedProcedure
      .input(z.object({ id: z.uuid() }))
      .query(({ ctx, input }) => service.getOpportunityById(ctx.db, ctx.user, input.id)),
    ensureProjectPlan: authedMutation
      .input(z.object({ opportunityId: z.uuid() }))
      .mutation(({ ctx, input }) => service.ensureOpportunityProjectPlan(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    update: authedMutation
      .input(
        z.object({
          id: z.uuid(),
          rowVersion: z.number().int().min(0),
          name: z.string().trim().min(1).max(200).optional(),
          expectedAmountCents: z.number().int().min(1).nullable().optional(),
          winRate: z.number().int().min(0).max(100).nullable().optional(),
          ownerId: z.uuid().nullable().optional(),
          presalesId: z.uuid().nullable().optional(),
        }),
      )
      .mutation(({ ctx, input }) => service.updateOpportunity(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    setStage: authedMutation
      .input(
        z.object({
          id: z.uuid(),
          rowVersion: z.number().int().min(0),
          stage: z.enum(["initial", "needs", "proposal", "negotiation"]),
        }),
      )
      .mutation(({ ctx, input }) => service.setOpportunityStage(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    markWon: authedMutation
      .input(
        z.object({
          id: z.uuid(),
          rowVersion: z.number().int().min(0),
          contract: z.object({
            title: z.string().trim().min(1, "合同标题必填").max(200),
            amountCents: z.number().int().min(1, "合同金额须为正整数（分）"),
            matterId: z.uuid().nullable().optional(),
            signedAt: z.string().min(10).nullable().optional(),
            activate: z.boolean().optional(),
          }),
        }),
      )
      .mutation(({ ctx, input }) => service.markOpportunityWon(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    markLost: authedMutation
      .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0), reason: z.string().trim().min(1, "输单原因必填").max(500) }))
      .mutation(({ ctx, input }) => service.markOpportunityLost(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  }),

  contracts: router({
    list: authedProcedure
      .input(z.object({ ...cursorPage, status: z.enum(CONTRACT_STATUS).optional(), customerId: z.uuid().optional() }).prefault({}))
      .query(({ ctx, input }) => service.listContracts(ctx.db, ctx.user, input)),
    getById: authedProcedure
      .input(z.object({ id: z.uuid() }))
      .query(({ ctx, input }) => service.getContractById(ctx.db, ctx.user, input.id)),
    update: authedMutation
      .input(
        z.object({
          id: z.uuid(),
          rowVersion: z.number().int().min(0),
          title: z.string().trim().min(1).max(200).optional(),
          amountCents: z.number().int().min(1).optional(),
          matterId: z.uuid().nullable().optional(),
          signedAt: z.string().min(10).nullable().optional(),
        }),
      )
      .mutation(({ ctx, input }) => service.updateContract(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    activate: authedMutation
      .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0), signedAt: z.string().min(10).nullable().optional() }))
      .mutation(({ ctx, input }) => service.activateContract(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    terminate: authedMutation
      .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0), reason: z.string().trim().min(1, "终止原因必填").max(500) }))
      .mutation(({ ctx, input }) => service.terminateContract(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  }),

  paymentPlans: router({
    upsert: authedMutation
      .input(
        z.object({
          contractId: z.uuid(),
          rows: z
            .array(
              z.object({
                seq: z.number().int().min(1),
                dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "到期日须为 YYYY-MM-DD"),
                amountCents: z.number().int().min(1, "计划金额须为正整数（分）"),
              }),
            )
            .min(1, "至少一行付款计划"),
        }),
      )
      .mutation(({ ctx, input }) => service.upsertPaymentPlans(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  }),

  followups: router({
    list: authedProcedure
      .input(z.object({ targetType: z.enum(["lead", "opportunity", "customer"]), targetId: z.uuid(), limit: z.number().int().min(1).max(100).default(50) }))
      .query(({ ctx, input }) => service.listFollowups(ctx.db, ctx.user, input)),
    create: authedMutation
      .input(
        z.object({
          targetType: z.enum(["lead", "opportunity", "customer"]),
          targetId: z.uuid(),
          content: z.string().trim().min(1, "跟进内容必填").max(2000),
          nextAt: z.string().min(10).nullable().optional(),
        }),
      )
      .mutation(({ ctx, input }) => service.createFollowup(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  }),
});
