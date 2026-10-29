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

export function useReceiptMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.receipts.pathFilter());
    void queryClient.invalidateQueries(trpc.project.pathFilter());
    void queryClient.invalidateQueries(trpc.dashboard.pathFilter());
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
