import { z } from "zod";

import { ACCESS_GRANT_SCOPE_TYPE } from "@lexflow/shared";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as service from "../../modules/governance/archive";

export const archiveRouter = router({
  tree: authedProcedure
    .input(z.object({ projectId: z.uuid() }))
    .query(({ ctx, input }) => service.archiveTree(ctx.db, ctx.user, input.projectId)),

  directoryItems: authedProcedure
    .input(
      z.object({
        directoryId: z.uuid(),
        cursor: z.string().max(300).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    )
    .query(({ ctx, input }) => service.directoryItems(ctx.db, ctx.user, input)),

  link: authedMutation
    .input(
      z.object({
        directoryId: z.uuid(),
        fileVersionId: z.uuid().optional(),
        reportId: z.uuid().optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.linkItem(ctx.db, ctx.user, input)),

  grantApply: authedMutation
    .input(
      z.object({
        scopeType: z.enum(ACCESS_GRANT_SCOPE_TYPE),
        scopeId: z.uuid(),
        granteeId: z.uuid(),
        actions: z.array(z.string().min(1)).min(1, "至少一个动作"),
        expiresAt: z.string().min(10).nullable().optional(),
        reason: z.string().trim().min(1, "申请理由必填").max(1000),
        idempotencyKey: z.uuid(),
      }),
    )
    .mutation(({ ctx, input }) => service.grantApply(ctx.db, ctx.user, input)),

  grantRevoke: authedMutation
    .input(z.object({ id: z.uuid(), reason: z.string().trim().min(1, "撤销理由必填").max(1000) }))
    .mutation(({ ctx, input }) => service.grantRevoke(ctx.db, ctx.user, input)),

  grantList: authedProcedure.query(({ ctx }) => service.grantList(ctx.db, ctx.user)),
});
