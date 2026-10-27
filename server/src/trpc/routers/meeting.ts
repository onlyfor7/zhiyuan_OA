import { z } from "zod";

import { MEETING_TYPE } from "@lexflow/shared";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as service from "../../modules/collab/meeting";
import * as minutes from "../../modules/collab/minutes";
import { sweepMeetings } from "../../modules/collab/sweeps";

const participant = z
  .object({
    userId: z.uuid().optional(),
    externalName: z.string().trim().min(1).max(100).optional(),
    externalOrg: z.string().trim().max(200).optional(),
    role: z.enum(["required", "optional"]).optional(),
  })
  .refine((v) => (v.userId ? !v.externalName : !!v.externalName), {
    message: "userId 与 externalName 恰一非空",
  });

const cursorPage = {
  cursor: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(100).default(20),
};

export const meetingRouter = router({
  list: authedProcedure
    .input(
      z
        .object({
          projectId: z.uuid().optional(),
          mine: z.boolean().optional(),
          dateFrom: z.string().min(10).optional(),
          dateTo: z.string().min(10).optional(),
          status: z.enum(["planned", "completed", "cancelled"]).optional(),
          ...cursorPage,
        })
        .prefault({}),
    )
    .query(async ({ ctx, input }) => {
      await sweepMeetings(ctx.db, ctx.user); // 查询时判定+写入（meeting_starting/minutes_overdue）
      return service.listMeetings(ctx.db, ctx.user, input);
    }),

  getById: authedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(async ({ ctx, input }) => {
      await sweepMeetings(ctx.db, ctx.user);
      return service.getMeetingById(ctx.db, ctx.user, input.id);
    }),

  create: authedMutation
    .input(
      z.object({
        projectId: z.uuid(),
        type: z.enum(MEETING_TYPE),
        subject: z.string().trim().min(1, "主题必填").max(200),
        agenda: z.string().max(5000).optional(),
        startAt: z.string().min(10),
        endAt: z.string().min(10),
        location: z.string().max(200).optional(),
        onlineUrl: z.string().max(500).optional(),
        recorderId: z.uuid().optional(),
        minutesRequired: z.boolean().optional(),
        participants: z.array(participant).min(1, "至少一名参与人"),
      }),
    )
    .mutation(({ ctx, input }) => service.createMeeting(ctx.db, ctx.user, input)),

  update: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        rowVersion: z.number().int().min(0),
        subject: z.string().trim().min(1).max(200).optional(),
        agenda: z.string().max(5000).optional(),
        startAt: z.string().min(10).optional(),
        endAt: z.string().min(10).optional(),
        location: z.string().max(200).nullable().optional(),
        onlineUrl: z.string().max(500).nullable().optional(),
        participants: z.array(participant).min(1).optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.updateMeeting(ctx.db, ctx.user, input)),

  transition: authedMutation
    .input(
      z.discriminatedUnion("action", [
        z.object({
          id: z.uuid(),
          action: z.literal("complete"),
          actualStartAt: z.string().min(10).optional(),
          actualEndAt: z.string().min(10).optional(),
        }),
        z.object({ id: z.uuid(), action: z.literal("cancel"), reason: z.string().trim().min(1, "取消必须填写原因").max(1000) }),
      ]),
    )
    .mutation(({ ctx, input }) =>
      service.transitionMeeting(ctx.db, ctx.user, {
        id: input.id,
        action: input.action,
        reason: input.action === "cancel" ? input.reason : undefined,
        actualStartAt: input.action === "complete" ? input.actualStartAt : undefined,
        actualEndAt: input.action === "complete" ? input.actualEndAt : undefined,
      }),
    ),

  recordAttendance: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        entries: z
          .array(
            z.object({
              participantId: z.uuid(),
              attendance: z.enum(["planned", "attended", "absent", "excused"]),
            }),
          )
          .min(1),
      }),
    )
    .mutation(({ ctx, input }) => service.recordAttendance(ctx.db, ctx.user, input)),

  minutes: router({
    saveDraft: authedMutation
      .input(
        z.object({
          meetingId: z.uuid(),
          body: z.string().trim().min(1, "纪要内容必填").max(20000),
          disagreements: z.string().max(5000).nullable().optional(),
          risks: z.string().max(5000).nullable().optional(),
          rowVersion: z.number().int().min(0).optional(),
        }),
      )
      .mutation(({ ctx, input }) => minutes.saveMinutesDraft(ctx.db, ctx.user, input)),

    submitConfirm: authedMutation
      .input(
        z.object({
          meetingId: z.uuid(),
          versionNo: z.number().int().min(1),
          confirmerId: z.uuid(),
        }),
      )
      .mutation(({ ctx, input }) => minutes.submitMinutesConfirm(ctx.db, ctx.user, input)),

    confirm: authedMutation
      .input(
        z.object({
          meetingId: z.uuid(),
          versionNo: z.number().int().min(1),
          idempotencyKey: z.uuid(),
        }),
      )
      .mutation(({ ctx, input }) => minutes.confirmMinutes(ctx.db, ctx.user, input)),

    versions: authedProcedure
      .input(z.object({ meetingId: z.uuid() }))
      .query(({ ctx, input }) => minutes.listMinutesVersions(ctx.db, ctx.user, input.meetingId)),
  }),

  action: router({
    addItem: authedMutation
      .input(
        z.object({
          meetingId: z.uuid(),
          minutesVersionId: z.uuid().optional(),
          title: z.string().trim().min(1, "标题必填").max(200),
          ownerId: z.uuid(),
          dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          deliverable: z.string().max(1000).optional(),
          checkpoint: z.string().max(1000).optional(),
        }),
      )
      .mutation(({ ctx, input }) => minutes.addActionItem(ctx.db, ctx.user, input)),

    convertToTask: authedMutation
      .input(z.object({ id: z.uuid(), idempotencyKey: z.uuid() }))
      .mutation(({ ctx, input }) => minutes.convertActionItem(ctx.db, ctx.user, input)),

    list: authedProcedure
      .input(z.object({ meetingId: z.uuid() }))
      .query(({ ctx, input }) => minutes.listActionItems(ctx.db, ctx.user, input.meetingId)),
  }),

  extra: router({
    escalateToDecision: authedMutation
      .input(
        z.object({
          meetingId: z.uuid(),
          minutesVersionId: z.uuid().optional(),
          title: z.string().trim().min(1, "标题必填").max(200),
          context: z.string().trim().min(1, "背景必填").max(5000),
        }),
      )
      .mutation(({ ctx, input }) => minutes.escalateToDecision(ctx.db, ctx.user, input)),

    timePrefillSuggestion: authedProcedure
      .input(z.object({ meetingId: z.uuid() }))
      .query(({ ctx, input }) => minutes.meetingTimePrefill(ctx.db, ctx.user, input.meetingId)),
  }),
});
