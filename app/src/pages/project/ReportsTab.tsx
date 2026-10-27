import { useMemo, useState } from "react";
import { Archive, Check, FileText, Plus } from "lucide-react";

import { useReport, useReportList, useReportMutations } from "../../api/report";
import { newIdempotencyKey, rootErrorMessage } from "../../lib/form";
import { REPORT_STATUS_LABEL } from "../../lib/labels";
import type { RouterOutputs } from "../../lib/trpc";
import { useSpaceParams } from "./space-context";

type ReportRow = RouterOutputs["report"]["list"]["items"][number];

const SECTIONS = [
  ["progress", "本周进展"],
  ["tasks", "任务完成情况"],
  ["quality", "质量情况"],
  ["decisions", "决策与变更"],
  ["risks", "风险与问题"],
  ["next_week", "下周计划"],
] as const;

type Content = Record<string, string>;

function lastWeekRange(): { start: string; end: string } {
  const now = new Date();
  const day = now.getDay() || 7;
  const monday = new Date(now.getTime() - (day - 1 + 7) * 86_400_000);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  return { start: monday.toISOString().slice(0, 10), end: sunday.toISOString().slice(0, 10) };
}

function ReportEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const report = useReport(id);
  const mutations = useReportMutations();
  const [draft, setDraft] = useState<Content | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [idemKey] = useState(newIdempotencyKey);

  const content = useMemo(() => {
    if (draft) return draft;
    const raw = (report.data?.content ?? {}) as Record<string, unknown>;
    const out: Content = {};
    for (const [key] of SECTIONS) out[key] = typeof raw[key] === "string" ? (raw[key] as string) : "";
    return out;
  }, [draft, report.data]);

  if (report.isPending) return <p className="list-note">正在加载周报…</p>;
  if (report.isError) throw report.error;
  const r = report.data;
  const readOnly = r.status === "archived" || r.status === "confirmed";

  return (
    <section className="report-editor">
      <div className="section-heading">
        <div>
          <span className="section-label">
            {r.code} · {r.periodStart} ~ {r.periodEnd} · v{r.versionNo} · {REPORT_STATUS_LABEL[r.status]}
          </span>
          <h2>周报内容</h2>
        </div>
        <button className="secondary-action" onClick={onClose}>
          收起
        </button>
      </div>
      {r.status === "confirmed" ? (
        <p className="context-note">已确认版本只读；继续修改将为同期间生成 v{r.versionNo + 1} 新草稿。</p>
      ) : null}
      {r.status === "archived" ? <p className="archive-banner small">已归档，只读。</p> : null}
      {SECTIONS.map(([key, label]) => (
        <label className="form-field" key={key}>
          <span>{label}</span>
          <textarea
            rows={3}
            value={content[key] ?? ""}
            disabled={readOnly}
            onChange={(e) => setDraft((prev) => ({ ...(prev ?? content), [key]: e.target.value }))}
          />
        </label>
      ))}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {!readOnly ? (
        <div className="drawer-actions">
          <button
            className="secondary-action"
            disabled={mutations.updateDraft.isPending}
            onClick={() => {
              setError(null);
              mutations.updateDraft.mutate(
                { id: r.id, rowVersion: r.rowVersion, content },
                {
                  onSuccess: () => setDraft(null),
                  onError: (err) => setError(rootErrorMessage(err)),
                },
              );
            }}
          >
            保存草稿
          </button>
          <button
            className="primary-action"
            disabled={mutations.confirm.isPending}
            onClick={() => {
              setError(null);
              mutations.confirm.mutate(
                { id: r.id, rowVersion: r.rowVersion, idempotencyKey: idemKey },
                { onError: (err) => setError(rootErrorMessage(err)) },
              );
            }}
          >
            <Check size={15} />
            确认并固定版本
          </button>
        </div>
      ) : r.status === "confirmed" ? (
        <div className="drawer-actions">
          <button
            className="secondary-action"
            disabled={mutations.archive.isPending}
            onClick={() => {
              setError(null);
              mutations.archive.mutate({ id: r.id }, { onError: (err) => setError(rootErrorMessage(err)) });
            }}
          >
            <Archive size={15} />
            归档周报
          </button>
        </div>
      ) : null}
    </section>
  );
}

/** 项目空间·周报页签：草稿生成/编辑/确认/归档 + 版本链 */
export default function ReportsTab() {
  const { projectId } = useSpaceParams();
  const reports = useReportList(projectId);
  const mutations = useReportMutations();
  const [range, setRange] = useState(lastWeekRange);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (reports.isPending) return <p className="list-note">正在加载周报…</p>;
  if (reports.isError) throw reports.error;

  return (
    <div className="space-tab-body">
      <div className="quality-toolbar">
        <label className="range-field">
          期间
          <input type="date" value={range.start} onChange={(e) => setRange((p) => ({ ...p, start: e.target.value }))} />
          ~
          <input type="date" value={range.end} onChange={(e) => setRange((p) => ({ ...p, end: e.target.value }))} />
        </label>
        <button
          className="primary-action"
          disabled={!range.start || !range.end || mutations.generateDraft.isPending}
          onClick={() => {
            setError(null);
            mutations.generateDraft.mutate(
              { projectId, periodStart: range.start, periodEnd: range.end },
              {
                onError: (err) => setError(rootErrorMessage(err)),
              },
            );
          }}
        >
          <Plus size={15} />
          生成周报草稿
        </button>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="report-list">
        {reports.data.items.length === 0 ? (
          <div className="empty-state">
            <FileText size={24} />
            <strong>暂无周报</strong>
            <p>选择期间后点击「生成周报草稿」，系统将聚合本周任务、质量、决策与延期。</p>
          </div>
        ) : (
          reports.data.items.map((r: ReportRow) => (
            <div className={`report-row status-${r.status}`} key={r.id}>
              <div>
                <strong>
                  {r.periodStart} ~ {r.periodEnd}
                </strong>
                <small>
                  {r.code} · v{r.versionNo} · {REPORT_STATUS_LABEL[r.status]}
                  {r.status === "archived" ? " · 已登记到档案目录 06" : ""}
                </small>
              </div>
              <button className="text-action" onClick={() => setOpenId(openId === r.id ? null : r.id)}>
                {openId === r.id ? "收起" : r.status === "draft" ? "编辑/确认" : "查看"}
              </button>
            </div>
          ))
        )}
      </div>
      {openId ? <ReportEditor id={openId} onClose={() => setOpenId(null)} /> : null}
    </div>
  );
}
