import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 进程内事件总线（arch/12 §20.3 通知实时化）：业务写同事务后发事件——
 * authedMutation 经 transactionMiddleware 在事务**提交成功后** flush（ALS 请求级缓冲），
 * 回滚则整批丢弃；不经 tRPC 事务的直调 service 退化为立即发布。
 * 事件类型：新通知 / 审批待办 / 小元新提醒（feed 条目变更）。
 *
 * 【多实例留坑】当前形态=单进程内 Map 扇出，仅本进程 SSE 连接可收事件；
 * 未来多实例部署时此处换 PG LISTEN/NOTIFY（事件随事务 COMMIT 广播，缓冲/flush 语义不变），
 * 订阅侧 /events 无需改动。
 */

export type BusEvent =
  | { type: "notification.created"; userId: string; eventType: string; sourceType: string; sourceId: string }
  | { type: "approval.todo"; userId: string; instanceId: string; code: string; bizType: string }
  | { type: "assistant.feed"; userId: string; reason: string };

export type BusListener = (event: BusEvent) => void;

/** userId → 监听者集合（SSE 连接订阅） */
const listeners = new Map<string, Set<BusListener>>();

/** 请求级事件缓冲（transactionMiddleware 的 db.transaction 作用域内有效） */
const pendingBuffer = new AsyncLocalStorage<BusEvent[]>();

export function subscribeEvents(userId: string, listener: BusListener): () => void {
  let set = listeners.get(userId);
  if (!set) {
    set = new Set();
    listeners.set(userId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(userId);
  };
}

function publishNow(event: BusEvent): void {
  const set = listeners.get(event.userId);
  if (!set) return;
  for (const listener of set) {
    try {
      listener(event);
    } catch {
      // 监听者（SSE 写）故障不拖垮业务写
    }
  }
}

/** 业务统一出口：缓冲存在（tRPC 事务内）入缓冲待提交后 flush，否则立即发布 */
export function emitEvent(event: BusEvent): void {
  const buffer = pendingBuffer.getStore();
  if (buffer) buffer.push(event);
  else publishNow(event);
}

/** transactionMiddleware 专用：事务提交成功后真发布；调用前须确认事务已 COMMIT */
export function flushEvents(events: BusEvent[]): void {
  for (const event of events) publishNow(event);
}

/** transactionMiddleware 专用：fn 执行期间 emitEvent 入缓冲；await fn 完成后返回结果与缓冲（fn 抛错=回滚，缓冲随栈丢弃） */
export async function runWithEventBuffer<T>(fn: () => Promise<T>): Promise<{ result: T; events: BusEvent[] }> {
  const events: BusEvent[] = [];
  const result = await pendingBuffer.run(events, fn);
  return { result, events };
}
