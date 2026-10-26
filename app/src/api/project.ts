import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { useTRPC, type ProjectListFilters } from "../lib/trpc";

/** 项目域 hooks（arch/02 §4：project.list / project.getById） */

export function useProjectList(filters: ProjectListFilters) {
  const trpc = useTRPC();
  return useInfiniteQuery(
    trpc.project.list.infiniteQueryOptions(
      { limit: 10, filters },
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      },
    ),
  );
}

export function useProject(id: string) {
  const trpc = useTRPC();
  return useQuery(trpc.project.getById.queryOptions({ id }));
}

/** 驾驶舱「项目脉搏」预览：同一 project.list 契约，取最近更新的前 6 个 */
export function useProjectPreview() {
  const trpc = useTRPC();
  return useQuery(trpc.project.list.queryOptions({ limit: 6, filters: {} }));
}
