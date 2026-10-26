import { auditEvents } from "../../db/schema";
import type { DbOrTx } from "../../trpc/context";

export type AuditResult = "success" | "failure";

export interface AuditEntry {
  actorId: string | null;
  sessionId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  result: AuditResult;
  beforeJson?: Record<string, unknown> | null;
  afterJson?: Record<string, unknown> | null;
  ip: string | null;
}

/**
 * 审计写入（arch/02 §7）。调用方传入 DbOrTx：
 * 业务变更场景传事务句柄，与业务写同事务提交；敏感读取传连接池即可。
 * audit_events 只追加（arch/00 §3.9），本服务不提供 update/delete。
 */
export async function recordAudit(db: DbOrTx, entry: AuditEntry): Promise<void> {
  await db.insert(auditEvents).values({
    actorId: entry.actorId,
    sessionId: entry.sessionId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    result: entry.result,
    beforeJson: entry.beforeJson ?? null,
    afterJson: entry.afterJson ?? null,
    ip: entry.ip,
  });
}
