import { useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Send, X } from "lucide-react";
import { toast } from "sonner";

import { useAiChat } from "../../api/ai";
import type { AiChatAction, AiChatMessage } from "../../api/ai";
import { collectAiContext, contextPreviewLines } from "./ai-context";
import {
  AI_NOTICE_KEY,
  AI_TIME_DRAFT_KEY,
  applyFormPrefill,
  consumeAiDraft,
  stageFlowDraft,
  stageMinutesDraft,
  stageTimeDraft,
  type AiTimeDraftEntry,
} from "./ai-actions";

/**
 * AI 宠物「小元」（arch/12 §17.1/17.2）：右下悬浮入口（呼吸微动效）→ 380px 侧边对话面板
 * （对话流 + 页签式「本次将发送的上下文」预览）；375 全屏抽屉；动作只产草稿/预填由用户确认；
 * 首次使用数据出域告知一次（MockProvider 不弹）。
 */

interface ChatItem extends AiChatMessage {
  actions?: AiChatAction[];
  capability?: string;
  provider?: string;
}

const CAP_LABEL: Record<string, string> = {
  form_prefill: "A1 表单预填",
  time_draft: "A2 工时草稿",
  minutes_draft: "A3 纪要草稿",
  flow_draft: "A4 审批流 DSL 草稿",
  answer: "A5 只读问答",
};

function PetSvg() {
  return (
    <svg viewBox="0 0 48 48" width="30" height="30" aria-hidden="true">
      <ellipse cx="24" cy="27" rx="15" ry="13" fill="#7c3aed" />
      <ellipse cx="24" cy="30" rx="9" ry="7" fill="#a78bfa" opacity=".55" />
      <circle cx="19" cy="25" r="2.2" fill="#fff" />
      <circle cx="29" cy="25" r="2.2" fill="#fff" />
      <circle cx="19.5" cy="25.4" r="1" fill="#1f2937" />
      <circle cx="29.5" cy="25.4" r="1" fill="#1f2937" />
      <path d="M20 31 Q24 34 28 31" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <path d="M35 12 l1.8 4 4 1.8 -4 1.8 -1.8 4 -1.8 -4 -4 -1.8 4 -1.8 z" fill="#c4b5fd" />
      <circle cx="12" cy="15" r="2" fill="#c4b5fd" opacity=".8" />
    </svg>
  );
}

