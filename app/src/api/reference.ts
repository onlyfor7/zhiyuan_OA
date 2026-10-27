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

/** 用户 id→名称 映射（展示层用；参照端点 limit 100 覆盖种子/中小规模团队） */
export function useUserNameMap(): Map<string, string> {
  const trpc = useTRPC();
  const query = useQuery(trpc.user.list.queryOptions({ limit: 100 }));
  return new Map((query.data?.items ?? []).map((u) => [u.id, u.name]));
}

/** 金额展示：整数分 → 元字符串（展示层换算，输入侧 parseYuanToCents） */
export function formatYuan(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 元字符串 → 整数分（四舍五入到分；非法返回 null） */
export function parseYuanToCents(v: string): number | null {
  const n = Number(v);
  if (!v.trim() || Number.isNaN(n) || n < 0) return null;
  return Math.round(n * 100);
}
