import { useQuery } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 全局搜索（arch/07 §5：SQL 级权限过滤先于组装；金额按财务可见权可能缺席） */
export function useSearch(q: string, types?: string[]) {
  const trpc = useTRPC();
  return useQuery(
    trpc.search.query.queryOptions(
      { q: q.trim(), types: types && types.length > 0 ? (types as never) : undefined, limit: 20 },
      { enabled: q.trim().length > 0 },
    ),
  );
}
