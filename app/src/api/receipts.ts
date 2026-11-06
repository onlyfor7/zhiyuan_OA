import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 收款域 hooks（arch/09 §2：receipts.*；member/viewer 服务端同形 404） */

export function useReceiptList(input: { projectId?: string; clientId?: string; from?: string; to?: string }, enabled = true) {
  const trpc = useTRPC();
  return useQuery(trpc.receipts.list.queryOptions({ limit: 50, ...input }, { enabled }));
}

export function useReceipt(id: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.receipts.getById.queryOptions({ id: id ?? "" }, { enabled: !!id }));
}

export function useReceiptSummary(by: "project" | "client" | "period", enabled = true) {
  const trpc = useTRPC();
  return useQuery(trpc.receipts.summary.queryOptions({ by }, { enabled }));
}

/** 登记表单项目下拉（arch 裁定 04b-①：receipts.projectOptions 参照级清单；finance/partner，其余同形 404） */
export function useReceiptProjectOptions(enabled = true) {
  const trpc = useTRPC();
  return useQuery(trpc.receipts.projectOptions.queryOptions(undefined, { enabled }));
}

export function useReceiptMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.receipts.pathFilter());
    void queryClient.invalidateQueries(trpc.project.pathFilter());
    void queryClient.invalidateQueries(trpc.dashboard.pathFilter());
    // 9d-03：登记/作废同事务写回合同计划行+应收重算——crm/fin 缓存一并失效
    void queryClient.invalidateQueries(trpc.crm.pathFilter());
    void queryClient.invalidateQueries(trpc.fin.pathFilter());
  };
  const create = useMutation(trpc.receipts.create.mutationOptions({ onSuccess: invalidate }));
  const voidReceipt = useMutation(trpc.receipts.void.mutationOptions({ onSuccess: invalidate }));
  return { create, voidReceipt };
}

export function useReceiptExport() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return () => queryClient.fetchQuery(trpc.receipts.exportCsv.queryOptions({}));
}
