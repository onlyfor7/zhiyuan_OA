import { useState } from "react";

import { useApprovalDetail } from "../api/approval";
import { formatYuan } from "../api/reference";
import { EXPENSE_CATEGORY_LABEL, SEGMENT_TYPE_LABEL, TIME_ACTIVITY_LABEL } from "../lib/labels";
import { TIMESHEET_STATUS_LABEL } from "../lib/labels";

/**
 * §16.2 审批业务快照区：待审批卡必见业务表单内容（类型徽标外的单据关键字段与明细）。
 * 要点默认展开；报销明细/工时明细超 5 行折叠「展开全部明细」。实体缺失=kind-only 时按通用字段渲染。
 */

interface ExpenseItem { category: string; date: string; amountCents: number; description: string | null; projectName: string | null }
interface ExpenseSnap { kind: "expense"; reason: string | null; reportCode: string; totalCents: number; itemCount: number; items: ExpenseItem[] }
interface AdjSnap { kind: "expense_adjustment"; deltaCents: number; reason: string | null; sourceReportCode: string | null; sourceReportReason: string | null }
interface FundingSnap { kind: "funding"; code: string; purpose: string; amountCents: number; expectedUseDate: string | null; recipientInfo: string | null; usageStatus: string | null }
interface Segment { seq: number; type: string; startAt: string; endAt: string; fromPlace: string | null; toPlace: string | null }
interface TravelSnap { kind: "travel"; code: string; reason: string | null; destination: string; startOn: string; endOn: string; borrow: boolean; borrowAmountCents: number | null; estimatedCostCents: number | null; segments: Segment[] }
interface TravelChangeSnap { kind: "travel_change"; reason: string | null; changes: Record<string, unknown>; travel: { code: string; reason: string | null; destination: string; startOn: string; endOn: string } | null }
interface GenericSnap { kind: "generic_request"; code: string; requestType: string; title: string; reason: string | null; startOn: string | null; endOn: string | null; amountCents: number | null }
interface TimeEntry { workDate: string; durationMinutes: number; activityType: string; description: string | null; projectName: string | null }
interface TimesheetSnap { kind: "timesheet"; periodStart: string; periodEnd: string; periodStatus: string; totalMinutes: number; totalHours: number; entries: TimeEntry[] }
interface ChangeSnap { kind: "change_request"; code: string; title: string; reason: string | null; impact: string | null }
interface GrantSnap { kind: "access_grant"; scopeType: string; scopeId: string | null; actions: string[]; expiresAt: string | null; grantStatus: string }
interface BudgetSnap { kind: "budget"; totalCents: number; currency: string; budgetStatus: string }
type Snap = { kind: string } & Partial<
  Omit<ExpenseSnap, "kind"> & Omit<AdjSnap, "kind"> & Omit<FundingSnap, "kind"> & Omit<TravelSnap, "kind"> &
  Omit<TravelChangeSnap, "kind"> & Omit<GenericSnap, "kind"> & Omit<TimesheetSnap, "kind"> &
  Omit<ChangeSnap, "kind"> & Omit<GrantSnap, "kind"> & Omit<BudgetSnap, "kind">
>;

const money = (cents: number | null | undefined) => (cents == null ? "—" : `${formatYuan(cents)} 元`);
const hours = (minutes: number | null | undefined) => (minutes == null ? "—" : `${Number.isInteger(minutes / 60) ? minutes / 60 : (minutes / 60).toFixed(1)} 小时`);
const dt = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace("T", " ") : "—");
const dateOf = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "—");

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="biz-field">
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

