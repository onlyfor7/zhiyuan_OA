import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 出差域 hooks（arch/05 §5：travel.*；transition 带 rowVersion，complete 前必须先 depart） */

export function useTravelList(input: {
  projectId?: string;
  mine?: boolean;
  status?:
    | "draft"
    | "pending_approval"
    | "approved"
    | "rejected"
    | "in_progress"
    | "completed"
    | "closed"
    | "cancelled";
  limit?: number;
}) {
  const trpc = useTRPC();
  return useQuery(trpc.travel.list.queryOptions({ limit: 20, ...input }));
}

export function useTravel(id: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.travel.getById.queryOptions({ id: id ?? "" }, { enabled: !!id }));
}

export function useTravelMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.travel.pathFilter());
    void queryClient.invalidateQueries(trpc.approval.pathFilter());
    void queryClient.invalidateQueries(trpc.todo.pathFilter());
    void queryClient.invalidateQueries(trpc.notification.pathFilter());
    void queryClient.invalidateQueries(trpc.dashboard.pathFilter());
    void queryClient.invalidateQueries(trpc.archive.pathFilter());
  };
  const create = useMutation(trpc.travel.create.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(trpc.travel.update.mutationOptions({ onSuccess: invalidate }));
  const submit = useMutation(trpc.travel.submit.mutationOptions({ onSuccess: invalidate }));
  const withdraw = useMutation(trpc.travel.withdraw.mutationOptions({ onSuccess: invalidate }));
  const transition = useMutation(trpc.travel.transition.mutationOptions({ onSuccess: invalidate }));
  const submitChange = useMutation(trpc.travel.submitChange.mutationOptions({ onSuccess: invalidate }));
  return { create, update, submit, withdraw, transition, submitChange };
}

/** 出差工时预填建议（只算不存，不按 24h；cancelled/rejected 返回 null） */
export function useTravelTimePrefill(travelId: string | null, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.travel.timePrefillSuggestion.queryOptions(
      { travelId: travelId ?? "" },
      { enabled: !!travelId && enabled },
    ),
  );
}
