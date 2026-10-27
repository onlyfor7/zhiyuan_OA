import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 费用域 hooks（arch/06 §7：expense.* 与 expense.stats.*） */

export function useExpenseList(input: {
  projectId?: string;
  mine?: boolean;
  status?: "draft" | "pending_approval" | "rejected" | "approved_pending_payment" | "paid";
}) {
  const trpc = useTRPC();
  return useQuery(trpc.expense.list.queryOptions({ limit: 50, ...input }));
}

export function useExpense(id: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.expense.getById.queryOptions({ id: id ?? "" }, { enabled: !!id }));
}

export function useExpenseMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.expense.pathFilter());
    void queryClient.invalidateQueries(trpc.budget.pathFilter());
    void queryClient.invalidateQueries(trpc.funding.pathFilter());
    void queryClient.invalidateQueries(trpc.project.pathFilter());
    void queryClient.invalidateQueries(trpc.todo.pathFilter());
    void queryClient.invalidateQueries(trpc.notification.pathFilter());
    void queryClient.invalidateQueries(trpc.archive.pathFilter());
    void queryClient.invalidateQueries(trpc.approval.pathFilter());
    void queryClient.invalidateQueries(trpc.dashboard.pathFilter());
  };
  const create = useMutation(trpc.expense.create.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(trpc.expense.update.mutationOptions({ onSuccess: invalidate }));
  const submit = useMutation(trpc.expense.submit.mutationOptions({ onSuccess: invalidate }));
  const withdraw = useMutation(trpc.expense.withdraw.mutationOptions({ onSuccess: invalidate }));
  const addItem = useMutation(trpc.expense.addItem.mutationOptions({ onSuccess: invalidate }));
  const removeItem = useMutation(trpc.expense.removeItem.mutationOptions({ onSuccess: invalidate }));
  const attachReceipt = useMutation(trpc.expense.attachReceipt.mutationOptions({ onSuccess: invalidate }));
  const markPaid = useMutation(trpc.expense.markPaid.mutationOptions({ onSuccess: invalidate }));
  const adjustCreate = useMutation(trpc.expense.adjustCreate.mutationOptions({ onSuccess: invalidate }));
  return {
    create,
    update,
    submit,
    withdraw,
    addItem,
    removeItem,
    attachReceipt,
    markPaid,
    adjustCreate,
  };
}

export function useExpenseStatsByProject(projectId: string | null) {
  const trpc = useTRPC();
  return useQuery(
    trpc.expense.stats.byProject.queryOptions({ projectId: projectId ?? "" }, { enabled: !!projectId }),
  );
}

export function useExpenseStatsByCategory(projectId: string | null) {
  const trpc = useTRPC();
  return useQuery(
    trpc.expense.stats.byCategory.queryOptions({ projectId: projectId ?? "" }, { enabled: !!projectId }),
  );
}

export function useExpenseStatsByPerson(projectId: string | null) {
  const trpc = useTRPC();
  return useQuery(
    trpc.expense.stats.byPerson.queryOptions({ projectId: projectId ?? "" }, { enabled: !!projectId }),
  );
}

export function useExportCsv(projectId: string | null) {
  const trpc = useTRPC();
  return useQuery(
    trpc.expense.stats.exportCsv.queryOptions({ projectId: projectId ?? "" }, { enabled: false }),
  );
}
