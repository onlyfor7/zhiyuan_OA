import { useState } from "react";
import {} from "lucide-react";

import { useAuditList, type AuditFilters } from "../api/audit";
import { HelpIcon } from "../components/HelpIcon";
import { isAccessDeniedOrGone } from "../lib/trpc";
import { UserPicker } from "../components/UserPicker";

const TARGET_TYPES = [
  ["", "全部对象"],
  ["project", "项目"],
  ["task", "任务"],
  ["change_request", "延期申请"],
  ["quality_issue", "质量问题"],
  ["decision", "决策"],
  ["weekly_report", "周报"],
  ["file", "文件"],
  ["access_grant", "档案授权"],
  ["user", "用户"],
] as const;

/** 权限审计页：audit.list 真实数据（未授权由边界渲染同形 404） */
export default function AuditPage() {
  const [filters, setFilters] = useState<AuditFilters>({});
  const [draft, setDraft] = useState<AuditFilters>({});
  const audit = useAuditList(filters);

  // 无 audit.read 授权 → 同形 404（arch/03 §5）
  if (audit.isError && isAccessDeniedOrGone(audit.error)) throw audit.error;

  const apply = () => setFilters({ ...draft });

  return (
    <div className="screen audit-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">ACCESS & AUDIT</span>
          <h1 aria-label="看得见权限，也查得到足迹。">
            看得见权限，也查得到足迹。
            <HelpIcon pageKey="audit" />
          </h1>
          <p>关键写入与敏感读取全部留痕；筛选由服务端执行。</p>
        </div>
      </div>
      <div className="quality-toolbar">
        <div className="audit-actor-field">
          <UserPicker
            value={draft.actorId ?? ""}
            onChange={(v) => setDraft((p) => ({ ...p, actorId: v }))}
            placeholder="按操作者筛选"
          />
        </div>
        <div className="inline-search">
          <input
            value={draft.action ?? ""}
            placeholder="按动作筛选，如 task.transition"
            aria-label="动作"
            onChange={(e) => setDraft((p) => ({ ...p, action: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && apply()}
          />
        </div>
        <select
          value={draft.targetType ?? ""}
          aria-label="对象类型"
          onChange={(e) => setDraft((p) => ({ ...p, targetType: e.target.value }))}
        >
          {TARGET_TYPES.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={draft.from ?? ""}
          aria-label="开始日期"
          onChange={(e) => setDraft((p) => ({ ...p, from: e.target.value }))}
        />
        <input
          type="date"
          value={draft.to ?? ""}
          aria-label="结束日期"
          onChange={(e) => setDraft((p) => ({ ...p, to: e.target.value }))}
        />
        <button className="secondary-action" onClick={apply}>
          查询
        </button>
        <span>{audit.isPending ? "加载中…" : `已加载 ${audit.data?.items.length ?? 0} 条`}</span>
      </div>
      {audit.isError ? (
        <div className="error-state inline" role="alert">
          <p>审计日志加载失败或无权限查看。</p>
        </div>
      ) : (
        <div className="log-table">
          <div className="log-head">
            <span>时间</span>
            <span>操作者</span>
            <span>动作</span>
            <span>对象</span>
            <span>结果</span>
          </div>
          {audit.data?.items.length === 0 ? (
            <div className="empty-state">
              <strong>没有匹配的审计记录</strong>
              <p>调整筛选条件后再试。</p>
            </div>
          ) : (
            audit.data?.items.map((row) => (
              <div className="log-row" key={row.id}>
                <time>{row.createdAt.slice(0, 19).replace("T", " ")}</time>
                <span>{row.actorId ? row.actorId.slice(0, 8) : "系统"}</span>
                <span>{row.action}</span>
                <span>
                  {row.targetType ?? "—"}
                  {row.targetId ? ` · ${row.targetId.slice(0, 8)}` : ""}
                </span>
                <span className={row.result === "success" ? "log-success" : "log-denied"}>{row.result}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
