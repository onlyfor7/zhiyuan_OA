import { useQuery } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 驾驶舱聚合 hooks（arch/04 §5 dashboard.summary） */

export function useDashboardSummary() {
  const trpc = useTRPC();
  return useQuery(trpc.dashboard.summary.queryOptions());
}
