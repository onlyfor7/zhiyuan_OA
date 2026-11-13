import { useMutation, useQuery, useQueryClient, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 报表中心 hooks（arch/12 §8/§11：report.read/export=登录全员；行级域口径在 service 层） */

export interface ReportFilterInput {
  from?: string;
  to?: string;
  projectId?: string;
  customerId?: string;
  orgUnitId?: string;
  view?: "person" | "project" | "department";
}

export interface ReportData {
  /** align 可选（18-02c 起）：数值列右对齐口径 */
  columns: Array<{ key: string; label: string; align?: "right" | "left" }>;
  rows: Array<Record<string, unknown>>;
  summaryCards: Array<{ key: string; label: string; value: number | string }>;
}

export type ReportKey =
  | "project_health"
  | "project_delay"
  | "project_costing"
  | "receivable_aging"
  | "expense_category"
  | "monthly_cashflow"
  | "time_summary"
  | "utilization"
  | "opportunity_funnel"
  | "customer_contribution";

/** 报表 key（snake，导出/路由用）→ tRPC 过程名（camel） */
const PROC_BY_KEY: Record<ReportKey, string> = {
  project_health: "projectHealth",
  project_delay: "projectDelay",
  project_costing: "projectCosting",
  receivable_aging: "receivableAging",
  expense_category: "expenseCategory",
  monthly_cashflow: "monthlyCashflow",
  time_summary: "timeSummary",
  utilization: "utilization",
  opportunity_funnel: "opportunityFunnel",
  customer_contribution: "customerContribution",
};

/**
 * 十张一期报表统一 {columns,rows,summaryCards}（reports.* 复数路由，区别于治理 report.* 周报域）。
 * 各过程入参同一 filter 形状，运行时按 key 分发；类型收窄到公共骨架形状。
 */
export function useReport(key: ReportKey, input: ReportFilterInput): UseQueryResult<ReportData, Error> {
  const trpc = useTRPC();
  const procs = trpc.reports as unknown as Record<string, { queryOptions: (i: ReportFilterInput) => UseQueryOptions<ReportData, Error> }>;
  return useQuery(procs[PROC_BY_KEY[key]].queryOptions(input));
}

/** 导出 CSV：服务端生成 file_objects(source=report)+HMAC 下载令牌+审计同事务；返回 downloadPath 直链 */
export function useReportExport() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.reports.exportCsv.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries(trpc.audit.pathFilter());
      },
    }),
  );
}
