import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 财务核算 hooks（arch/12 §7：fin.read=finance/partner/PM+本项目 manager；member/sysadmin 同形 404） */

export function useReceivableList(input: { status?: string; customerId?: string; cursor?: string; limit?: number }) {
  const trpc = useTRPC();
  return useQuery(trpc.fin.receivables.list.queryOptions({ limit: 20, cursor: input.cursor, customerId: input.customerId, ...(input.status ? { status: input.status as never } : {}) }));
}

export function useInvoiceList(input: { status?: string; customerId?: string; cursor?: string; limit?: number }) {
  const trpc = useTRPC();
  return useQuery(trpc.fin.invoices.list.queryOptions({ limit: 20, cursor: input.cursor, customerId: input.customerId, ...(input.status ? { status: input.status as never } : {}) }));
}

export function useCostRates() {
  const trpc = useTRPC();
  return useQuery(trpc.fin.costRates.list.queryOptions());
}

export function useProjectCostingList() {
  const trpc = useTRPC();
  return useQuery(trpc.fin.projectCosting.list.queryOptions());
}

export function useProjectCosting(projectId: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.fin.projectCosting.get.queryOptions({ projectId: projectId ?? "" }, { enabled: !!projectId }));
}

export function useFinMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.fin.pathFilter());
    void queryClient.invalidateQueries(trpc.crm.pathFilter());
    void queryClient.invalidateQueries(trpc.receipts.pathFilter());
  };
  return {
    generateReceivables: useMutation(trpc.fin.receivables.generate.mutationOptions({ onSuccess: invalidate })),
    createInvoice: useMutation(trpc.fin.invoices.create.mutationOptions({ onSuccess: invalidate })),
    issueInvoice: useMutation(trpc.fin.invoices.issue.mutationOptions({ onSuccess: invalidate })),
    markInvoiceSent: useMutation(trpc.fin.invoices.markSent.mutationOptions({ onSuccess: invalidate })),
    voidInvoice: useMutation(trpc.fin.invoices.void.mutationOptions({ onSuccess: invalidate })),
    upsertCostRate: useMutation(trpc.fin.costRates.upsert.mutationOptions({ onSuccess: invalidate })),
  };
}
