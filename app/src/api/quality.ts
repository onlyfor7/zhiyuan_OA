import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { QUALITY_ISSUE_STATUS, QUALITY_SEVERITY } from "@lexflow/shared";

import { useTRPC } from "../lib/trpc";

/** 质量域 hooks（arch/04 §5 quality.*） */

export function useQualityList(input: {
  projectId?: string;
  status?: (typeof QUALITY_ISSUE_STATUS)[number];
  severity?: (typeof QUALITY_SEVERITY)[number];
}) {
  const trpc = useTRPC();
  return useQuery(trpc.quality.list.queryOptions({ limit: 100, ...input }));
}

export function useQualityIssue(id: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.quality.getById.queryOptions({ id: id ?? "" }, { enabled: !!id }));
}

export function useQualityChecklist(projectId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.quality.checklist.queryOptions({ projectId }));
}

export function useQualityMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.quality.pathFilter());
    void queryClient.invalidateQueries(trpc.todo.pathFilter());
    void queryClient.invalidateQueries(trpc.project.overview.pathFilter());
    void queryClient.invalidateQueries(trpc.dashboard.pathFilter());
  };
  const create = useMutation(trpc.quality.create.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(trpc.quality.update.mutationOptions({ onSuccess: invalidate }));
  const assign = useMutation(trpc.quality.assign.mutationOptions({ onSuccess: invalidate }));
  const submitHandling = useMutation(
    trpc.quality.submitHandling.mutationOptions({ onSuccess: invalidate }),
  );
  const review = useMutation(trpc.quality.review.mutationOptions({ onSuccess: invalidate }));
  const reopen = useMutation(trpc.quality.reopen.mutationOptions({ onSuccess: invalidate }));
  const checkItem = useMutation(trpc.quality.checkItem.mutationOptions({ onSuccess: invalidate }));
  return { create, update, assign, submitHandling, review, reopen, checkItem };
}
