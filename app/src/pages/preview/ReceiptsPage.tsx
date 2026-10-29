import { useMemo, useState } from "react";
import { ArrowRight, Ban, Plus, Receipt } from "lucide-react";

import { PreviewNote } from "./PreviewNote";
import { previewReceiptProjects, previewReceipts, yuan } from "./preview-data";

/** /preview/receipts 收款登记台账（R 域：登记/作废冲正/项目收入视图） */
export default function ReceiptsPage() {
  const [view, setView] = useState<"list" | "income" | "register">("list");
  const [projectFilter, setProjectFilter] = useState("");
  const [voidTarget, setVoidTarget] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState("");

  const filtered = useMemo(
    () => previewReceipts.filter((r) => !projectFilter || r.projectName === projectFilter),
    [projectFilter],
  );
  const registered = filtered.filter((r) => r.status === "registered");
  const totalCents = registered.reduce((s, r) => s + r.amountCents, 0);

  return (
    <div className="screen preview-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">PAYMENT RECEIPTS</span>
          <h1>客户收款台账</h1>
          <p>仅登记与台账（无计费/开票/在线支付）；金额不可编辑，更正 = 作废 + 新登记。</p>
        </div>
        <div className="title-actions">
          <button className={view === "list" ? "primary-action" : "secondary-action"} onClick={() => setView("list")}>
            收款列表
          </button>
          <button className={view === "income" ? "primary-action" : "secondary-action"} onClick={() => setView("income")}>
            项目收入视图
          </button>
          <button className={view === "register" ? "primary-action" : "secondary-action"} onClick={() => setView("register")}>
            <Plus size={15} />
            登记收款
          </button>
        </div>
      </div>

      {view === "list" ? (
        <>
          <div className="quality-toolbar">
            <select value={projectFilter} aria-label="项目筛选" onChange={(e) => setProjectFilter(e.target.value)}>
              <option value="">全部项目</option>
              {previewReceiptProjects.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
            <input type="date" aria-label="开始日期" />
            <input type="date" aria-label="结束日期" />
            <span className="toolbar-hint">
              实收合计 <strong className="mono">{yuan(totalCents)} 元</strong>（registered − voided 原额口径）
            </span>
          </div>
          <div className="grant-table">
            <div className="grant-head">
              <span>收款单</span>
              <span>项目 / 客户</span>
              <span>金额</span>
              <span>到账日期</span>
              <span>回单号</span>
              <span>状态</span>
              <span />
            </div>
            {filtered.map((r) => (
              <div className={`grant-row ${r.status === "voided" ? "revoked" : ""}`} key={r.id}>
                <div>
                  <strong>{r.code}</strong>
                  <small>{r.note ?? ""}</small>
                </div>
                <span>
                  {r.projectName}
                  <small>{r.clientName}</small>
                </span>
                <span className="mono">{yuan(r.amountCents)} 元</span>
                <span className="mono">{r.receivedOn}</span>
                <span className="mono">{r.referenceNo}</span>
                <span className={r.status === "registered" ? "grant-status" : "log-denied"}>
                  {r.status === "registered" ? "已登记" : "已作废"}
                </span>
                {r.status === "registered" ? (
                  <button className="text-action" onClick={() => setVoidTarget(r.id)}>
                    <Ban size={12} />
                    作废
                  </button>
                ) : (
                  <span className="muted-label">{r.voidReason}</span>
                )}
              </div>
            ))}
          </div>
          <PreviewNote>作废不删行、留理由与操作人（审计）；附件继承财务权限；导出 CSV 写审计。</PreviewNote>
        </>
      ) : null}

      {view === "income" ? (
        <section>
          <div className="metric-strip overview-strip">
            {previewReceiptProjects.map((p) => {
              const rows = previewReceipts.filter((r) => r.projectName === p && r.status === "registered");
              const sum = rows.reduce((s, r) => s + r.amountCents, 0);
              return (
                <div key={p}>
                  <span>{p}</span>
                  <strong>{yuan(sum)}</strong>
                  <small>元 · {rows.length} 笔实收</small>
                </div>
              );
            })}
          </div>
          <span className="section-label" style={{ display: "block", marginTop: 22 }}>
            LEDGER · 台账式明细（项目应收 vs 实收由收款记录聚合，无独立应收实体）
          </span>
          <div className="ledger-table">
            <div className="ledger-head">
              <span>日期</span>
              <span>编号</span>
              <span>类型</span>
              <span>占用变动（分）</span>
              <span>实际变动（分）</span>
              <span>来源</span>
            </div>
            {previewReceipts.map((r) => (
              <div className={`ledger-row ${r.status === "voided" ? "voided" : ""}`} key={r.id}>
                <time>{r.receivedOn}</time>
                <span className="mono">{r.code}</span>
                <span>{r.status === "registered" ? "收款登记" : "作废冲正"}</span>
                <span className="mono">0</span>
                <span className="mono">
                  {r.status === "registered" ? `+${r.amountCents}` : `−${r.amountCents}`}
                </span>
                <span className="mono">{r.projectName.slice(0, 10)}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {view === "register" ? (
        <div className="grant-apply-form">
          <div className="owner-line">
            <label className="form-field">
              <span>项目 *</span>
              <select defaultValue={previewReceiptProjects[0]}>
                {previewReceiptProjects.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            <label className="form-field">
              <span>金额（元）*</span>
              <input type="number" min="0.01" step="0.01" placeholder="整数分存储，界面按元录入" />
            </label>
            <label className="form-field">
              <span>到账日期 *</span>
              <input type="date" />
            </label>
          </div>
          <div className="owner-line">
            <label className="form-field">
              <span>银行回单/流水号 *</span>
              <input placeholder="BK20261101001" />
            </label>
            <label className="form-field">
              <span>付款人</span>
              <input placeholder="默认同客户名称" />
            </label>
            <label className="form-field">
              <span>备注</span>
              <input placeholder="如：首期律师费" />
            </label>
          </div>
          <label className="form-field">
            <span>回单附件（受控上传）</span>
            <input type="file" />
          </label>
          <PreviewNote>登记幂等键防重复提交；金额一旦登记不可编辑（更正=作废+新登记）。</PreviewNote>
          <button className="primary-action" onClick={() => window.alert("原型预览：界面为静态示意，操作不会被提交。")}>
            <Receipt size={15} />
            登记收款
            <ArrowRight size={15} />
          </button>
        </div>
      ) : null}

      {voidTarget ? (
        <div className="overlay centered" onMouseDown={(e) => e.target === e.currentTarget && setVoidTarget(null)}>
          <section className="decision-modal compact-modal" role="dialog" aria-modal="true" aria-label="作废收款">
            <div className="drawer-head">
              <div>
                <span className="section-label">VOID RECEIPT</span>
                <h2>作废收款（冲正）</h2>
              </div>
              <button className="icon-button" aria-label="关闭" onClick={() => setVoidTarget(null)}>
                ×
              </button>
            </div>
            <p className="context-note">作废后原行保留（voided 原额冲减口径），需重新登记正确金额。</p>
            <label className="form-field">
              <span>作废理由 *</span>
              <textarea rows={2} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
            </label>
            <button
              className="primary-action full-action"
              disabled={!voidReason.trim()}
              onClick={() => {
                setVoidTarget(null);
                setVoidReason("");
                window.alert("原型预览：界面为静态示意，操作不会被提交。");
              }}
            >
              确认作废
            </button>
          </section>
        </div>
      ) : null}
    </div>
  );
}
