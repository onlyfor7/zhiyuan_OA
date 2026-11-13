import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 计划域 hooks（arch/04 §5 plan.*） */

export function usePlanVersions(projectId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.plan.versions.queryOptions({ projectId }));
}

export function usePlanCurrent(projectId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.plan.current.queryOptions({ projectId }));
}

/** 节点级甘特（arch/13 §12/plan.gantt）：仅阶段/里程碑节点 + 任务三态聚合（done/overdue/delayed），任务不生成时间条 */
export function usePlanGantt(projectId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.plan.gantt.queryOptions({ projectId }, { enabled: !!projectId }));
}

export function usePlanVersion(id: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.plan.versionGet.queryOptions({ id: id ?? "" }, { enabled: !!id }));
}

export type PlanAdjustment = {
  ref_id: string;
  item_type: "stage" | "milestone" | "task";
  new_start: string;
  new_end: string;
};

/** plan.simulate 是只读 query（只算不写，PLN-I1）；enabled 由调用方控制 */
export function usePlanSimulate(
  projectId: string,
  adjustments: PlanAdjustment[],
  enabled: boolean,
) {
  const trpc = useTRPC();
  return useQuery(
    trpc.plan.simulate.queryOptions(
      { projectId, adjustments },
      { enabled: enabled && adjustments.length > 0 },
    ),
  );
}

export function usePlanTransitions() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.plan.pathFilter());
    void queryClient.invalidateQueries(trpc.task.pathFilter());
    void queryClient.invalidateQueries(trpc.project.overview.pathFilter());
  };
  const stage = useMutation(trpc.plan.transitionStage.mutationOptions({ onSuccess: invalidate }));
  const milestone = useMutation(
    trpc.plan.transitionMilestone.mutationOptions({ onSuccess: invalidate }),
  );
  return { stage, milestone };
}
