import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ChevronRight, Plus } from "lucide-react";
import { EXPENSE_CATEGORY } from "@lexflow/shared";

import { useBudget, useBudgetLedger, useBudgetList, useBudgetMutations } from "../api/finance-budget";
import { useMe } from "../api/auth";
import { formatYuan, parseYuanToCents } from "../api/reference";
import { BudgetBar, LedgerTable } from "../components/finance";
import { HelpIcon } from "../components/HelpIcon";
import { newIdempotencyKey, rootErrorMessage } from "../lib/form";
import { BUDGET_STATUS_LABEL, EXPENSE_CATEGORY_LABEL } from "../lib/labels";
import type { RouterOutputs } from "../lib/trpc";

type BudgetRow = RouterOutputs["budget"]["list"]["items"][number];

function BudgetCreateForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const mutations = useBudgetMutations();
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [totalYuan, setTotalYuan] = useState("");
  const [description, setDescription] = useState("");
  const [categories, setCategories] = useState<{ category: string; amountYuan: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const toggleCategory = (c: string) =>
    setCategories((prev) =>
      prev.some((x) => x.category === c)
        ? prev.filter((x) => x.category !== c)
        : [...prev, { category: c, amountYuan: "" }],
    );

  return (
    <div className="grant-apply-form">
      <div className="owner-line">
        <label className="form-field">
          <span>期间开始 *</span>
          <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
        </label>
        <label className="form-field">
          <span>期间结束 *</span>
          <input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        </label>
        <label className="form-field">
          <span>预算总额（元）*</span>
          <input type="number" min="0.01" step="0.01" value={totalYuan} onChange={(e) => setTotalYuan(e.target.value)} />
        </label>
      </div>
      <label className="form-field">
        <span>说明</span>
        <input value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="form-field">
        <span>类别额度（可选；不设类别 = 只控总额）</span>
        {EXPENSE_CATEGORY.map((c) => {
          const row = categories.find((x) => x.category === c);
          return (
            <div className="category-row" key={c}>
              <label className="check-field compact">
                <input type="checkbox" checked={!!row} onChange={() => toggleCategory(c)} />
                {EXPENSE_CATEGORY_LABEL[c]}
              </label>
              {row ? (
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={row.amountYuan}
                  placeholder="类别额度（元）"
                  aria-label={`${EXPENSE_CATEGORY_LABEL[c]}额度`}
                  onChange={(e) =>
                    setCategories((prev) => prev.map((x) => (x.category === c ? { ...x, amountYuan: e.target.value } : x)))
                  }
                />
              ) : null}
            </div>
          );
        })}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="drawer-actions">
        <button className="secondary-action" onClick={onDone}>
          取消
        </button>
        <button
          className="primary-action"
          disabled={
            !periodStart ||
            !periodEnd ||
            !totalYuan ||
            categories.some((c) => !parseYuanToCents(c.amountYuan)) ||
            mutations.create.isPending
          }
          onClick={() => {
            const totalCents = parseYuanToCents(totalYuan);
            if (!totalCents) return;
            setError(null);
            mutations.create.mutate(
              {
                projectId,
                periodStart,
                periodEnd,
                totalCents,
                description: description.trim() || undefined,
                categories: categories.length
                  ? categories
                      .map((c) => ({ category: c.category as never, amountCents: parseYuanToCents(c.amountYuan)! }))
                      .filter((c) => c.amountCents > 0)
                  : undefined,
              },
              { onSuccess: onDone, onError: (err) => setError(rootErrorMessage(err)) },
            );
          }}
        >
          创建预算（草稿）
          <Plus size={15} />
        </button>
      </div>
    </div>
  );
}

function BudgetAdjustForm({ budget, onDone }: { budget: BudgetRow; onDone: () => void }) {
  const mutations = useBudgetMutations();
  const [deltaYuan, setDeltaYuan] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grant-apply-form">
      <div className="owner-line">
        <label className="form-field">
          <span>调整额（元，正为调增负为调减）*</span>
          <input type="number" step="0.01" value={deltaYuan} onChange={(e) => setDeltaYuan(e.target.value)} />
        </label>
        <label className="form-field span-2">
          <span>调整原因 *（审批快照随附）</span>
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="drawer-actions">
        <button className="secondary-action" onClick={onDone}>
          取消
        </button>
        <button
          className="primary-action"
          disabled={!deltaYuan || Number(deltaYuan) === 0 || !reason.trim() || mutations.adjust.isPending}
          onClick={() => {
            const deltaCents = Math.round(Number(deltaYuan) * 100);
            if (!deltaCents) return;
            setError(null);
            mutations.adjust.mutate(
              { id: budget.id, deltaCents, reason: reason.trim(), idempotencyKey: newIdempotencyKey() },
              { onSuccess: onDone, onError: (err) => setError(rootErrorMessage(err)) },
            );
          }}
        >
          提交调整（产新版本）
        </button>
      </div>
    </div>
  );
}

