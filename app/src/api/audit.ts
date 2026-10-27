import { useQuery } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

export interface AuditFilters {
  actorId?: string;
  action?: string;
  targetType?: string;
  from?: string;
  to?: string;
}

/** 审计查阅 hooks（arch/04 §5 audit.list；需 audit.read 授权，未授权同形 404 由边界处理） */
export function useAuditList(filters: AuditFilters) {
  const trpc = useTRPC();
  return useQuery(
    trpc.audit.list.queryOptions({
      limit: 50,
      actorId: filters.actorId || undefined,
      action: filters.action || undefined,
      targetType: filters.targetType || undefined,
      from: filters.from || undefined,
      to: filters.to || undefined,
    }),
  );
}
