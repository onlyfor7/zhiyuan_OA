import { useQuery } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 参照数据只读端点（arch/02 §4.1 v1.2：登录可用、最小字段、无行级 ABAC） */

export function useUserList(keyword: string) {
  const trpc = useTRPC();
  return useQuery(
    trpc.user.list.queryOptions({ keyword: keyword.trim() || undefined, limit: 50 }),
  );
}

export function useClientList(keyword: string) {
  const trpc = useTRPC();
  return useQuery(
    trpc.client.list.queryOptions({ keyword: keyword.trim() || undefined, limit: 50 }),
  );
}

export function useMatterList(keyword: string, clientId?: string) {
  const trpc = useTRPC();
  return useQuery(
    trpc.matter.list.queryOptions({
      keyword: keyword.trim() || undefined,
      clientId: clientId || undefined,
      limit: 50,
    }),
  );
}
