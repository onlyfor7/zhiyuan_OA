import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** AI 助手「小元」（arch/12 §17）：ai.chat——写动作只产草稿/预填，用户确认后走既有端点 */
export interface AiChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AiChatAction {
  type: "form_prefill" | "time_draft" | "minutes_draft" | "flow_draft" | "answer" | string;
  [key: string]: unknown;
}

export interface AiChatResult {
  text: string;
  actions: AiChatAction[];
  capability: string;
  provider: string;
}

export function useAiChat() {
  const trpc = useTRPC();
  return useMutation(trpc.ai.chat.mutationOptions({}));
}

/* ===== §17.6 配置与用量（13-01 后端） ===== */

export interface AiConfigState {
  providerUrl: string;
  model: string;
  enabled: boolean;
  apiKeyMasked: string | null;
  source: string;
}

export function useAiConfig(enabled = true) {
  const trpc = useTRPC();
  return useQuery(trpc.ai.config.get.queryOptions(undefined, { enabled }));
}

export function useAiConfigMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.ai.pathFilter());
  };
  const set = useMutation(trpc.ai.config.set.mutationOptions({ onSuccess: invalidate }));
  const test = useMutation(trpc.ai.config.testConnection.mutationOptions());
  return { set, test };
}

export interface AiUsageRow {
  day: string;
  capability: string;
  calls: number;
  tokens_in: number;
  tokens_out: number;
  user_name?: string;
}

export function useAiMyUsage(enabled = true) {
  const trpc = useTRPC();
  return useQuery(trpc.ai.myUsage.queryOptions({}, { enabled }));
}

/**
 * 小元主动提醒（arch/12 §19.3）：ai.assistant.feed 六类聚合（只读不审计）。
 * 随壳常驻以支撑宠物红点计数：60s 静默轮询，页面不可见时暂停（refetchIntervalInBackground=false）。
 */
export function useAssistantFeed(enabled = true) {
  const trpc = useTRPC();
  return useQuery(
    trpc.ai.assistant.feed.queryOptions(undefined, {
      enabled,
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
    }),
  );
}

export function useAiUsageAdmin(enabled = true) {
  const trpc = useTRPC();
  return useQuery(trpc.ai.usageAdmin.queryOptions({ limit: 50 }, { enabled }));
}
