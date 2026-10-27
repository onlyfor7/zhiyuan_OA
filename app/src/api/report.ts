import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 周报域 hooks（arch/04 §5 report.*） */

export function useReportList(projectId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.report.list.queryOptions({ projectId, limit: 50 }));
}

export function useReport(id: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.report.getById.queryOptions({ id: id ?? "" }, { enabled: !!id }));
}

export function useReportMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.report.pathFilter());
    void queryClient.invalidateQueries(trpc.archive.pathFilter());
    void queryClient.invalidateQueries(trpc.todo.pathFilter());
    void queryClient.invalidateQueries(trpc.project.overview.pathFilter());
  };
  const generateDraft = useMutation(trpc.report.generateDraft.mutationOptions({ onSuccess: invalidate }));
  const updateDraft = useMutation(trpc.report.updateDraft.mutationOptions({ onSuccess: invalidate }));
  const confirm = useMutation(trpc.report.confirm.mutationOptions({ onSuccess: invalidate }));
  const archive = useMutation(trpc.report.archive.mutationOptions({ onSuccess: invalidate }));
  return { generateDraft, updateDraft, confirm, archive };
}
