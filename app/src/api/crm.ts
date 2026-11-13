import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** CRM 域 hooks（arch/12 §6/§11：crm.read/manage 门；金额列对无 fin.read 自动缺席） */

export function useLeadList(input: { status?: string; keyword?: string; cursor?: string; limit?: number }) {
  const trpc = useTRPC();
  return useQuery(trpc.crm.leads.list.queryOptions({ limit: 20, keyword: input.keyword, cursor: input.cursor, ...(input.status ? { status: input.status as never } : {}) }));
}

export function useCustomerList(input: { level?: string; keyword?: string; cursor?: string; limit?: number }) {
  const trpc = useTRPC();
  return useQuery(trpc.crm.customers.list.queryOptions({ limit: 20, ...input }));
}

export function useCustomer(id: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.crm.customers.getById.queryOptions({ id: id ?? "" }, { enabled: !!id }));
}

export function useOpportunityList(input: { stage?: string; customerId?: string; cursor?: string; limit?: number }) {
  const trpc = useTRPC();
  return useQuery(trpc.crm.opportunities.list.queryOptions({ limit: 50, customerId: input.customerId, cursor: input.cursor, ...(input.stage ? { stage: input.stage as never } : {}) }));
}

/** 商机详情（arch/13 §5.4：含关联项目最小标识 id/code/name/lifecycleStatus） */
export function useOpportunity(id: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.crm.opportunities.getById.queryOptions({ id: id ?? "" }, { enabled: !!id }));
}

export function useContractList(input: { status?: string; customerId?: string; cursor?: string; limit?: number }, enabled = true) {
  const trpc = useTRPC();
  return useQuery(trpc.crm.contracts.list.queryOptions({ limit: 20, customerId: input.customerId, cursor: input.cursor, ...(input.status ? { status: input.status as never } : {}) }, { enabled }));
}

export function useContract(id: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.crm.contracts.getById.queryOptions({ id: id ?? "" }, { enabled: !!id }));
}

export function useFollowupList(targetType: "lead" | "opportunity" | "customer" | null, targetId: string | null) {
  const trpc = useTRPC();
  return useQuery(
    trpc.crm.followups.list.queryOptions(
      { targetType: (targetType ?? "customer") as never, targetId: targetId ?? "" },
      { enabled: !!targetType && !!targetId },
    ),
  );
}

export function useCrmMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries(trpc.crm.pathFilter());
  return {
    createLead: useMutation(trpc.crm.leads.create.mutationOptions({ onSuccess: invalidate })),
    updateLead: useMutation(trpc.crm.leads.update.mutationOptions({ onSuccess: invalidate })),
    disqualifyLead: useMutation(trpc.crm.leads.disqualify.mutationOptions({ onSuccess: invalidate })),
    convertLead: useMutation(trpc.crm.leads.convert.mutationOptions({ onSuccess: invalidate })),
    updateCustomer: useMutation(trpc.crm.customers.update.mutationOptions({ onSuccess: invalidate })),
    createContact: useMutation(trpc.crm.contacts.create.mutationOptions({ onSuccess: invalidate })),
    updateContact: useMutation(trpc.crm.contacts.update.mutationOptions({ onSuccess: invalidate })),
    deleteContact: useMutation(trpc.crm.contacts.delete.mutationOptions({ onSuccess: invalidate })),
    createOpportunity: useMutation(trpc.crm.opportunities.create.mutationOptions({ onSuccess: invalidate })),
    updateOpportunity: useMutation(trpc.crm.opportunities.update.mutationOptions({ onSuccess: invalidate })),
    setStage: useMutation(trpc.crm.opportunities.setStage.mutationOptions({ onSuccess: invalidate })),
    markWon: useMutation(trpc.crm.opportunities.markWon.mutationOptions({ onSuccess: invalidate })),
    markLost: useMutation(trpc.crm.opportunities.markLost.mutationOptions({ onSuccess: invalidate })),
    /** 补建售前计划（arch/13 §5.3：幂等，已有 v1 返回现状） */
    ensureProjectPlan: useMutation(trpc.crm.opportunities.ensureProjectPlan.mutationOptions({ onSuccess: invalidate })),
    updateContract: useMutation(trpc.crm.contracts.update.mutationOptions({ onSuccess: invalidate })),
    activateContract: useMutation(trpc.crm.contracts.activate.mutationOptions({ onSuccess: invalidate })),
    terminateContract: useMutation(trpc.crm.contracts.terminate.mutationOptions({ onSuccess: invalidate })),
    upsertPlans: useMutation(trpc.crm.paymentPlans.upsert.mutationOptions({ onSuccess: invalidate })),
    createFollowup: useMutation(trpc.crm.followups.create.mutationOptions({ onSuccess: invalidate })),
  };
}
