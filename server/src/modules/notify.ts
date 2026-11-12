import { and, eq, isNull } from "drizzle-orm";

import type { NotificationEventType } from "@lexflow/shared";

import { notifications } from "../db/schema";
import { emitEvent } from "../lib/events";
import type { DbOrTx } from "../trpc/context";

/**
 * 通知写入（arch/04 §6）。
 * 聚合键 = event_type + source_id + 日（aggregate_key 列，STATUS 留坑：无唯一索引，
 * 同事务内 select-then-insert 防重；跨请求并发极端情况可能双行，架构裁定后可加唯一索引收紧）。
 * 通知一律带 source_type/source_id 供前端直达处理页。
 */

function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface NotifyInput {
  eventType: NotificationEventType;
  recipientId: string;
  /** notifications.source_type 为 text 无枚举约束；冻结 SourceType 之外的新来源（generic_request 等）亦可入 */
  sourceType: string;
  sourceId: string;
  payload?: Record<string, unknown>;
  /** 覆写聚合键（默认 event:sourceId:日；「只提醒一次」类事件用 sourceId:once） */
  aggregateKey?: string;
}

/** 事件写入（聚合防重：部分唯一索引 (recipient_id, aggregate_key)，ON CONFLICT DO NOTHING） */
export async function notify(db: DbOrTx, input: NotifyInput): Promise<void> {
  const aggregateKey = input.aggregateKey ?? `${input.eventType}:${input.sourceId}:${dayKey()}`;
  await db
    .insert(notifications)
    .values({
      recipientId: input.recipientId,
      eventType: input.eventType,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      payloadJson: input.payload ?? null,
      aggregateKey,
    })
    .onConflictDoNothing();
  // SSE 实时化（arch/12 §20.3）：新通知事件（防重冲突未插入也发——事件为「提醒级」，前端以轮询兜底校准）
  emitEvent({
    type: "notification.created",
    userId: input.recipientId,
    eventType: input.eventType,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
  });
}

/** 业务动作完成后同步 handled（不靠用户手动已读替代处理，arch/04 §6） */
export async function markHandledFor(
  db: DbOrTx,
  recipientId: string,
  sourceType: string,
  sourceId: string,
): Promise<void> {
  await db
    .update(notifications)
    .set({ handledAt: new Date().toISOString() })
    .where(
      and(
        eq(notifications.recipientId, recipientId),
        eq(notifications.sourceType, sourceType),
        eq(notifications.sourceId, sourceId),
        isNull(notifications.handledAt),
      ),
    );
}
