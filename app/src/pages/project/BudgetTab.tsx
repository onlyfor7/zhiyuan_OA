import { Link } from "react-router";
import { ChevronRight, Plus, Wallet } from "lucide-react";

import { useBudget, useBudgetLedger, useBudgetList } from "../../api/finance-budget";
import { useMe } from "../../api/auth";
import { BudgetBar, LedgerTable } from "../../components/finance";
import { canViewFinance } from "../../lib/permissions";
import { formatYuan } from "../../api/reference";
import { BUDGET_STATUS_LABEL, EXPENSE_CATEGORY_LABEL } from "../../lib/labels";
import { useState } from "react";
import { useSpaceParams } from "./space-context";

/** 项目空间·预算经费页签：财务可见者看真实聚合；成员脱敏占位（arch/03 §3） */
export default function BudgetTab() {
  const { projectId } = useSpaceParams();
  const me = useMe();
  const allowed = canViewFinance(
    (me.data?.projects ?? []).find((p) => p.id === projectId)?.projectRole ?? null,
    me.data?.globalRoles ?? [],
  );
  const budgets = useBudgetList(projectId, allowed);
  const [ledgerOpen, setLedgerOpen] = useState(false);

  if (!allowed) {
    return (
      <div className="space-tab-body">
        <div className="pending-box">
          <p className="context-note">
            你暂无本项目财务汇总权限（预算/经费/费用汇总仅项目负责人、管理层与财务角色可见）。如需访问请联系项目负责人授权。
          </p>
        </div>
      </div>
    );
  }

  if (budgets.isPending) return <p className="list-note">正在加载预算…</p>;
  if (budgets.isError) throw budgets.error;
  const active = budgets.data.items.find((b) => b.status === "active");

  return (
    <div className="space-tab-body">
      <div className="quality-toolbar">
        <span className="toolbar-hint">预算与经费执行（服务端聚合口径）</span>
        <Link to={`/operations/funding/new?projectId=${projectId}`} className="secondary-action">
          <Plus size={15} />
          经费申请
        </Link>
        <Link to="/operations/budget" className="secondary-action">
          经营中心
          <ChevronRight size={14} />
        </Link>
      </div>
      {active ? (
        <BudgetDetail budgetId={active.id} onLedgerToggle={() => setLedgerOpen((v) => !v)} />
      ) : (
        <div className="empty-state">
          <Wallet size={24} />
          <strong>未设预算</strong>
          <p>该项目暂无生效预算；经费申请与报销仍可按流程提交（超预算按策略处理）。</p>
        </div>
      )}
      {ledgerOpen && active ? <BudgetLedgerInline budgetId={active.id} /> : null}
    </div>
  );
}

function BudgetDetail({ budgetId, onLedgerToggle }: { budgetId: string; onLedgerToggle: () => void }) {
  const budget = useBudget(budgetId);
  if (budget.isPending) return <p className="list-note">正在加载…</p>;
  if (budget.isError) throw budget.error;
  const b = budget.data;
  return (
    <div>
      <div className="section-heading">
        <div>
          <span className="section-label">
            {b.code} · V{b.versionNo} · {BUDGET_STATUS_LABEL[b.status]}
          </span>
          <h2>预算总额 {formatYuan(b.totalCents)} 元</h2>
        </div>
        <button className="text-action" onClick={onLedgerToggle}>
          台账下钻
          <ChevronRight size={14} />
        </button>
      </div>
      {b.categories.length > 0 ? (
        <p className="context-note">
          类别额度：
          {b.categories
            .map((c) => `${EXPENSE_CATEGORY_LABEL[c.category] ?? c.category} ${formatYuan(c.amountCents)} 元`)
            .join(" · ")}
        </p>
      ) : null}
      <BudgetBar aggregate={b.aggregate} />
    </div>
  );
}

function BudgetLedgerInline({ budgetId }: { budgetId: string }) {
  const ledger = useBudgetLedger({ budgetId });
  if (ledger.isPending) return <p className="list-note">正在加载台账…</p>;
  if (ledger.isError) throw ledger.error;
  return (
    <div style={{ marginTop: 16 }}>
      <LedgerTable items={ledger.data.items} />
    </div>
  );
}
