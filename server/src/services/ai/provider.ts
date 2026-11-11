import { z } from "zod";

/**
 * AI 提供方适配层（arch/12 §17.4）：OpenAI-compatible chat completions 封装
 * （POST /chat/completions，env 三键 AI_PROVIDER_URL/AI_API_KEY/AI_MODEL）+
 * 内置 MockProvider（规则解析 NL→预置动作 JSON，dev/test 确定性）；
 * 统一 complete() 出口 {text, actions[]}；缺 key 时 MockProvider 兜底（无 key 全链可用）。
 */

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiContext {
  route: string;
  pageType: string;
  summary: string;
}

export interface AiCompletion {
  text: string;
  actions: unknown[];
  /** 真实提供方 usage 字段；MockProvider 不产出（由调用方按 chars/4 估算，arch/12 §17.6） */
  usage?: { tokensIn: number; tokensOut: number };
}

export interface AiProvider {
  readonly name: "openai" | "mock";
  complete(messages: AiMessage[], ctx: AiContext, actions: unknown[]): Promise<AiCompletion>;
}

const chatMessage = z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() });
export const aiMessagesSchema = z.array(chatMessage).min(1).max(20);

/** env 三键 zod 校验（允许缺省——缺省即 MockProvider） */
const aiEnvSchema = z.object({
  AI_PROVIDER_URL: z.string().url().optional(),
  AI_API_KEY: z.string().min(1).optional(),
  AI_MODEL: z.string().min(1).optional(),
});

export function resolveAiProvider(override?: { providerUrl?: string | null; apiKey?: string | null; model?: string | null }): AiProvider {
  // 读序：调用方传入的统筹配置（system_config 优先于 env）→ 本函数 env 兜底
  const parsed = aiEnvSchema.safeParse({
    AI_PROVIDER_URL: override?.providerUrl ?? process.env.AI_PROVIDER_URL,
    AI_API_KEY: override?.apiKey ?? process.env.AI_API_KEY,
    AI_MODEL: override?.model ?? process.env.AI_MODEL,
  });
  const { AI_PROVIDER_URL, AI_API_KEY, AI_MODEL } = parsed.success ? parsed.data : {};
  if (AI_PROVIDER_URL && AI_API_KEY && AI_MODEL) return new OpenAiProvider(AI_PROVIDER_URL, AI_API_KEY, AI_MODEL);
  return new MockProvider();
}

class OpenAiProvider implements AiProvider {
  readonly name = "openai" as const;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(url: string, apiKey: string, model: string) {
    this.url = url;
    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(messages: AiMessage[], ctx: AiContext, actions: unknown[]): Promise<AiCompletion> {
    const base = this.url.replace(/\/$/, "");
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: [...messages, { role: "system" as const, content: `页面上下文：${ctx.route} ${ctx.pageType}\n摘要：${ctx.summary}` }],
      }),
    });
    if (!response.ok) {
      throw new Error(`AI 提供方错误：${response.status}`);
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    return {
      text,
      actions,
      usage: data.usage
        ? { tokensIn: data.usage.prompt_tokens ?? 0, tokensOut: data.usage.completion_tokens ?? 0 }
        : undefined,
    };
  }
}

/**
 * MockProvider：规则解析 NL→预置动作 JSON（动作本体由 capabilities 产出的确定性回显），
 * text 为规则化说明文案——同输入必同输出（e2e/验收可断言）。
 */
class MockProvider implements AiProvider {
  readonly name = "mock" as const;

  async complete(messages: AiMessage[], ctx: AiContext, actions: unknown[]): Promise<AiCompletion> {
    void messages; // MockProvider 由动作类型确定性回显（NL 规则解析在 capabilities 层完成）
    const action = actions[0] as { type?: string } | undefined;
    const type = action?.type ?? "answer";
    const texts: Record<string, string> = {
      form_prefill: `已解析表单预填值（未落库，请复核后自行提交）：${JSON.stringify((action as { values?: unknown })?.values ?? {})}`,
      time_draft: "已生成工时草稿（未落库，0.5 小时步进校验通过，请在工时中心确认保存）。",
      minutes_draft: "已生成纪要草稿（未落库，请编辑后提交确认）。",
      flow_draft: "已生成审批流草稿（已过编译校验管线，请在设计器中复核后发布）。",
      answer: `我是小元。当前页面 ${ctx.route || "（未知）"}：${ctx.summary.slice(0, 60) || "无摘要"}。可尝试：预填表单 / 记工时 / 生成纪要 / 设计审批流。`,
    };
    return { text: texts[type] ?? texts.answer, actions };
  }
}
