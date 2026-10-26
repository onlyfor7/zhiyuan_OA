import { QueryClient } from "@tanstack/react-query";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

import type { AppRouter } from "@lexflow/server";

/**
 * 前端数据层唯一入口（arch/02 §8）。
 * 业务组件只允许使用 src/api/ 下的 hooks，不直接 fetch。
 * tRPC v11 + TanStack Query：queryOptions / infiniteQueryOptions / mutationOptions。
 */
export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;

export type MeOutput = RouterOutputs["auth"]["me"];
export type ProjectSummary = RouterOutputs["project"]["list"]["items"][number];
export type ProjectDetail = RouterOutputs["project"]["getById"];
type ListInput = Exclude<NonNullable<RouterInputs["project"]["list"]>, void>;
export type ProjectListFilters = NonNullable<ListInput["filters"]>;

export const queryClient = new QueryClient({
  defaultOptions: {
    // 认证/无权限错误立即呈现（跳登录、403/404 同形），不做无谓重试；
    // 瞬时网络错误由页面错误态提供手动重试。
    queries: { retry: false },
  },
});

export const trpcClient = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: "/trpc" })],
});

interface ErrorData {
  businessCode?: string;
  requestId?: string;
  fieldErrors?: Record<string, string[]>;
}

/**
 * 统一错误分流（arch/02 §6）：按 data.businessCode 取业务错误码。
 * AUTH_REQUIRED → 跳登录（保留回跳地址）；ACCESS_DENIED_OR_GONE → 403/404 同形页。
 */
export function businessCodeOf(error: unknown): string | null {
  if (error instanceof TRPCClientError) {
    const data = error.data as ErrorData | undefined;
    return data?.businessCode ?? null;
  }
  return null;
}

export function isAuthRequired(error: unknown): boolean {
  return businessCodeOf(error) === "AUTH_REQUIRED";
}

export function isAccessDeniedOrGone(error: unknown): boolean {
  return businessCodeOf(error) === "ACCESS_DENIED_OR_GONE";
}

export function fieldErrorsOf(error: unknown): Record<string, string[]> | undefined {
  if (error instanceof TRPCClientError) {
    const data = error.data as ErrorData | undefined;
    return data?.fieldErrors;
  }
  return undefined;
}

/** tRPC 响应中的统一展示时间（Asia/Shanghai，arch/00 §3.3） */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
