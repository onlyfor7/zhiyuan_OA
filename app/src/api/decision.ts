import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DECISION_STATUS } from "@lexflow/shared";

import { useTRPC } from "../lib/trpc";

/** 决策域 hooks（arch/04 §5 decision.*） */

export function useDecisionList(input: { projectId?: string; status?: (typeof DECISION_STATUS)[number] }) {
  const trpc = useTRPC();
  return useQuery(trpc.decision.list.queryOptions({ limit: 100, ...input }));
}

export function useDecision(id: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.decision.getById.queryOptions({ id: id ?? "" }, { enabled: !!id }));
}

export function useDecisionMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.decision.pathFilter());
    void queryClient.invalidateQueries(trpc.task.pathFilter());
    void queryClient.invalidateQueries(trpc.todo.pathFilter());
    void queryClient.invalidateQueries(trpc.notification.pathFilter());
    void queryClient.invalidateQueries(trpc.project.overview.pathFilter());
    void queryClient.invalidateQueries(trpc.dashboard.pathFilter());
  };
  const create = useMutation(trpc.decision.create.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(trpc.decision.update.mutationOptions({ onSuccess: invalidate }));
  const submitOpinions = useMutation(
    trpc.decision.submitOpinions.mutationOptions({ onSuccess: invalidate }),
  );
  const decide = useMutation(trpc.decision.decide.mutationOptions({ onSuccess: invalidate }));
  const verify = useMutation(trpc.decision.verify.mutationOptions({ onSuccess: invalidate }));
  return { create, update, submitOpinions, decide, verify };
}