export function AiPet() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={`ai-fab ${open ? "active" : ""}`}
        aria-label={open ? "收起小元" : "小元 AI 助手"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <PetSvg />
        <span className="ai-fab-name">小元</span>
      </button>
      {open ? <AiPanel onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function AiPanel({ onClose }: { onClose: () => void }) {
  const location = useLocation();
  const navigate = useNavigate();
  const chat = useAiChat();
  const [tab, setTab] = useState<"chat" | "context">("chat");
  const [input, setInput] = useState("");
  const [items, setItems] = useState<ChatItem[]>([
    { role: "assistant", content: "你好，我是小元 ✨ 可以帮你预填表单、起草工时/纪要、生成审批流草稿，或回答平台使用问题。写操作我只生成草稿，由你确认后提交。" },
  ]);
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [lastProvider, setLastProvider] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const ctx = useMemo(() => collectAiContext(location.pathname), [location.pathname]);
  const ctxLines = useMemo(() => contextPreviewLines(ctx), [ctx]);

  const maybeNotice = (provider: string) => {
    setLastProvider(provider);
    if (provider !== "mock" && !localStorage.getItem(AI_NOTICE_KEY)) {
      localStorage.setItem(AI_NOTICE_KEY, "1");
      setNoticeOpen(true);
    }
  };

  const send = () => {
    const content = input.trim();
    if (!content || chat.isPending) return;
    const nextMessages: AiChatMessage[] = [...items.map((m): AiChatMessage => ({ role: m.role, content: m.content })), { role: "user" as const, content }].slice(-20);
    setItems((prev) => [...prev, { role: "user", content }]);
    setInput("");
    chat.mutate(
      { messages: nextMessages, context: ctx },
      {
        onSuccess: (r) => {
          setItems((prev) => [...prev, { role: "assistant", content: r.text, actions: r.actions as AiChatAction[] | undefined, capability: r.capability, provider: r.provider }]);
          maybeNotice(r.provider);
          setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }), 60);
        },
        onError: (err) => toast.error("小元没听清", { description: String(err).slice(0, 120) }),
      },
    );
    setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }), 60);
  };

  const runAction = (a: AiChatAction) => {
    if (a.type === "form_prefill") {
      const r = applyFormPrefill((a.values as Record<string, unknown>) ?? {});
      if (r.applied.length > 0) toast.success("已回填当前表单", { description: `字段：${r.applied.join("、")}——请复核后自行提交。` });
      else toast.warning("未找到可回填的打开表单", { description: "请先打开目标表单弹窗，再让小元回填。" });
      return;
    }
    if (a.type === "time_draft") {
      const entries = consumeAiDraft<AiTimeDraftEntry[]>(AI_TIME_DRAFT_KEY) ?? (a.entries as AiTimeDraftEntry[]);
      stageTimeDraft(entries ?? [], navigate);
      return;
    }
    if (a.type === "minutes_draft") {
      const m = location.pathname.match(/^\/meetings\/([^/]+)/);
      if (!m) {
        toast.warning("请先打开目标会议详情", { description: "进入会议详情页后再应用纪要草稿。" });
        return;
      }
      stageMinutesDraft(String(a.draft ?? ""), m[1], navigate);
      return;
    }
    if (a.type === "flow_draft") {
      stageFlowDraft(a.definitionJson, String(a.description ?? ""), navigate);
      return;
    }
  };

  return (
    <aside className="ai-panel" role="dialog" aria-modal="false" aria-label="小元 AI 助手面板">
      <div className="ai-panel-head">
        <span className="ai-panel-avatar"><PetSvg /></span>
        <div>
          <strong>小元</strong>
          <small>{lastProvider ? (lastProvider === "mock" ? "MockProvider · 演示模式" : "AI 端点 · 生产模式") : "AI 助手"}</small>
        </div>
        <button type="button" className="icon-button" aria-label="关闭小元面板" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="p9a-wizard-tabs ai-panel-tabs" role="tablist" aria-label="面板页签">
        <button role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>对话</button>
        <button role="tab" aria-selected={tab === "context"} className={tab === "context" ? "active" : ""} onClick={() => setTab("context")}>本次将发送的上下文</button>
      </div>

      {tab === "context" ? (
        <div className="ai-context-card">
          <span className="section-label">CONTEXT · §17.4 白名单（密级不采）</span>
          <dl>
            {ctxLines.map(([k, v]) => (
              <div key={k + v}><dt>{k}</dt><dd>{v || "—"}</dd></div>
            ))}
          </dl>
          <p className="context-note">每次发送随消息一并提交；摘要经服务端密级/口令剥离并哈希入审计，原文不出审计。</p>
        </div>
      ) : (
        <div className="ai-chat-flow" ref={scrollRef}>
          {items.map((m, i) => (
            <div className={`ai-msg ${m.role}`} key={i}>
              <div className="ai-bubble">
                {m.content}
                {m.actions && m.actions.length > 0 ? (
                  <div className="ai-actions">
                    {m.actions.map((a, j) => (
                      <div className="ai-action-card" key={j}>
                        <span className="section-label">{CAP_LABEL[a.type] ?? a.type}</span>
                        {a.type === "flow_draft" ? <small className="mono">{(a.description as string) ?? ""}</small> : null}
                        {a.type === "time_draft" ? <small>{(a.entries as AiTimeDraftEntry[])?.map((e) => `${e.projectName} · ${e.workDate} · ${e.hours}h`).join("；")}</small> : null}
                        <button type="button" className="primary-action" onClick={() => runAction(a)}>
                          {a.type === "form_prefill" ? "回填当前表单" : a.type === "time_draft" ? "去工时中心应用" : a.type === "minutes_draft" ? "预填纪要编辑器" : a.type === "flow_draft" ? "打开设计器预填" : "知道了"}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          {chat.isPending ? <p className="list-note ai-thinking">小元思考中…</p> : null}
        </div>
      )}

      <div className="ai-input-row">
        <input
          value={input}
          placeholder="例如：帮我填去杭州出差两天的高铁申请"
          aria-label="对小元说"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
        />
        <button type="button" className="primary-action" aria-label="发送" disabled={!input.trim() || chat.isPending} onClick={send}>
          <Send size={15} />
        </button>
      </div>

      {noticeOpen ? (
        <div className="overlay centered" onMouseDown={(e) => e.target === e.currentTarget && setNoticeOpen(false)}>
          <section className="decision-modal compact-modal" role="dialog" aria-modal="true" aria-label="数据出域告知">
            <div className="drawer-head">
              <div>
                <span className="section-label">NOTICE · 数据出域告知</span>
                <h2>即将使用 AI 服务</h2>
              </div>
              <button className="icon-button" aria-label="关闭" onClick={() => setNoticeOpen(false)}><X size={16} /></button>
            </div>
            <p className="context-note">
              当前使用外部 AI 端点。每次对话将发送：当前路由、页面类型与脱敏页面摘要（白名单，密级/口令类不采集）。
              写操作仅生成草稿，经你确认后才写入平台；全部对话经审计留痕。此告知仅首次显示。
            </p>
            <div className="drawer-actions">
              <button className="primary-action full-action" onClick={() => setNoticeOpen(false)}>我已知晓</button>
            </div>
          </section>
        </div>
      ) : null}
    </aside>
  );
}
