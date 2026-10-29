import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 配置中心 hooks（arch/09 §4.2：admin.*；全部 sysadmin 门，服务端同形 404） */

export function useAdminUsers(enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(trpc.admin.userList.queryOptions(undefined, { enabled }));
}

export function useAdminMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.admin.pathFilter());
    void queryClient.invalidateQueries(trpc.auth.pathFilter());
    void queryClient.invalidateQueries(trpc.user.pathFilter());
    void queryClient.invalidateQueries(trpc.client.pathFilter());
    void queryClient.invalidateQueries(trpc.matter.pathFilter());
  };
  const createUser = useMutation(trpc.admin.createUser.mutationOptions({ onSuccess: invalidate }));
  const disableUser = useMutation(trpc.admin.disableUser.mutationOptions({ onSuccess: invalidate }));
  const enableUser = useMutation(trpc.admin.enableUser.mutationOptions({ onSuccess: invalidate }));
  const assignRole = useMutation(trpc.admin.assignRole.mutationOptions({ onSuccess: invalidate }));
  const unassignRole = useMutation(trpc.admin.unassignRole.mutationOptions({ onSuccess: invalidate }));
  const createClient = useMutation(trpc.admin.createClient.mutationOptions({ onSuccess: invalidate }));
  const setClientDisabled = useMutation(trpc.admin.setClientDisabled.mutationOptions({ onSuccess: invalidate }));
  const createMatter = useMutation(trpc.admin.createMatter.mutationOptions({ onSuccess: invalidate }));
  const setMatterDisabled = useMutation(trpc.admin.setMatterDisabled.mutationOptions({ onSuccess: invalidate }));
  const updateTemplate = useMutation(trpc.admin.updateTemplate.mutationOptions({ onSuccess: invalidate }));
  const setConfig = useMutation(trpc.admin.setConfig.mutationOptions({ onSuccess: invalidate }));
  return {
    createUser,
    disableUser,
    enableUser,
    assignRole,
    unassignRole,
    createClient,
    setClientDisabled,
    createMatter,
    setMatterDisabled,
    updateTemplate,
    setConfig,
  };
}

export function useAdminConfig(key: string | null, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(trpc.admin.getConfig.queryOptions({ key: key ?? "" }, { enabled: enabled && !!key }));
}
