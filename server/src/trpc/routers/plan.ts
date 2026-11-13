import { z } from "zod";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as service from "../../modules/governance/plan";

const adjustment = z.object({
  ref_id: z.uuid(),
  item_type: z.enum(["stage", "milestone", "task"]),
  new_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  new_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const planRouter = router({
  versions: authedProcedure
    .input(z.object({ projectId: z.uuid() }))
    .query(({ ctx, input }) => service.listVersions(ctx.db, ctx.user, input.projectId)),

  versionGet: authedProcedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) => service.getVersion(ctx.db, ctx.user, input.id)),

  current: authedProcedure
    .input(z.object({ projectId: z.uuid() }))
    .query(({ ctx, input }) => service.currentVersion(ctx.db, ctx.user, input.projectId)),
  /** 甘特专用输出（arch/13 §10）：仅阶段/里程碑条节点 + 任务三态聚合（done/overdue/delayed），无个人任务时间条 */
  gantt: authedProcedure
    .input(z.object({ projectId: z.uuid() }))
    .query(({ ctx, input }) => service.ganttView(ctx.db, ctx.user, input.projectId)),

  simulate: authedProcedure
    .input(
      z.object({
        projectId: z.uuid(),
        adjustments: z.array(adjustment).min(1, "至少一项调整"),
      }),
    )
    .query(({ ctx, input }) => service.simulate(ctx.db, ctx.user, input.projectId, input.adjustments)),

  transitionStage: authedMutation
    .input(z.object({ stageId: z.uuid(), action: z.enum(["start", "done"]) }))
    .mutation(({ ctx, input }) => service.transitionStage(ctx.db, ctx.user, input.stageId, input.action)),

  transitionMilestone: authedMutation
    .input(z.object({ milestoneId: z.uuid(), action: z.enum(["reach", "miss"]) }))
    .mutation(({ ctx, input }) =>
      service.transitionMilestone(ctx.db, ctx.user, input.milestoneId, input.action),
    ),
});
