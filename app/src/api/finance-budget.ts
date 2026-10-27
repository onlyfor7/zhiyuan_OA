import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 预算域 hooks（arch/06 §7：budget.*） */

export function useBudgetList(projectId?: string, enabled = true) {
  const trpc = useTRPC();
  return useQuery(
    trpc.budget.list.queryOptions({ projectId, limit: 50 }, { enabled: enabled && !!projectId }),
  );
}

export function useBudget(id: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.budget.getById.queryOptions({ id: id ?? "" }, { enabled: !!id }));
}

export function useBudgetLedger(input: { budgetId?: string; projectId?: string }) {
  const trpc = useTRPC();
  const queryInput = input.budgetId
    ? { budgetId: input.budgetId, limit: 100 }
    : { projectId: input.projectId ?? "", limit: 100 };
  return useQuery(
    trpc.budget.ledger.queryOptions(queryInput as never, { enabled: !!(input.budgetId || input.projectId) }),
  );
}

export function useBudgetMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.budget.pathFilter());
    void queryClient.invalidateQueries(trpc.project.pathFilter());
    void queryClient.invalidateQueries(trpc.dashboard.pathFilter());
    void queryClient.invalidateQueries(trpc.todo.pathFilter());
    void queryClient.invalidateQueries(trpc.approval.pathFilter());
  };
  const create = useMutation(trpc.budget.create.mutationOptions({ onSuccess: invalidate }));
  const submit = useMutation(trpc.budget.submit.mutationOptions({ onSuccess: invalidate }));
  const withdraw = useMutation(trpc.budget.withdraw.mutationOptions({ onSuccess: invalidate }));
  const adjust = useMutation(trpc.budget.adjust.mutationOptions({ onSuccess: invalidate }));
  const close = useMutation(trpc.budget.close.mutationOptions({ onSuccess: invalidate }));
  return { create, submit, withdraw, adjust, close };
}

/** 经费域 hooks（arch/06 §7：funding.*） */

export function useFundingList(input: {
  projectId?: string;
  mine?: boolean;
  status?: "draft" | "pending_approval" | "approved" | "rejected";
}) {
  const trpc = useTRPC();
  return useQuery(trpc.funding.list.queryOptions({ limit: 50, ...input }));
}

export function useFunding(id: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.funding.getById.queryOptions({ id: id ?? "" }, { enabled: !!id }));
}

export function useFundingMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.funding.pathFilter());
    void queryClient.invalidateQueries(trpc.budget.pathFilter());
    void queryClient.invalidateQueries(trpc.project.pathFilter());
    void queryClient.invalidateQueries(trpc.todo.pathFilter());
    void queryClient.invalidateQueries(trpc.notification.pathFilter());
    void queryClient.invalidateQueries(trpc.archive.pathFilter());
    void queryClient.invalidateQueries(trpc.approval.pathFilter());
  };
  const create = useMutation(trpc.funding.create.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(trpc.funding.update.mutationOptions({ onSuccess: invalidate }));
  const submit = useMutation(trpc.funding.submit.mutationOptions({ onSuccess: invalidate }));
  const withdraw = useMutation(trpc.funding.withdraw.mutationOptions({ onSuccess: invalidate }));
  const close = useMutation(trpc.funding.close.mutationOptions({ onSuccess: invalidate }));
  const releaseUnused = useMutation(trpc.funding.releaseUnused.mutationOptions({ onSuccess: invalidate }));
  return { create, update, submit, withdraw, close, releaseUnused };
}
