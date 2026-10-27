import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CHANGE_REQUEST_STATUS } from "@lexflow/shared";

import { useTRPC } from "../lib/trpc";

/** 延期申请域 hooks（arch/04 §5 change.*） */

export function useChangeList(input: { projectId?: string; status?: (typeof CHANGE_REQUEST_STATUS)[number] }) {
  const trpc = useTRPC();
  return useQuery(trpc.change.list.queryOptions({ limit: 50, ...input }));
}

export function useChange(id: string) {
  const trpc = useTRPC();
  return useQuery(trpc.change.getById.queryOptions({ id }));
}

export function useChangeMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.change.pathFilter());
    void queryClient.invalidateQueries(trpc.plan.pathFilter());
    void queryClient.invalidateQueries(trpc.approval.pathFilter());
    void queryClient.invalidateQueries(trpc.todo.pathFilter());
    void queryClient.invalidateQueries(trpc.project.overview.pathFilter());
  };
  const create = useMutation(trpc.change.create.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(trpc.change.update.mutationOptions({ onSuccess: invalidate }));
  const submit = useMutation(trpc.change.submit.mutationOptions({ onSuccess: invalidate }));
  const withdraw = useMutation(trpc.change.withdraw.mutationOptions({ onSuccess: invalidate }));
  return { create, update, submit, withdraw };
}
