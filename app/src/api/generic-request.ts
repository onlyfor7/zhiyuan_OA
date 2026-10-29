import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 通用申请单 hooks（arch/09 §3.2：genericRequest.*） */

type RequestStatus = "draft" | "pending_approval" | "approved" | "rejected" | "withdrawn";

export function useRequestList(input: { mine?: boolean; requestType?: string; status?: RequestStatus }) {
  const trpc = useTRPC();
  return useQuery(trpc.genericRequest.list.queryOptions({ limit: 50, ...input }));
}

export function useRequest(id: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.genericRequest.getById.queryOptions({ id: id ?? "" }, { enabled: !!id }));
}

export function useRequestMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.genericRequest.pathFilter());
    void queryClient.invalidateQueries(trpc.approval.pathFilter());
    void queryClient.invalidateQueries(trpc.todo.pathFilter());
    void queryClient.invalidateQueries(trpc.notification.pathFilter());
  };
  const create = useMutation(trpc.genericRequest.create.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(trpc.genericRequest.update.mutationOptions({ onSuccess: invalidate }));
  const submit = useMutation(trpc.genericRequest.submit.mutationOptions({ onSuccess: invalidate }));
  const withdraw = useMutation(trpc.genericRequest.withdraw.mutationOptions({ onSuccess: invalidate }));
  return { create, update, submit, withdraw };
}
