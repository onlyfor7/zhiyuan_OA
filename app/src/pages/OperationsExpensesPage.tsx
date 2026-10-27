import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { ChevronRight, Download, Plus } from "lucide-react";

import { useMe } from "../api/auth";
import {
  useExpenseList,
  useExpenseStatsByCategory,
  useExpenseStatsByPerson,
  useExpenseStatsByProject,
} from "../api/finance-expense";
import { useTRPC } from "../lib/trpc";
import { formatYuan } from "../api/reference";
import { BudgetBar } from "../components/finance";
import { useRail } from "../components/shell-rail";
import { EXPENSE_CATEGORY_LABEL, EXPENSE_STATUS_LABEL } from "../lib/labels";
import type { RouterOutputs } from "../lib/trpc";

type ExpenseItem = RouterOutputs["expense"]["list"]["items"][number];

function OperationsRail() {
  return (
    <aside className="context-rail">
      <div className="context-heading">
        <span className="section-label">EXPENSES</span>
        <h2>费用中心</h2>
      </div>
      <div className="context-section">
        <div className="section-label">SAME NUMBER</div>
        <h2>同名指标同数</h2>
        <p className="context-note">
          统计口径：实际支出 = 已批准及之后状态的报销净额；已支付不重复计。导出由服务端生成并写审计。
        </p>
      </div>
      <div className="assurance">成员无财务汇总权限（服务端强制，本页对其同形 404）。</div>
    </aside>
  );
}

/** 经营中心·费用：统计摘要 + 报销列表 + CSV 导出（arch/06 §7） */
export default function OperationsExpensesPage() {
  useRail(OperationsRail);
  const me = useMe();
  const [params] = useSearchParams();
  const preProjectId = params.get("projectId") ?? "";
  const managed = useMemo(
    () => (me.data?.projects ?? []).filter((p) => p.projectRole === "manager"),
    [me.data],
  );
  const projectId = preProjectId || managed[0]?.id || "";
  const stats = useExpenseStatsByProject(projectId || null);
  const byCategory = useExpenseStatsByCategory(projectId || null);
  const byPerson = useExpenseStatsByPerson(projectId || null);
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [mine, setMine] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [status, setStatus] = useState("");
  const list = useExpenseList(projectId && !mine ? { projectId } : { mine: true });
  const filtered = list.data?.items.filter((e) => !status || e.status === status);

  const isFinanceRole =
    (me.data?.globalRoles ?? []).includes("partner") || (me.data?.globalRoles ?? []).includes("finance");
  if (me.isPending) return <p className="list-note">正在加载…</p>;
  if (me.isError) throw me.error;
  if (!isFinanceRole && managed.length === 0) {
    return (
      <div className="screen operations-expenses-screen">
        <div className="screen-heading">
          <div>
            <span className="eyebrow">OPERATIONS · EXPENSES</span>
            <h1>费用中心</h1>
          </div>
        </div>
        <div className="pending-box">
          <p className="context-note">
            你暂无财务汇总权限（费用统计与导出仅项目负责人、管理层与财务角色可见）。你仍可在项目「费用」页签查看与提交本人报销。
          </p>
        </div>
      </div>
    );
  }
  if (stats.isPending || list.isPending) return <p className="list-note">正在加载…</p>;
  if (stats.isError) throw stats.error;
  if (list.isError) throw list.error;

  const downloadCsv = async () => {
    setExporting(true);
    try {
      const r = await queryClient.fetchQuery(trpc.expense.stats.exportCsv.queryOptions({ projectId }));
      const blob = new Blob([r.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `报销导出_${projectId.slice(0, 8)}_${r.asOf.slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="screen operations-expenses-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">OPERATIONS · EXPENSES</span>
          <h1>费用中心</h1>
          <p>{stats.data.statusScope}</p>
        </div>
        <div className="title-actions">
          <button className="secondary-action" disabled={exporting} onClick={() => void downloadCsv()}>
            <Download size={15} />
            {exporting ? "导出中…" : "导出 CSV"}
          </button>
          <Link to={`/expenses/new${projectId ? `?projectId=${projectId}` : ""}`} className="primary-action">
            <Plus size={15} />
            新建报销
          </Link>
        </div>
      </div>
      <BudgetBar aggregate={stats.data} />
      <div className="overview-panels">
        <section>
          <span className="section-label">BY CATEGORY</span>
          <h2>按类别（已批准口径）</h2>
          {byCategory.data?.items.length === 0 ? (
            <p className="list-note">暂无已批准报销。</p>
          ) : (
            byCategory.data?.items.map((c) => (
              <div className="cause-row" key={c.category}>
                <span>{EXPENSE_CATEGORY_LABEL[c.category] ?? c.category}</span>
                <div>
                  <i style={{ width: "60%" }} />
                </div>
                <strong>
                  {formatYuan(c.total)} 元 × {c.count}
                </strong>
              </div>
            ))
          )}
        </section>
        <section>
          <span className="section-label">BY PERSON</span>
          <h2>按申请人</h2>
          {byPerson.data?.items.length === 0 ? (
            <p className="list-note">暂无数据。</p>
          ) : (
            byPerson.data?.items.map((p) => (
              <div className="cause-row" key={p.applicantId}>
                <span>{p.applicantId.slice(0, 8)}</span>
                <div>
                  <i style={{ width: "60%" }} />
                </div>
                <strong>
                  {formatYuan(p.total)} 元 × {p.count}
                </strong>
              </div>
            ))
          )}
        </section>
      </div>
      <div className="quality-toolbar">
        <div className="audit-tabs inline-tabs">
          <button className={!mine ? "active" : ""} onClick={() => setMine(false)}>
            项目费用
          </button>
          <button className={mine ? "active" : ""} onClick={() => setMine(true)}>
            我的报销
          </button>
        </div>
        <select value={status} aria-label="报销状态" onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部状态</option>
          <option value="draft">草稿</option>
          <option value="pending_approval">审批中</option>
          <option value="approved_pending_payment">待支付</option>
          <option value="paid">已支付</option>
          <option value="rejected">已驳回</option>
        </select>
        <span>{filtered?.length ?? 0} 单</span>
      </div>
      <div className="report-list">
        {filtered?.length === 0 ? (
          <div className="empty-state">
            <strong>没有匹配的报销单</strong>
          </div>
        ) : (
          filtered?.map((e: ExpenseItem) => (
            <Link className="report-row" key={e.id} to={`/expenses/${e.id}`}>
              <div>
                <strong>
                  {e.code} · {e.reason.slice(0, 30)}
                  {e.isCrossProject ? <em className="mark-duesoon">跨项目</em> : null}
                </strong>
                <small>申请人 {e.applicantId.slice(0, 8)}</small>
              </div>
              <span className="mono">{formatYuan(e.totalCents)} 元</span>
              <span className={`badge badge-travel-${e.status === "paid" ? "approved" : e.status === "rejected" ? "rejected" : "pending_approval"}`}>
                {EXPENSE_STATUS_LABEL[e.status]}
              </span>
              <span className="text-action">
                查看
                <ChevronRight size={14} />
              </span>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
