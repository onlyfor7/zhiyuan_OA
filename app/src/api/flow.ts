import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC, type RouterInputs } from "../lib/trpc";

/** 审批流设计器 hooks（arch/09 §3.1：flow.*；sysadmin/partner） */

export type FlowDefinitionInput = RouterInputs["flow"]["createDraft"]["definitionJson"];

export function useFlowList() {
  const trpc = useTRPC();
  return useQuery(trpc.flow.list.queryOptions());
}

export function useFlow(id: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.flow.getById.queryOptions({ id: id ?? "" }, { enabled: !!id }));
}

export function useFlowVersions(name: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.flow.versions.queryOptions({ name: name ?? "" }, { enabled: !!name }));
}

export function useFlowValidate() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return (definitionJson: FlowDefinitionInput) =>
    queryClient.fetchQuery(trpc.flow.validate.queryOptions({ definitionJson: definitionJson as never }));
}

export function useFlowMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => void queryClient.invalidateQueries(trpc.flow.pathFilter());
  const createDraft = useMutation(trpc.flow.createDraft.mutationOptions({ onSuccess: invalidate }));
  const updateDraft = useMutation(trpc.flow.updateDraft.mutationOptions({ onSuccess: invalidate }));
  const publish = useMutation(trpc.flow.publish.mutationOptions({ onSuccess: invalidate }));
  const disable = useMutation(trpc.flow.disable.mutationOptions({ onSuccess: invalidate }));
  const duplicateAsDraft = useMutation(trpc.flow.duplicateAsDraft.mutationOptions({ onSuccess: invalidate }));
  const deleteDraft = useMutation(trpc.flow.deleteDraft.mutationOptions({ onSuccess: invalidate }));
  return { createDraft, updateDraft, publish, disable, duplicateAsDraft, deleteDraft };
}
