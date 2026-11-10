import { useMutation } from "@tanstack/react-query";

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