function BudgetPanel({ budgetId }: { budgetId: string | null }) {
  const budget = useBudget(budgetId);
  const ledger = useBudgetLedger({ budgetId: budgetId ?? undefined });
  const mutations = useBudgetMutations();
  const [view, setView] = useState<"panel" | "create" | "adjust" | "ledger">("panel");
  const [error, setError] = useState<string | null>(null);

  if (budget.isPending) return <p className="list-note">正在加载预算…</p>;
  if (budget.isError) throw budget.error;
  const b = budget.data;
  if (!b) return <p className="list-note">该项目暂无预算记录。</p>;

  if (view === "create") return <BudgetCreateForm projectId={b.projectId} onDone={() => setView("panel")} />;
  if (view === "adjust")
    return <BudgetAdjustForm budget={b} onDone={() => setView("panel")} />;

  return (
    <div>
      <div className="section-heading">
        <div>
          <span className="section-label">
            {b.code} · V{b.versionNo} · {BUDGET_STATUS_LABEL[b.status]} · {b.periodStart} ~ {b.periodEnd}
          </span>
          <h2>
            预算总额 {formatYuan(b.totalCents)} 元
            {b.description ? <small className="context-note"> {b.description}</small> : null}
          </h2>
        </div>
        <div className="row-ops">
          {b.status === "draft" ? (
            <button
              className="primary-action"
              disabled={mutations.submit.isPending}
              onClick={() => {
                setError(null);
                mutations.submit.mutate(
                  { id: b.id, rowVersion: b.rowVersion, idempotencyKey: newIdempotencyKey() },
                  { onError: (err) => setError(rootErrorMessage(err)) },
                );
              }}
            >
              提交审批
            </button>
          ) : null}
          {b.status === "pending_approval" ? (
            <button
              className="secondary-action"
              disabled={mutations.withdraw.isPending}
              onClick={() => {
                setError(null);
                mutations.withdraw.mutate(
                  { id: b.id, rowVersion: b.rowVersion },
                  { onError: (err) => setError(rootErrorMessage(err)) },
                );
              }}
            >
              撤回
            </button>
          ) : null}
          {b.status === "active" ? (
            <>
              <button className="secondary-action" onClick={() => setView("adjust")}>
                申请调整
              </button>
              <button
                className="secondary-action"
                disabled={mutations.close.isPending}
                onClick={() => {
                  if (!window.confirm("确认关闭当前生效预算？关闭后不可重新激活。")) return;
                  setError(null);
                  mutations.close.mutate(
                    { id: b.id, rowVersion: b.rowVersion },
                    { onError: (err) => setError(rootErrorMessage(err)) },
                  );
                }}
              >
                关闭预算
              </button>
            </>
          ) : null}
          <button className="text-action" onClick={() => setView(view === "ledger" ? "panel" : "ledger")}>
            {view === "ledger" ? "收起台账" : "台账下钻"}
          </button>
        </div>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {b.categories.length > 0 ? (
        <p className="context-note">
          类别额度：
          {b.categories
            .map((c) => `${EXPENSE_CATEGORY_LABEL[c.category] ?? c.category} ${formatYuan(c.amountCents)} 元`)
            .join(" · ")}
        </p>
      ) : null}
      <BudgetBar aggregate={b.aggregate} />
      {view === "ledger" ? (
        ledger.isPending ? (
          <p className="list-note">正在加载台账…</p>
        ) : ledger.isError ? (
          <p className="form-error">台账加载失败</p>
        ) : (
          <LedgerTable items={ledger.data.items} />
        )
      ) : null}
    </div>
  );
}

/** 经营中心·预算：项目预算列表 + 执行横条 + 版本/调整/台账（arch/06 §7） */
export default function OperationsBudgetPage() {
  const me = useMe();
  const [params] = useSearchParams();
  const preProjectId = params.get("projectId") ?? "";
  const managed = useMemo(
    () => (me.data?.projects ?? []).filter((p) => p.projectRole === "manager"),
    [me.data],
  );
  const partnerOrFinance =
    (me.data?.globalRoles ?? []).includes("partner") || (me.data?.globalRoles ?? []).includes("finance");
  const budgets = useBudgetList(partnerOrFinance && !preProjectId ? undefined : preProjectId || managed[0]?.id);
  const [createFor, setCreateFor] = useState<string | null>(null);

  if (me.isPending || budgets.isPending) return <p className="list-note">正在加载…</p>;
  if (me.isError) throw me.error;
  if (budgets.isError) throw budgets.error;

  const items = budgets.data.items;
  const selected = items.find((b) => b.status === "active") ?? items[0];

  return (
    <div className="screen operations-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">OPERATIONS · BUDGET</span>
          <h1 aria-label="预算管理">
            预算管理
            <HelpIcon pageKey="operations-budget" />
          </h1>
          <p>预算版本、执行横条与台账下钻；无预算项目显示「未设预算」。</p>
        </div>
        <Link to="/operations/expenses" className="secondary-action">
          费用中心
          <ChevronRight size={15} />
        </Link>
      </div>
      {createFor ? (
        <BudgetCreateForm projectId={createFor} onDone={() => setCreateFor(null)} />
      ) : (
        <>
          <div className="quality-toolbar">
            <span className="toolbar-hint">预算版本（{items.length}）</span>
            {managed.length > 0 ? (
              <button className="primary-action" onClick={() => setCreateFor(managed[0].id)}>
                <Plus size={15} />
                新建预算（{managed[0].name}）
              </button>
            ) : null}
          </div>
          <div className="report-list">
            {items.length === 0 ? (
              <div className="empty-state">
                <strong>暂无预算</strong>
                <p>点击「新建预算」创建首版预算并提交审批。</p>
              </div>
            ) : (
              items.map((b: BudgetRow) => (
                <div className={`report-row budget-row status-${b.status}`} key={b.id}>
                  <div>
                    <strong>
                      {b.code} · V{b.versionNo}
                      <span className={`badge badge-travel-${b.status === "active" ? "approved" : b.status === "pending_approval" ? "pending_approval" : "draft"}`}>
                        {BUDGET_STATUS_LABEL[b.status]}
                      </span>
                    </strong>
                    <small>
                      {b.periodStart} ~ {b.periodEnd} · 总额 {formatYuan(b.totalCents)} 元
                    </small>
                  </div>
                </div>
              ))
            )}
          </div>
          {selected ? <BudgetPanel budgetId={selected.id} /> : null}
        </>
      )}
    </div>
  );
}
