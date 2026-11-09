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

/** §16.2 审批业务详情聚合：通用字段（申请人/项目名）+ 按 biz_type 快照；权限=申请人∪当前审批人 */
export function useApprovalDetail(instanceId: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.approval.detail.queryOptions({ instanceId: instanceId ?? "" }, { enabled: !!instanceId }));
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
