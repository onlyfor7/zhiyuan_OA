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

export function useAiUsageAdmin(enabled = true) {
  const trpc = useTRPC();
  return useQuery(trpc.ai.usageAdmin.queryOptions({ limit: 50 }, { enabled }));
}
