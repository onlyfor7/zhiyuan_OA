import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { Send, X } from "lucide-react";
import { toast } from "sonner";

import { useAiChat, useAssistantFeed } from "../../api/ai";
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
import { DomainIconBlock } from "../../lib/DomainIconBlock";

/**
 * AI 宠物「小元」（arch/12 §19.1 修订 §17.1/17.2/18.2）：圆球状俏皮宠物
 * （大眼表情随场景切换：眨眼常态/开心开面板/思考生成中/忙碌拖拽中）；
 * 点击宠物**直进对话面板**（无中间气泡层；招呼气泡仅闲置巡检出现，点气泡=开面板）；
 * 悬浮可拖拽/贴边停靠/位置记忆沿用；375 仅悬浮钮；动作只产草稿/预填由用户确认。
 * §19.3 主动提醒：有提醒条目时头顶红点计数（localStorage 抑制后即时扣减），
 * 面板首屏「今日提醒」卡列表直跳处理页。
 */

interface ChatItem extends AiChatMessage {
  actions?: AiChatAction[];
  capability?: string;
  provider?: string;
}

type Mood = "normal" | "happy" | "thinking" | "busy";
type AiChatMutation = ReturnType<typeof useAiChat>;
type FeedItem = NonNullable<ReturnType<typeof useAssistantFeed>["data"]>["items"][number];

const CAP_LABEL: Record<string, string> = {
  form_prefill: "A1 表单预填",
  time_draft: "A2 工时草稿",
  minutes_draft: "A3 纪要草稿",
  flow_draft: "A4 审批流 DSL 草稿",
  answer: "A5 只读问答",
};

/** §19.1 圆球小宠物：圆润生物体+大眼；四态表情（normal/happy/thinking/busy）CSS 过渡切换 */
function PetSvg({ mood }: { mood: Mood }) {
  return (
    <svg className={`ai-pet-svg ai-mood-${mood}`} viewBox="0 0 48 48" width="34" height="34" aria-hidden="true">
      <defs>
        <radialGradient id="ai-ball-grad" cx="38%" cy="30%" r="80%">
          <stop offset="0%" stopColor="#a78bfa" />
          <stop offset="100%" stopColor="#6d28d9" />
        </radialGradient>
      </defs>
      {/* 圆润生物体 */}
      <circle cx="24" cy="26" r="16" fill="url(#ai-ball-grad)" />
      <ellipse cx="24" cy="31" rx="9.5" ry="6.5" fill="#c4b5fd" opacity=".45" />
      <ellipse cx="15.5" cy="28.5" rx="2.6" ry="1.6" fill="#f0abfc" opacity=".55" />
      <ellipse cx="32.5" cy="28.5" rx="2.6" ry="1.6" fill="#f0abfc" opacity=".55" />

      {/* 常态：大眼+眨眼 */}
      <g className="ai-face ai-face-normal">
        <g className="ai-eyes">
          <circle cx="19" cy="24.5" r="4.6" fill="#fff" />
          <circle cx="29" cy="24.5" r="4.6" fill="#fff" />
          <circle cx="19.6" cy="25" r="2.1" fill="#1f2937" />
          <circle cx="29.6" cy="25" r="2.1" fill="#1f2937" />
          <circle cx="18.6" cy="23.6" r=".8" fill="#fff" />
          <circle cx="28.6" cy="23.6" r=".8" fill="#fff" />
        </g>
        <path d="M21.2 31.2 q2.8 2.4 5.6 0" stroke="#fff" strokeWidth="1.7" fill="none" strokeLinecap="round" />
      </g>

      {/* 开心：笑眯眯+张嘴（开面板） */}
      <g className="ai-face ai-face-happy">
        <path d="M15.4 25.2 q3.4 -3.8 6.8 0" stroke="#fff" strokeWidth="1.9" fill="none" strokeLinecap="round" />
        <path d="M25.8 25.2 q3.4 -3.8 6.8 0" stroke="#fff" strokeWidth="1.9" fill="none" strokeLinecap="round" />
        <path d="M20.6 30.6 q3.4 3.8 6.8 0 q-1 3.4 -3.4 3.4 q-2.4 0 -3.4 -3.4 z" fill="#fff" />
      </g>

      {/* 思考：眼珠上瞟+挑眉（生成中） */}
      <g className="ai-face ai-face-thinking">
        <circle cx="19" cy="24.5" r="4.6" fill="#fff" />
        <circle cx="29" cy="24.5" r="4.6" fill="#fff" />
        <circle cx="20" cy="22.6" r="2.1" fill="#1f2937" />
        <circle cx="30" cy="22.6" r="2.1" fill="#1f2937" />
        <path d="M26 18.4 q3 -1.6 6 .4" stroke="#f5d0fe" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        <path d="M21.5 31.6 h5" stroke="#fff" strokeWidth="1.7" fill="none" strokeLinecap="round" />
      </g>

      {/* 忙碌：>< 眼+咬唇（拖拽中） */}
      <g className="ai-face ai-face-busy">
        <path d="M15.6 21.8 l5.6 5.4 M21.2 21.8 l-5.6 5.4" stroke="#fff" strokeWidth="1.9" fill="none" strokeLinecap="round" />
        <path d="M25.8 21.8 l5.6 5.4 M31.4 21.8 l-5.6 5.4" stroke="#fff" strokeWidth="1.9" fill="none" strokeLinecap="round" />
        <path d="M20.4 31.4 q1.5 -1.8 3 0 q1.5 1.8 3 0 q1.5 -1.8 3 0" stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      </g>

      {/* 俏皮点缀：星星魔法棒闪动 */}
      <path className="ai-wave-star" d="M38.5 10.5 l1.6 3.6 3.6 1.6 -3.6 1.6 -1.6 3.6 -1.6 -3.6 -3.6 -1.6 3.6 -1.6 z" fill="#e9d5ff" />
      <circle className="ai-spark" cx="9.5" cy="13" r="1.7" fill="#e9d5ff" opacity=".85" />
    </svg>
  );
}

