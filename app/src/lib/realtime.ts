import { queryClient } from "./trpc";

/**
 * §20.3 通知实时化：/events SSE 订阅（会话 cookie 同源，CSP connect-src 'self' 已放行）。
 * - 事件到达 → 失效通知/待办/驾驶舱/小元 feed 查询 + window「lexflow:sse」广播（小元气泡秒级弹）；
 * - 断线自动回退 60s 轮询兜底（服务端数据为准，不重丢），SSE 恢复即停轮询；
 * - 每 60s 尝试重连 SSE（多页签共享单连接——模块级单例）。
 */

type RealtimeListener = (type: string) => void;

const SSE_URL = "/events";
const POLL_MS = 60_000;

let es: EventSource | null = null;
let pollTimer: number | null = null;
let retryTimer: number | null = null;
let started = false;

/** 事件 → 失效域：通知中心/未读角标/工作台/驾驶舱待办计数/小元 feed */
function invalidateRealtime() {
  void queryClient.invalidateQueries({
    predicate: (q) => /notification|todo|dashboard|assistant|workbench/.test(JSON.stringify(q.queryKey)),
  });
}

function broadcast(type: string) {
  invalidateRealtime();
  window.dispatchEvent(new CustomEvent<string>("lexflow:sse", { detail: type }));
}

function stopPolling() {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(() => broadcast("poll.tick"), POLL_MS);
}

function connect() {
  if (es) return;
  let source: EventSource;
  try {
    source = new EventSource(SSE_URL);
  } catch {
    startPolling();
    return;
  }
  es = source;
  source.onopen = () => stopPolling();
  // 服务端发命名事件（event: 字段）——onmessage 只收无名事件，必须按事件名注册
  const handle = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { type?: string };
      broadcast(data.type ?? "unknown");
    } catch {
      /* 心跳注释行/非 JSON 忽略 */
    }
  };
  for (const type of ["notification.created", "approval.todo", "assistant.feed"] as const) {
    source.addEventListener(type, handle as EventListener);
  }
  source.onerror = () => {
    source.close();
    if (es === source) es = null;
    startPolling(); // 断线回退轮询（数据驱动，不重丢）
  };
}

/** 壳层挂载即启动（模块单例，幂等） */
export function startRealtime() {
  if (started || typeof window === "undefined") return;
  started = true;
  connect();
  if (retryTimer !== null) window.clearInterval(retryTimer);
  retryTimer = window.setInterval(() => {
    if (!es) connect();
  }, POLL_MS);
}

/** 订阅 SSE/轮询广播（小元气泡即时弹等） */
export function onRealtimeEvent(listener: RealtimeListener): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<string>).detail);
  window.addEventListener("lexflow:sse", handler);
  return () => window.removeEventListener("lexflow:sse", handler);
}

/** 走查探针用：连接态自省 */
export function realtimeDebug() {
  return { started, hasEs: !!es, polling: pollTimer !== null };
}