function MiniTable({ head, rows, monoCols = [] }: { head: string[]; rows: React.ReactNode[][]; monoCols?: number[] }) {
  return (
    <div className="biz-table" role="table" style={{ "--biz-cols": head.length } as never}>
      <div className="biz-tr biz-head" role="row">
        {head.map((h, i) => (
          <span key={i} role="columnheader">{h}</span>
        ))}
      </div>
      {rows.map((r, i) => (
        <div className="biz-tr" role="row" key={i}>
          {r.map((c, j) => (
            <span key={j} role="cell" className={monoCols.includes(j) ? "mono" : undefined}>
              {c}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/** 明细超过 N 行折叠，可展开全部 */
function CollapsibleRows({ rows, head, monoCols, cap = 5 }: { rows: React.ReactNode[][]; head: string[]; monoCols?: number[]; cap?: number }) {
  const [open, setOpen] = useState(false);
  const shown = open ? rows : rows.slice(0, cap);
  return (
    <>
      <MiniTable head={head} rows={shown} monoCols={monoCols} />
      {rows.length > cap ? (
        <button type="button" className="p9a-show-all" onClick={() => setOpen((v) => !v)}>
          {open ? "收起明细" : `··· 展开全部明细（${rows.length} 行）`}
        </button>
      ) : null}
    </>
  );
}

function SnapshotBody({ snap }: { snap: Snap }) {
  switch (snap.kind) {
    case "expense": {
      const total = snap.totalCents ?? 0;
      return (
        <>
          <div className="biz-fields">
            <Field label="报销单号">{snap.reportCode}</Field>
            <Field label="事由">{snap.reason ?? "—"}</Field>
            <Field label="合计金额">{money(total)}</Field>
            <Field label="明细行数">{snap.itemCount ?? 0} 行</Field>
          </div>
          <span className="section-label">报销明细（类别/日期/金额/说明）</span>
          <CollapsibleRows
            head={["类别", "日期", "金额", "说明", "项目"]}
            monoCols={[2]}
            rows={(snap.items ?? []).map((it) => [
              EXPENSE_CATEGORY_LABEL[it.category] ?? it.category,
              it.date,
              money(it.amountCents),
              it.description ?? "—",
              it.projectName ?? "—",
            ])}
          />
        </>
      );
    }
    case "expense_adjustment":
      return (
        <div className="biz-fields">
          <Field label="调整额">
            <span style={(snap.deltaCents ?? 0) < 0 ? { color: "#dc2626" } : undefined}>{money(snap.deltaCents)}</span>
          </Field>
          <Field label="调整原因">{snap.reason ?? "—"}</Field>
          <Field label="原报销单">{snap.sourceReportCode ?? "—"}</Field>
          <Field label="原单事由">{snap.sourceReportReason ?? "—"}</Field>
        </div>
      );
    case "funding":
      return (
        <div className="biz-fields">
          <Field label="单号">{snap.code}</Field>
          <Field label="用途">{snap.purpose}</Field>
          <Field label="金额">{money(snap.amountCents)}</Field>
          <Field label="期望使用日">{snap.expectedUseDate ?? "—"}</Field>
          <Field label="收款信息">{snap.recipientInfo ?? "—"}</Field>
          <Field label="使用状态">{snap.usageStatus ?? "—"}</Field>
        </div>
      );
    case "travel":
      return (
        <>
          <div className="biz-fields">
            <Field label="单号">{snap.code}</Field>
            <Field label="事由">{snap.reason ?? "—"}</Field>
            <Field label="目的地">{snap.destination}</Field>
            <Field label="起止">{dateOf(snap.startOn)} ~ {dateOf(snap.endOn)}</Field>
            <Field label="借款">{snap.borrow ? money(snap.borrowAmountCents) : "无"}</Field>
            <Field label="预计费用">{money(snap.estimatedCostCents)}</Field>
          </div>
          <span className="section-label">行程段</span>
          <CollapsibleRows
            head={["#", "类型", "开始", "结束", "出发 → 到达"]}
            rows={(snap.segments ?? []).map((s) => [
              s.seq,
              SEGMENT_TYPE_LABEL[s.type] ?? s.type,
              dt(s.startAt),
              dt(s.endAt),
              `${s.fromPlace ?? "—"} → ${s.toPlace ?? "—"}`,
            ])}
          />
        </>
      );
    case "travel_change":
      return (
        <>
          <div className="biz-fields">
            <Field label="变更原因">{snap.reason ?? "—"}</Field>
            <Field label="原出差">
              {snap.travel ? `${snap.travel.code} · ${snap.travel.destination}（${dateOf(snap.travel.startOn)} ~ ${dateOf(snap.travel.endOn)}）` : "—"}
            </Field>
          </div>
          {snap.changes && Object.keys(snap.changes).length > 0 ? (
            <>
              <span className="section-label">变更内容</span>
              <div className="biz-fields">
                {Object.entries(snap.changes).map(([k, v]) => (
                  <Field label={k} key={k}>{typeof v === "string" ? v : JSON.stringify(v)}</Field>
                ))}
              </div>
            </>
          ) : null}
        </>
      );
    case "generic_request":
      return (
        <div className="biz-fields">
          <Field label="单号">{snap.code}</Field>
          <Field label="类型">{snap.requestType}</Field>
          <Field label="标题">{snap.title}</Field>
          <Field label="事由">{snap.reason ?? "—"}</Field>
          <Field label="起止">{snap.startOn || snap.endOn ? `${dateOf(snap.startOn)} ~ ${dateOf(snap.endOn)}` : "—"}</Field>
          <Field label="金额">{money(snap.amountCents)}</Field>
        </div>
      );
    case "timesheet":
      return (
        <>
          <div className="biz-fields">
            <Field label="周期">{dateOf(snap.periodStart)} ~ {dateOf(snap.periodEnd)}</Field>
            <Field label="周期状态">{TIMESHEET_STATUS_LABEL[snap.periodStatus ?? ""] ?? snap.periodStatus ?? "—"}</Field>
            <Field label="合计工时">{hours(snap.totalMinutes)}（{snap.totalHours ?? 0}h）</Field>
            <Field label="明细行数">{(snap.entries ?? []).length} 行</Field>
          </div>
          <span className="section-label">工时明细摘要</span>
          <CollapsibleRows
            head={["日期", "工时", "活动", "说明", "项目"]}
            monoCols={[1]}
            rows={(snap.entries ?? []).map((e) => [
              e.workDate,
              hours(e.durationMinutes),
              TIME_ACTIVITY_LABEL[e.activityType] ?? e.activityType,
              e.description ?? "—",
              e.projectName ?? "—",
            ])}
          />
        </>
      );
    case "change_request":
      return (
        <div className="biz-fields">
          <Field label="单号">{snap.code}</Field>
          <Field label="标题">{snap.title}</Field>
          <Field label="原因">{snap.reason ?? "—"}</Field>
          <Field label="影响">{snap.impact ?? "—"}</Field>
        </div>
      );
    case "access_grant":
      return (
        <div className="biz-fields">
          <Field label="范围">{snap.scopeType}</Field>
          <Field label="动作">{(snap.actions ?? []).join("、") || "—"}</Field>
          <Field label="期限">{snap.expiresAt ? dateOf(snap.expiresAt) : "长期"}</Field>
          <Field label="状态">{snap.grantStatus}</Field>
        </div>
      );
    case "budget":
      return (
        <div className="biz-fields">
          <Field label="预算总额">{money(snap.totalCents)}</Field>
          <Field label="币种">{snap.currency}</Field>
          <Field label="状态">{snap.budgetStatus}</Field>
        </div>
      );
    default:
      return <p className="list-note">该单据类型暂无结构化快照（kind-only）。</p>;
  }
}

export default function BizSnapshot({ instanceId }: { instanceId: string }) {
  const detail = useApprovalDetail(instanceId);
  if (detail.isPending) return <p className="list-note">正在加载业务详情…</p>;
  if (detail.isError) return null;
  const d = detail.data;
  return (
    <div className="biz-detail">
      <div className="biz-detail-head">
        <span className="section-label">BIZ · {d.code}</span>
        <span className="toolbar-hint">
          申请人 <strong>{d.applicantName ?? "—"}</strong>
          {d.projectName ? ` · 项目 ${d.projectName}` : ""} · 提交 {dt(d.submittedAt)}
        </span>
      </div>
      <SnapshotBody snap={d.snapshot as Snap} />
    </div>
  );
}
