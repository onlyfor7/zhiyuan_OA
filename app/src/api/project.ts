import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 项目域 hooks（arch/02 §4 + arch/04 §5 project.*） */

export function useProject(id: string) {
  const trpc = useTRPC();
  return useQuery(trpc.project.getById.queryOptions({ id }));
}

export function useProjectList(filters: import("../lib/trpc").ProjectListFilters, limit = 20) {
  const trpc = useTRPC();
  return useQuery(trpc.project.list.queryOptions({ limit, filters }));
}

/** 驾驶舱「项目脉搏」预览：同一 project.list 契约，取最近更新的前 6 个 */
export function useProjectPreview() {
  const trpc = useTRPC();
  return useQuery(trpc.project.list.queryOptions({ limit: 6, filters: {} }));
}

export function useProjectOverview(projectId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.project.overview.queryOptions({ projectId }));
}

export function useProjectTemplates() {
  const trpc = useTRPC();
  return useQuery(trpc.project.listTemplates.queryOptions());
}

export function useProjectMembers(projectId: string) {
  const trpc = useTRPC();
  return useQuery(
    trpc.user.listProjectMembers.queryOptions({ projectId }, { enabled: !!projectId }),
  );
}

export function useCreateProject() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.project.create.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries(trpc.project.pathFilter());
        void queryClient.invalidateQueries(trpc.auth.me.pathFilter());
      },
    }),
  );
}

export function useUpdateProject() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.project.update.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries(trpc.project.pathFilter());
      },
    }),
  );
}

export function useCloseProject() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.project.close.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries(trpc.project.pathFilter());
      },
    }),
  );
}

/** G5：项目内审批流 hooks（project.flows.*；负责人门，服务端同形 404） */
export function useProjectFlows(projectId: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.project.flows.list.queryOptions({ projectId: projectId ?? "" }, { enabled: !!projectId }));
}

export function useProjectFlowMutations(projectId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.project.flows.pathFilter());
    void queryClient.invalidateQueries(trpc.flow.pathFilter());
  };
  const createDraft = useMutation(trpc.project.flows.createDraft.mutationOptions({ onSuccess: invalidate }));
  const updateDraft = useMutation(trpc.project.flows.updateDraft.mutationOptions({ onSuccess: invalidate }));
  const publish = useMutation(trpc.project.flows.publish.mutationOptions({ onSuccess: invalidate }));
  const disable = useMutation(trpc.project.flows.disable.mutationOptions({ onSuccess: invalidate }));
  return { createDraft, updateDraft, publish, disable, projectId };
}

export function useMemberMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.user.listProjectMembers.pathFilter());
    void queryClient.invalidateQueries(trpc.project.pathFilter());
  };
  const add = useMutation(trpc.project.addMember.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(trpc.project.updateMember.mutationOptions({ onSuccess: invalidate }));
  const remove = useMutation(trpc.project.removeMember.mutationOptions({ onSuccess: invalidate }));
  const transfer = useMutation(trpc.project.transferManager.mutationOptions({ onSuccess: invalidate }));
  return { add, update, remove, transfer };
}
