import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TASK_STATUS } from "@lexflow/shared";

import { useTRPC } from "../lib/trpc";

/** 任务域 hooks（arch/04 §5 task.*） */

export function useTaskList(input: {
  projectId?: string;
  mine?: boolean;
  status?: (typeof TASK_STATUS)[number];
}) {
  const trpc = useTRPC();
  return useQuery(trpc.task.list.queryOptions({ limit: 100, ...input }));
}

export function useTaskMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.task.pathFilter());
    void queryClient.invalidateQueries(trpc.todo.pathFilter());
    void queryClient.invalidateQueries(trpc.project.overview.pathFilter());
    void queryClient.invalidateQueries(trpc.dashboard.pathFilter());
  };
  const create = useMutation(trpc.task.create.mutationOptions({ onSuccess: invalidate }));
  const transition = useMutation(trpc.task.transition.mutationOptions({ onSuccess: invalidate }));
  const assign = useMutation(trpc.task.assign.mutationOptions({ onSuccess: invalidate }));
  return { create, transition, assign };
}
