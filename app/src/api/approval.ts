import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 审批域 hooks（arch/04 §5 approval.*） */

export function useApprovalsMine() {
  const trpc = useTRPC();
  return useQuery(trpc.approval.listMine.queryOptions({ limit: 50 }));
}

export function useApprovalsApplied() {
  const trpc = useTRPC();
  return useQuery(trpc.approval.listMineApplied.queryOptions({ limit: 50 }));
}

export function useApproval(id: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.approval.getById.queryOptions({ id: id ?? "" }, { enabled: !!id }));
}

export function useApprovalAct() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.approval.act.mutationOptions({
      onSuccess: (result) => {
        // applied=false 为并发/重试已处理：前端按现状刷新（由组件提示）
        void queryClient.invalidateQueries(trpc.approval.pathFilter());
        void queryClient.invalidateQueries(trpc.todo.pathFilter());
        void queryClient.invalidateQueries(trpc.notification.pathFilter());
        void queryClient.invalidateQueries(trpc.change.pathFilter());
        void queryClient.invalidateQueries(trpc.archive.pathFilter());
        void queryClient.invalidateQueries(trpc.plan.pathFilter());
        return result;
      },
    }),
  );
}
