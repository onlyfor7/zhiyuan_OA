import { and, eq, isNull } from "drizzle-orm";

import type { NotificationEventType, SourceType } from "@lexflow/shared";

import { notifications } from "../db/schema";
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
  sourceType: SourceType;
  sourceId: string;
  payload?: Record<string, unknown>;
}

/** 事件写入（聚合防重；须在业务事务内调用，与业务写同事务） */
export async function notify(db: DbOrTx, input: NotifyInput): Promise<void> {
  const aggregateKey = `${input.eventType}:${input.sourceId}:${dayKey()}`;
  const existing = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.recipientId, input.recipientId),
        eq(notifications.aggregateKey, aggregateKey),
      ),
    )
    .limit(1);
  if (existing[0]) return;

  await db.insert(notifications).values({
    recipientId: input.recipientId,
    eventType: input.eventType,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    payloadJson: input.payload ?? null,
    aggregateKey,
  });
}

/** 业务动作完成后同步 handled（不靠用户手动已读替代处理，arch/04 §6） */
export async function markHandledFor(
  db: DbOrTx,
  recipientId: string,
  sourceType: SourceType,
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
