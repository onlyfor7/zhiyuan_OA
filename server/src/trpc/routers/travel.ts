import { z } from "zod";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as service from "../../modules/collab/travel";
import { sweepTravels } from "../../modules/collab/sweeps";

const segment = z.object({
  seq: z.number().int().min(1),
  type: z.enum(["transport", "accommodation", "client_site", "other"]),
  startAt: z.string().min(10),
  endAt: z.string().min(10),
  fromPlace: z.string().max(200).optional(),
  toPlace: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  linkedMeetingId: z.uuid().optional(),
  linkedTaskId: z.uuid().optional(),
});

const cursorPage = {
  cursor: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(100).default(20),
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期须为 YYYY-MM-DD");

export const travelRouter = router({
  list: authedProcedure
    .input(
      z
        .object({
          projectId: z.uuid().optional(),
          mine: z.boolean().optional(),
          status: z.enum(["draft", "pending_approval", "approved", "rejected", "in_progress", "completed", "closed", "cancelled"]).optional(),
          ...cursorPage,
        })
        .prefault({}),
    )
    .query(async ({ ctx, input }) => {
      await sweepTravels(ctx.db, ctx.user);
      return service.listTravels(ctx.db, ctx.user, input);
    }),

  getById: authedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(async ({ ctx, input }) => {
      await sweepTravels(ctx.db, ctx.user);
      return service.getTravelById(ctx.db, ctx.user, input.id);
    }),

  create: authedMutation
    .input(
      z.object({
        projectId: z.uuid(),
        reason: z.string().trim().min(1, "事由必填").max(2000),
        destination: z.string().trim().min(1, "目的地必填").max(200),
        startOn: date,
        endOn: date,
        estimatedCostCents: z.number().int().min(0).nullable().optional(),
        borrow: z.boolean().optional(),
        borrowAmountCents: z.number().int().min(1).nullable().optional(),
        segments: z.array(segment).min(1, "至少一段行程"),
      }),
    )
    .mutation(({ ctx, input }) => service.createTravel(ctx.db, ctx.user, input)),

  update: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        rowVersion: z.number().int().min(0),
        reason: z.string().trim().min(1).max(2000).optional(),
        destination: z.string().trim().min(1).max(200).optional(),
        startOn: date.optional(),
        endOn: date.optional(),
        estimatedCostCents: z.number().int().min(0).nullable().optional(),
        borrow: z.boolean().optional(),
        borrowAmountCents: z.number().int().min(1).nullable().optional(),
        segments: z.array(segment).min(1).optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.updateTravel(ctx.db, ctx.user, input)),

  submit: authedMutation
    .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0), idempotencyKey: z.uuid() }))
    .mutation(({ ctx, input }) => service.submitTravel(ctx.db, ctx.user, input)),

  withdraw: authedMutation
    .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => service.withdrawTravel(ctx.db, ctx.user, input)),

  transition: authedMutation
    .input(
      z.discriminatedUnion("action", [
        z.object({ id: z.uuid(), action: z.literal("depart"), rowVersion: z.number().int().min(0) }),
        z.object({
          id: z.uuid(),
          action: z.literal("complete"),
          rowVersion: z.number().int().min(0),
          completionSummary: z.string().trim().min(1, "完成须填写实际行程/结果摘要").max(5000),
          actualCostNote: z.string().max(2000).optional(),
        }),
        z.object({ id: z.uuid(), action: z.literal("close"), rowVersion: z.number().int().min(0) }),
        z.object({
          id: z.uuid(),
          action: z.literal("cancel"),
          rowVersion: z.number().int().min(0),
          reason: z.string().trim().min(1, "取消须填写原因").max(1000),
        }),
      ]),
    )
    .mutation(({ ctx, input }) =>
      service.transitionTravel(ctx.db, ctx.user, {
        id: input.id,
        action: input.action,
        rowVersion: input.rowVersion,
        completionSummary: input.action === "complete" ? input.completionSummary : undefined,
        actualCostNote: input.action === "complete" ? input.actualCostNote : undefined,
        reason: input.action === "cancel" ? input.reason : undefined,
      }),
    ),

  submitChange: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        changes: z
          .object({
            destination: z.string().trim().min(1).max(200).optional(),
            startOn: date.optional(),
            endOn: date.optional(),
            estimatedCostCents: z.number().int().min(0).nullable().optional(),
          })
          .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "至少一项关键字段变更" }),
        reason: z.string().trim().min(1, "变更须填写原因").max(1000),
        idempotencyKey: z.uuid(),
      }),
    )
    .mutation(({ ctx, input }) => service.submitTravelChange(ctx.db, ctx.user, input)),

  timePrefillSuggestion: authedProcedure
    .input(z.object({ travelId: z.uuid() }))
    .query(({ ctx, input }) => service.travelTimePrefill(ctx.db, ctx.user, input.travelId)),
});
