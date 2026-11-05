import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 组织管理 hooks（arch/12 §9/§11：org.manage=sysadmin 写、partner 只读穿透、member 同形 404） */

export function useCompany() {
  const trpc = useTRPC();
  return useQuery(trpc.org.company.get.queryOptions());
}

export function useUnitTree() {
  const trpc = useTRPC();
  return useQuery(trpc.org.units.tree.queryOptions());
}

export function useOrgMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.org.pathFilter());
    void queryClient.invalidateQueries(trpc.admin.pathFilter());
    void queryClient.invalidateQueries(trpc.auth.pathFilter());
  };
  const updateCompany = useMutation(trpc.org.company.update.mutationOptions({ onSuccess: invalidate }));
  const createUnit = useMutation(trpc.org.units.create.mutationOptions({ onSuccess: invalidate }));
  const updateUnit = useMutation(trpc.org.units.update.mutationOptions({ onSuccess: invalidate }));
  const disableUnit = useMutation(trpc.org.units.disable.mutationOptions({ onSuccess: invalidate }));
  const moveUnit = useMutation(trpc.org.units.move.mutationOptions({ onSuccess: invalidate }));
  const createMember = useMutation(trpc.org.members.create.mutationOptions({ onSuccess: invalidate }));
  const updateMember = useMutation(trpc.org.members.update.mutationOptions({ onSuccess: invalidate }));
  const setMemberStatus = useMutation(trpc.org.members.setStatus.mutationOptions({ onSuccess: invalidate }));
  return {
    updateCompany,
    createUnit,
    updateUnit,
    disableUnit,
    moveUnit,
    createMember,
    updateMember,
    setMemberStatus,
  };
}

export function useMemberList(input: { orgUnitId?: string; keyword?: string; cursor?: string; limit?: number }, enabled = true) {
  const trpc = useTRPC();
  return useQuery(trpc.org.members.list.queryOptions({ limit: 20, ...input }, { enabled }));
}