const POS_KEY = "lexflow-ai-pet-pos";
/** §19.3 「不再提醒本条」抑制集：type|link 稳定键（link 内含对象 id），localStorage 持久 */
const FEED_SUPPRESS_KEY = "lexflow-ai-feed-suppressed";
const feedKey = (it: Pick<FeedItem, "type" | "link">) => `${it.type}|${it.link}`;

function readSuppressed(): string[] {
  try {
    const raw = localStorage.getItem(FEED_SUPPRESS_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const IDLE_TIPS = [
  "闲置好一会儿了——有表单要填/工时要记吗？我帮你起草。",
  "试试对我说「帮我填去杭州出差两天的高铁申请」。",
  "我在右下角待命：预填 / 工时 / 纪要 / 审批流都能起草。",
  "又是忙碌的一天，喝口水再继续吧。",
];

interface PetPos { x: number; y: number }

let mobileCache: boolean | null = null;
function isMobileView(): boolean {
  if (mobileCache === null) mobileCache = window.matchMedia("(max-width: 820px)").matches;
  return mobileCache;
}

/** §19.1/§18.2 桌面宠物：圆球形象四态表情；点击直进面板；可拖拽（位置记忆）+贴边停靠；闲置巡检气泡；375 仅悬浮钮 */
export function AiPet() {
  const chat = useAiChat();
  const feed = useAssistantFeed();
  const [open, setOpen] = useState(false);
  const [bubble, setBubble] = useState<{ kind: "tip"; text: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [suppressed, setSuppressed] = useState<string[]>(() => readSuppressed());
  const [pos, setPos] = useState<PetPos | null>(() => {
    try {
      const raw = localStorage.getItem(POS_KEY);
      return raw ? (JSON.parse(raw) as PetPos) : null;
    } catch {
      return null;
    }
  });
  const drag = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  const lastActive = useRef(0);
  useEffect(() => {
    lastActive.current = Date.now();
  }, []);

  const poke = useCallback(() => {
    lastActive.current = Date.now();
  }, []);

  // §19.1 表情随场景：拖拽=忙碌 / 生成中=思考 / 面板开=开心 / 常态眨眼
  const mood: Mood = dragging ? "busy" : chat.isPending ? "thinking" : open ? "happy" : "normal";

  // §19.3 抑制后的可见提醒（红点计数与列表共用口径）
  const feedItems = feed.data?.items ?? [];
  const visibleItems = feedItems.filter((it) => !suppressed.includes(feedKey(it)));
  const visibleCount = visibleItems.length;

  const suppressItem = useCallback((it: FeedItem) => {
    setSuppressed((prev) => {
      const next = prev.includes(feedKey(it)) ? prev : [...prev, feedKey(it)];
      try {
        localStorage.setItem(FEED_SUPPRESS_KEY, JSON.stringify(next));
      } catch {
        /* 存储不可用时仅本次会话生效 */
      }
      return next;
    });
  }, []);

  // 闲置提示：≥3 分钟无互动且未开面板/气泡时弹一次（30s 巡检）——招呼气泡仅此处出现
  useEffect(() => {
    const t = window.setInterval(() => {
      if (!open && !bubble && Date.now() - lastActive.current >= 3 * 60_000) {
        setBubble({ kind: "tip", text: IDLE_TIPS[Math.floor(Math.random() * IDLE_TIPS.length)] });
        lastActive.current = Date.now();
      }
    }, 30_000);
    return () => window.clearInterval(t);
  }, [open, bubble]);

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    poke();
    if (isMobileView() || open) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag.current) return;
    if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2) {
      drag.current.moved = true;
      setDragging(true);
    }
    const x = Math.min(window.innerWidth - 64, Math.max(8, e.clientX - drag.current.dx));
    const y = Math.min(window.innerHeight - 78, Math.max(8, e.clientY - drag.current.dy));
    setPos({ x, y });
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    setDragging(false);
    // 贴边停靠：距左/右缘 <48px 吸附（避让内容居中漂移）
    setPos((p) => {
      if (!p) return p;
      const snapped: PetPos =
        p.x < 48 ? { ...p, x: 12 } : p.x > window.innerWidth - 112 ? { ...p, x: window.innerWidth - 68 } : p;
      localStorage.setItem(POS_KEY, JSON.stringify(snapped));
      return snapped;
    });
    window.setTimeout(() => {
      drag.current = null;
    }, 0);
  };

  /** §19.1 直进：点击宠物直接开/关对话面板（无中间气泡层） */
  const onClick = () => {
    poke();
    if (drag.current?.moved) return;
    setBubble(null);
    setOpen((v) => !v);
  };

  const style: CSSProperties | undefined = pos
    ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" }
    : undefined;

  return (
    <>
      <button
        type="button"
        className={`ai-fab ${open ? "active" : ""} ${pos ? "docked" : ""} ${dragging ? "dragging" : ""}`}
        style={style}
        aria-label={open ? "收起小元" : "小元 AI 助手"}
        aria-expanded={open}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={onClick}
      >
        <span className="ai-ball"><PetSvg mood={mood} /></span>
        <span className="ai-fab-name">小元</span>
        {!open && visibleCount > 0 ? (
          <span className="ai-badge" aria-label={`${visibleCount} 条待提醒`}>{visibleCount > 99 ? "99+" : visibleCount}</span>
        ) : null}
      </button>
      {bubble && !open ? (
        <div
          className="ai-bubble-pop"
          style={pos ? { left: Math.max(8, Math.min(window.innerWidth - 260, pos.x - 190)), top: Math.max(8, pos.y - 108) } : undefined}
          role="button"
          tabIndex={0}
          aria-label="打开小元对话"
          onClick={() => { poke(); setBubble(null); setOpen(true); }}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); poke(); setBubble(null); setOpen(true); } }}
        >
          <p>{bubble.text}</p>
          <small className="bubble-hint">点击直接对话 →</small>
        </div>
      ) : null}
      {open ? (
        <AiPanel
          chat={chat}
          feedItems={visibleItems}
          feedPending={feed.isPending}
          onSuppress={suppressItem}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}


function AiPanel({
  chat,
  feedItems,
  feedPending,
  onSuppress,
  onClose,
}: {
  chat: AiChatMutation;
  feedItems: FeedItem[];
  feedPending: boolean;
  onSuppress: (it: FeedItem) => void;
  onClose: () => void;
}) {
  const location = useLocation();
  const navigate = useNavigate();
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
        <span className="ai-panel-avatar"><PetSvg mood={chat.isPending ? "thinking" : "happy"} /></span>
        <div>
          <strong>小元</strong>
          <small>{lastProvider ? (lastProvider === "mock" ? "MockProvider · 演示模式" : "AI 端点 · 生产模式") : "AI 助手"}</small>
        </div>
        <button type="button" className="icon-button" aria-label="关闭小元面板" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      {/** §19.3 今日提醒卡（置顶）：类型图标+标题+来源+紧急度色；点击直跳处理页；×=不再提醒本条 */}
      <div className="ai-reminders">
        <div className="ai-reminders-head">
          <span className="section-label">今日提醒 · {feedItems.length}</span>
          {feedPending ? <small className="list-note">提醒加载中…</small> : null}
        </div>
        {!feedPending && feedItems.length === 0 ? <p className="ai-remind-empty">今日无待办，喝口水吧</p> : null}
        <div className="ai-remind-list">
          {feedItems.map((it) => (
            <div
              key={feedKey(it)}
              className={`ai-remind-row urgency-${it.urgency}`}
              role="link"
              tabIndex={0}
              title="点击直达处理页"
              onClick={() => {
                onClose();
                navigate(it.link);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onClose();
                  navigate(it.link);
                }
              }}
            >
              <DomainIconBlock domain={it.icon} size={22} iconSize={13} />
              <div className="p9a-queue-main">
                <strong>{it.title}</strong>
                <small>{it.sourceLabel}</small>
              </div>
              <button
                type="button"
                className="icon-button ai-remind-dismiss"
                aria-label="不再提醒本条"
                onClick={(e) => {
                  e.stopPropagation();
                  onSuppress(it);
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
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
