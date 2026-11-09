import { useUserNameMap } from "../../api/reference";
import { Link } from "react-router";
import { ChevronRight, Receipt } from "lucide-react";

import { useExpenseList } from "../../api/finance-expense";
import { useFundingList } from "../../api/finance-budget";
import { formatYuan } from "../../api/reference";
import { useMe } from "../../api/auth";
import { canViewFinance } from "../../lib/permissions";
import { EXPENSE_STATUS_LABEL, FUNDING_STATUS_LABEL } from "../../lib/labels";
import { useSpaceParams } from "./space-context";

/** 项目空间·费用页签：财务可见者看项目费用；成员只看本人报销与本人经费（arch/03 §3） */
export default function ExpensesTab() {
  const userNames = useUserNameMap();
  const { projectId } = useSpaceParams();
  const me = useMe();
  const allowed = canViewFinance(
    (me.data?.projects ?? []).find((p) => p.id === projectId)?.projectRole ?? null,
    me.data?.globalRoles ?? [],
  );
  const expenses = useExpenseList(allowed ? { projectId } : { mine: true });
  const fundings = useFundingList(allowed ? { projectId } : { mine: true });

  if (expenses.isPending || fundings.isPending) return <p className="list-note">正在加载…</p>;
  if (expenses.isError) throw expenses.error;
  if (fundings.isError) throw fundings.error;

  return (
    <div className="space-tab-body">
      <div className="quality-toolbar">
        <span className="toolbar-hint">
          {allowed ? "项目费用与经费" : "我的报销与经费申请（财务汇总不可见）"}
        </span>
        <Link to={`/expenses/new?projectId=${projectId}`} className="primary-action">
          新建报销
        </Link>
        <Link to={`/operations/funding/new?projectId=${projectId}`} className="secondary-action">
          经费申请
        </Link>
        {allowed ? (
          <Link to={`/operations/expenses?projectId=${projectId}`} className="secondary-action">
            费用中心
            <ChevronRight size={14} />
          </Link>
        ) : null}
      </div>
      <span className="section-label">FUNDING</span>
      <h2>经费申请（{fundings.data.items.length}）</h2>
      <div className="report-list">
        {fundings.data.items.length === 0 ? (
          <p className="list-note">暂无经费申请。</p>
        ) : (
          fundings.data.items.map((f) => (
            <Link className="report-row" key={f.id} to={`/operations/funding/${f.id}`}>
              <div>
                <strong>{f.purpose.slice(0, 30)}</strong>
                <small>{f.code}</small>
              </div>
              <span className="mono">{formatYuan(f.amountCents)} 元</span>
              <span className="badge">{FUNDING_STATUS_LABEL[f.approvalStatus]}</span>
            </Link>
          ))
        )}
      </div>
      <span className="section-label" style={{ display: "block", marginTop: 22 }}>
        EXPENSES
      </span>
      <h2>报销单（{expenses.data.items.length}）</h2>
      <div className="report-list">
        {expenses.data.items.length === 0 ? (
          <div className="empty-state">
            <Receipt size={24} />
            <strong>暂无报销单</strong>
          </div>
        ) : (
          expenses.data.items.map((e) => (
            <Link className="report-row" key={e.id} to={`/expenses/${e.id}`}>
              <div>
                <strong>{e.code} · {e.reason.slice(0, 30)}</strong>
                <small>申请人 {userNames.get(e.applicantId) ?? "—"}</small>
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
