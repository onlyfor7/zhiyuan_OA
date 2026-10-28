import { z } from "zod";

import { TIME_ACTIVITY_TYPE } from "@lexflow/shared";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as service from "../../modules/time/time";
import * as stats from "../../modules/time/stats";

const entry = z.object({
  projectId: z.uuid().nullable().optional(),
  taskId: z.uuid().nullable().optional(),
  meetingId: z.uuid().nullable().optional(),
  travelId: z.uuid().nullable().optional(),
  activityType: z.enum(TIME_ACTIVITY_TYPE),
  workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  durationMinutes: z.number().int().min(1, "整数分钟 >0"),
  startMinute: z.number().int().min(0).max(1439).nullable().optional(),
  endMinute: z.number().int().min(1).max(1440).nullable().optional(),
  description: z.string().max(1000).optional(),
  billable: z.boolean().optional(),
});

const dateRange = {
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
};

export const timeRouter = router({
  myPeriod: authedProcedure
    .input(z.object({ periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).prefault({}))
    .query(({ ctx, input }) => service.myPeriod(ctx.db, ctx.user, input)),

  saveEntries: authedMutation
    .input(
      z.object({
        periodId: z.uuid(),
        entries: z.array(entry),
        idempotencyKey: z.uuid(),
      }),
    )
    .mutation(({ ctx, input }) => service.saveEntries(ctx.db, ctx.user, input)),

  submit: authedMutation
    .input(z.object({ periodId: z.uuid(), idempotencyKey: z.uuid() }))
    .mutation(({ ctx, input }) => service.submitPeriod(ctx.db, ctx.user, input)),

  withdraw: authedMutation
    .input(z.object({ periodId: z.uuid(), rowVersion: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => service.withdrawPeriod(ctx.db, ctx.user, input)),

  validate: authedProcedure
    .input(z.object({ periodId: z.uuid() }))
    .query(({ ctx, input }) => service.validatePeriod(ctx.db, ctx.user, input.periodId)),

  copyDay: authedMutation
    .input(
      z.object({
        fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
    )
    .mutation(({ ctx, input }) => service.copyDay(ctx.db, ctx.user, input)),

  prefillFromMeeting: authedMutation
    .input(z.object({ meetingId: z.uuid(), periodId: z.uuid().optional() }))
    .mutation(({ ctx, input }) => service.prefillFromMeeting(ctx.db, ctx.user, input)),

  prefillFromTravel: authedMutation
    .input(z.object({ travelId: z.uuid(), periodId: z.uuid().optional() }))
    .mutation(({ ctx, input }) => service.prefillFromTravel(ctx.db, ctx.user, input)),

  lock: authedMutation
    .input(z.object({ periodId: z.uuid(), reason: z.string().max(1000).optional() }))
    .mutation(({ ctx, input }) => service.lockPeriod(ctx.db, ctx.user, input)),

  unlock: authedMutation
    .input(z.object({ periodId: z.uuid(), reason: z.string().trim().min(1, "解锁必须填写理由").max(1000) }))
    .mutation(({ ctx, input }) => service.unlockPeriod(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),

  stats: router({
    byUser: authedProcedure
      .input(z.object({ ...dateRange, statuses: z.array(z.string()).optional(), projectId: z.uuid().optional() }).prefault({}))
      .query(({ ctx, input }) => stats.statsByUser(ctx.db, ctx.user, input)),
    byProject: authedProcedure
      .input(z.object({ ...dateRange, statuses: z.array(z.string()).optional() }).prefault({}))
      .query(({ ctx, input }) => stats.statsByProject(ctx.db, ctx.user, input)),
    byTask: authedProcedure
      .input(z.object({ ...dateRange, statuses: z.array(z.string()).optional(), projectId: z.uuid().optional() }).prefault({}))
      .query(({ ctx, input }) => stats.statsByTask(ctx.db, ctx.user, input)),
    byActivity: authedProcedure
      .input(z.object({ ...dateRange, statuses: z.array(z.string()).optional(), projectId: z.uuid().optional() }).prefault({}))
      .query(({ ctx, input }) => stats.statsByActivity(ctx.db, ctx.user, input)),
    mySummary: authedProcedure
      .input(z.object({ ...dateRange }).prefault({}))
      .query(({ ctx, input }) => stats.mySummary(ctx.db, ctx.user, input)),
    exportCsv: authedProcedure
      .input(z.object({ ...dateRange, statuses: z.array(z.string()).optional(), projectId: z.uuid().optional() }).prefault({}))
      .query(({ ctx, input }) => stats.exportCsv(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  }),
});
