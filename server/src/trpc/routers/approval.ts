import { z } from "zod";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as engine from "../../services/approval/engine";
import * as queries from "../../modules/governance/queries";
import { markHandledFor } from "../../modules/notify";

const cursorPage = {
  cursor: z.string().max(300).optional(),
  limit: z.number().int().min(1).max(100).default(20),
};

export const approvalRouter = router({
  listMine: authedProcedure
    .input(z.object({ ...cursorPage }).prefault({}))
    .query(({ ctx, input }) => queries.listMineApprovals(ctx.db, ctx.user, input)),

  listMineApplied: authedProcedure
    .input(z.object({ ...cursorPage }).prefault({}))
    .query(({ ctx, input }) => queries.listMineApplied(ctx.db, ctx.user, input)),

  getById: authedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => queries.getApprovalById(ctx.db, ctx.user, input.id)),

  detail: authedProcedure
    .input(z.object({ instanceId: z.uuid() }))
    .query(({ ctx, input }) => queries.getApprovalDetail(ctx.db, ctx.user, input.instanceId)),

  act: authedMutation
    .input(
      z.object({
        instanceId: z.uuid(),
        stepSeq: z.number().int().min(1),
        action: z.enum(["approve", "reject", "transfer"]),
        comment: z.string().max(2000).optional(),
        transferTo: z.uuid().optional(),
        idempotencyKey: z.uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await engine.act(ctx.db, {
        instanceId: input.instanceId,
        stepSeq: input.stepSeq,
        actorId: ctx.user.id,
        action: input.action,
        comment: input.comment ?? null,
        transferTo: input.transferTo ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      });
      // 处理后同步 handled（arch/04 §6：不靠用户手动已读替代处理）
      if (result.applied) {
        const instance = result.instance;
        await markHandledFor(
          ctx.db,
          ctx.user.id,
          instance.bizType === "change_request" ? "change_request" : "access_grant",
          instance.bizId,
        );
      }
      return result;
    }),
});
