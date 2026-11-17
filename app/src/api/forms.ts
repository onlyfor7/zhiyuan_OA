import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 自定义表单域 hooks（arch/14 §4；forms.*） */

export function useFormList(enabled = true) {
  const trpc = useTRPC();
  return useQuery(trpc.forms.list.queryOptions(undefined, { enabled }));
}

export function useForm(id: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.forms.getById.queryOptions({ id: id ?? "" }, { enabled: !!id }));
}

export function useFormPublicList() {
  const trpc = useTRPC();
  return useQuery(trpc.forms.listPublic.queryOptions());
}

export function useFormMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.forms.pathFilter());
    void queryClient.invalidateQueries(trpc.flow.pathFilter());
  };
  return {
    create: useMutation(trpc.forms.create.mutationOptions({ onSuccess: invalidate })),
    updateDraft: useMutation(trpc.forms.updateDraft.mutationOptions({ onSuccess: invalidate })),
    publish: useMutation(trpc.forms.publish.mutationOptions({ onSuccess: invalidate })),
    disable: useMutation(trpc.forms.disable.mutationOptions({ onSuccess: invalidate })),
    delete: useMutation(trpc.forms.delete.mutationOptions({ onSuccess: invalidate })),
  };
}
