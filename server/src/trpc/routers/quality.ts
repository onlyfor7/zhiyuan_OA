import { z } from "zod";

import { CHECK_ITEM_STATUS, QUALITY_SEVERITY, QUALITY_ISSUE_STATUS } from "@lexflow/shared";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as service from "../../modules/governance/quality";

const cursorPage = {
  cursor: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(100).default(20),
};

export const qualityRouter = router({
  list: authedProcedure
    .input(
      z
        .object({
          projectId: z.uuid().optional(),
          status: z.enum(QUALITY_ISSUE_STATUS).optional(),
          severity: z.enum(QUALITY_SEVERITY).optional(),
          ...cursorPage,
        })
        .prefault({}),
    )
    .query(({ ctx, input }) => service.listIssues(ctx.db, ctx.user, input)),

  getById: authedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => service.getIssue(ctx.db, ctx.user, input.id)),

  create: authedMutation
    .input(
      z.object({
        projectId: z.uuid(),
        title: z.string().trim().min(1, "标题必填").max(200),
        description: z.string().trim().min(1, "描述必填").max(2000),
        severity: z.enum(QUALITY_SEVERITY),
        handlerId: z.uuid().optional(),
        reviewerId: z.uuid().optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.createIssue(ctx.db, ctx.user, input)),

  update: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        rowVersion: z.number().int().min(0),
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().min(1).max(2000).optional(),
        severity: z.enum(QUALITY_SEVERITY).optional(),
        rootCause: z.string().max(1000).nullable().optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.updateIssue(ctx.db, ctx.user, input)),

  assign: authedMutation
    .input(z.object({ id: z.uuid(), handlerId: z.uuid(), reviewerId: z.uuid() }))
    .mutation(({ ctx, input }) => service.assignIssue(ctx.db, ctx.user, input)),

  submitHandling: authedMutation
    .input(z.object({ id: z.uuid(), note: z.string().trim().min(1, "处理说明必填").max(2000) }))
    .mutation(({ ctx, input }) => service.submitHandling(ctx.db, ctx.user, input)),

  review: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        action: z.enum(["pass", "return"]),
        comment: z.string().max(2000).optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.reviewIssue(ctx.db, ctx.user, input)),

  reopen: authedMutation
    .input(z.object({ id: z.uuid(), note: z.string().trim().min(1, "重开说明必填").max(2000) }))
    .mutation(({ ctx, input }) => service.reopenIssue(ctx.db, ctx.user, input)),

  checklist: authedProcedure
    .input(z.object({ projectId: z.uuid() }))
    .query(({ ctx, input }) => service.checklist(ctx.db, ctx.user, input.projectId)),

  checkItem: authedMutation
    .input(z.object({ id: z.uuid(), status: z.enum(CHECK_ITEM_STATUS) }))
    .mutation(({ ctx, input }) => service.checkItem(ctx.db, ctx.user, input)),
});
