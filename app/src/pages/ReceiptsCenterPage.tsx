import { useMemo, useState } from "react";
import { Download, Plus, Receipt } from "lucide-react";
import { useSearchParams } from "react-router";

import { useMe } from "../api/auth";
import { useContractList, useCustomer } from "../api/crm";
import {
  useReceiptExport,
  useReceiptList,
  useReceiptMutations,
  useReceiptProjectOptions,
  useReceiptSummary,
} from "../api/receipts";
import { FormDialog } from "../components/FormDialog";
import { HelpIcon } from "../components/HelpIcon";
import { DensitySwitch } from "../components/density";
import { useTableDensity } from "../lib/tableDensity";
import { toast } from "sonner";
import { newIdempotencyKey, rootErrorMessage } from "../lib/form";
import { formatYuan, parseYuanToCents } from "../api/reference";

/** /operations/receipts 收款中心（真实 receipts.*；member/viewer 由服务端同形 404，入口亦按角色隐藏） */
export default function ReceiptsCenterPage() {
  const me = useMe();
  const managed = useMemo(
    () => (me.data?.projects ?? []).filter((p) => p.projectRole === "manager"),
    [me.data],
  );
  const roles = me.data?.globalRoles ?? [];
  const isFinance = roles.includes("finance");
  const isPartner = roles.includes("partner");
  const canView = isFinance || isPartner || managed.length > 0;
  const canWrite = isFinance;

  const [view, setView] = useState<"list" | "income">("list");
  const [registerOpen, setRegisterOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  // 9d-03：应收管理「登记收款」直跳预填——合同/计划行成对挂接（arch/12 §6.3 回款勾稽）
  const [searchParams, setSearchParams] = useSearchParams();
  const prefillOn = searchParams.get("prefill") === "1";
  const prefillContractId = searchParams.get("contractId") ?? "";
  const prefillPlanId = searchParams.get("planId") ?? "";
  const prefillCustomerId = searchParams.get("customerId") ?? "";
  const prefillAmountCents = Number(searchParams.get("amountCents") ?? 0) || 0;
  const [prefillDismissed, setPrefillDismissed] = useState(false);
  const listFilter = projectId || managed[0]?.id ? { projectId: projectId || managed[0]!.id } : {};
  const list = useReceiptList(listFilter, canView && view === "list");
  const summary = useReceiptSummary("project", canView && view === "income");
  // 挂合同登记需知项目——应收/合同链路不带 projectId，经客户详情聚合 projects 区解析（默认首项，弹窗内可改）
  const prefillCustomer = useCustomer(prefillOn && canWrite ? prefillCustomerId : null);
  const prefillProjectId = prefillCustomer.data?.projects?.[0]?.id ?? "";
  const showPrefill = prefillOn && canWrite && !!prefillProjectId && !prefillDismissed;
  // 台账行内「关联合同/计划」标识：合同↔回款经 crm_contract_payment_plans.receipt_id 关联（收款表无合同列）
  const contracts = useContractList({}, canView && view === "list");
  const receiptLinkMap = useMemo(() => {
    const m = new Map<string, { contractCode: string; planSeq: number }>();
    for (const c of contracts.data?.items ?? []) {
      for (const p of c.plans ?? []) {
        if (p.receiptId) m.set(p.receiptId, { contractCode: c.code, planSeq: p.seq });
      }
    }
    return m;
  }, [contracts.data]);
  // 登记项目源（arch 裁定 04b-①）：receipts.projectOptions 参照级清单（全部项目，无收款记录的新项目可登记）
  const projectOptions = useReceiptProjectOptions(canWrite && (registerOpen || showPrefill));
  const registerProjects = useMemo(() => projectOptions.data ?? [], [projectOptions.data]);
  const exportCsv = useReceiptExport();
  const { density, setDensity } = useTableDensity();
  const mutations = useReceiptMutations();
  const [voidTarget, setVoidTarget] = useState<{ id: string; rowVersion: number } | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (me.isPending) return <p className="list-note">正在加载…</p>;
  if (me.isError) throw me.error;

  if (!canView) {
    return (
      <div className="screen receipts-center-screen">
        <div className="screen-heading">
          <div>
            <span className="eyebrow">PAYMENT RECEIPTS</span>
            <h1>客户收款台账</h1>
          </div>
        </div>
        <div className="pending-box">
          <p className="context-note">
            你暂无收款查看权限（收款台账仅财务/管理层/项目负责人可见，arch/09 §2 权限矩阵）。
          </p>
        </div>
      </div>
    );
  }

  const items = list.data?.items ?? [];
  const registered = items.filter((r) => r.status === "registered");
  const totalCents = registered.reduce((s, r) => s + r.amountCents, 0);

  return (
    <div className="screen receipts-center-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">PAYMENT RECEIPTS</span>
          <h1>
            客户收款台账
            <HelpIcon pageKey="receipts-ledger" />
          </h1>
          <p>实收口径 = Σregistered − Σvoided（原额）；更正=作废+新登记，不删行。</p>
        </div>
        <div className="title-actions">
          <button className={view === "list" ? "primary-action" : "secondary-action"} onClick={() => setView("list")}>
            收款列表
          </button>
          <button className={view === "income" ? "primary-action" : "secondary-action"} onClick={() => setView("income")}>
            项目收入视图
          </button>
          {canWrite ? (
            <button className="secondary-action" onClick={() => setRegisterOpen(true)}>
              <Plus size={15} />
              登记收款
            </button>
          ) : null}
          {isFinance || isPartner ? (
            <button
              className="secondary-action"
              onClick={() => {
                void exportCsv().then((r) => {
                  const blob = new Blob([r.csv], { type: "text/csv;charset=utf-8" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `收款导出_${r.asOf.slice(0, 10)}.csv`;
                  a.click();
                  URL.revokeObjectURL(url);
                });
              }}
            >
              <Download size={15} />
              导出 CSV
            </button>
          ) : null}
        </div>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {view === "list" ? (
        <>
          <DensitySwitch density={density} onChange={setDensity} />
          <div className="quality-toolbar">
            {managed.length > 0 ? (
              <select value={projectId || managed[0]?.id || ""} aria-label="项目筛选" onChange={(e) => setProjectId(e.target.value)}>
                {managed.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : isFinance ? (
              <span className="toolbar-hint">全部项目（财务全量口径）</span>
            ) : null}
            <input type="date" aria-label="开始日期" />
            <input type="date" aria-label="结束日期" />
            <span className="toolbar-hint">
              实收合计 <strong className="mono">{formatYuan(totalCents)} 元</strong>
            </span>
          </div>
          {list.isPending ? (
            <p className="list-note">正在加载…</p>
          ) : list.isError ? (
            <p className="form-error">收款列表加载失败或无权限。</p>
          ) : (
            <div className={`grant-table density-${density}`}>
              <div className="grant-head">
                <span>收款单</span>
                <span>项目</span>
                <span>金额</span>
                <span>到账日期</span>
                <span>回单号</span>
                <span>状态</span>
                <span />
              </div>
              {items.map((r) => {
                const link = receiptLinkMap.get(r.id);
                return (
                <div className={`grant-row ${r.status === "voided" ? "revoked" : ""}`} key={r.id}>
                  <div>
                    <strong>{r.code}</strong>
                    <small>{link ? `已挂 ${link.contractCode} · 计划 #${link.planSeq}` : (r.note ?? "")}</small>
                  </div>
                  <span>{r.projectId.slice(0, 8)}</span>
                  <span className="mono">{formatYuan(r.amountCents)} 元</span>
                  <span className="mono">{r.receivedOn}</span>
                  <span className="mono">{r.referenceNo}</span>
                  <span className={r.status === "registered" ? "grant-status" : "log-denied"}>
                    {r.status === "registered" ? "已登记" : "已作废"}
                  </span>
                  {r.status === "registered" && canWrite ? (
                    <button className="text-action" onClick={() => setVoidTarget({ id: r.id, rowVersion: r.rowVersion })}>
                      作废
                    </button>
                  ) : (
                    <span className="muted-label">{r.voidReason ?? ""}</span>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </>
      ) : null}

      {view === "income" ? (
        summary.isPending ? (
          <p className="list-note">正在加载汇总…</p>
        ) : summary.isError ? (
          <p className="form-error">汇总加载失败或无权限（汇总仅财务/管理层）。</p>
        ) : (
          <>
            <p className="context-note">{summary.data.scope} · asOf {summary.data.asOf.slice(0, 16).replace("T", " ")}</p>
            <div className="metric-strip overview-strip">
              {summary.data.items.map((i) => (
                <div key={i.key}>
                  <span>{i.name ?? i.key}</span>
                  <strong>{formatYuan(i.netCents)}</strong>
                  <small>
                    元 · 登记 {formatYuan(i.registeredCents)} − 作废 {formatYuan(i.voidedCents)} · {i.count} 笔
                  </small>
                </div>
              ))}
            </div>
          </>
        )
      ) : null}

      {(registerOpen || showPrefill) && canWrite ? (
        <FormDialog
          title={showPrefill ? "登记收款（应收直跳预填）" : "登记收款"}
          eyebrow="PAYMENT RECEIPTS · 创建走弹窗"
          onClose={() => {
            if (showPrefill) {
              setPrefillDismissed(true);
              setSearchParams({}, { replace: true });
            } else {
              setRegisterOpen(false);
            }
          }}
          wide
        >
          <ReceiptRegisterForm
            projects={registerProjects}
            initialProjectId={showPrefill ? prefillProjectId : ""}
            initialAmountYuan={showPrefill && prefillAmountCents ? String(prefillAmountCents / 100) : ""}
            planLink={showPrefill && prefillContractId && prefillPlanId ? { contractId: prefillContractId, planId: prefillPlanId } : null}
            onDone={() => {
              setRegisterOpen(false);
              setPrefillDismissed(true);
              setSearchParams({}, { replace: true });
              toast.success("收款已登记", { description: "金额登记后不可编辑；更正=作废+新登记。" });
            }}
            onError={(msg) => {
              setError(msg);
              toast.error("登记失败", { description: msg });
            }}
          />
        </FormDialog>
      ) : null}

      {voidTarget ? (
        <div className="overlay centered" onMouseDown={(e) => e.target === e.currentTarget && setVoidTarget(null)}>
          <section className="decision-modal compact-modal danger-modal" role="dialog" aria-modal="true" aria-label="作废收款">
            <div className="drawer-head">
              <div>
                <span className="section-label">VOID RECEIPT</span>
                <h2>作废收款（冲正）</h2>
              </div>
              <button className="icon-button" aria-label="关闭" onClick={() => setVoidTarget(null)}>
                ×
              </button>
            </div>
            <p className="context-note">作废后原行保留并冲减口径；需重新登记正确金额。</p>
            <label className="form-field">
              <span>作废理由 *</span>
              <textarea rows={2} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
            </label>
            <button
              className="primary-action full-action"
              disabled={!voidReason.trim() || mutations.voidReceipt.isPending}
              onClick={() => {
                setError(null);
                mutations.voidReceipt.mutate(
                  { id: voidTarget.id, reason: voidReason.trim(), rowVersion: voidTarget.rowVersion },
                  {
                    onSuccess: () => {
                      setVoidTarget(null);
                      setVoidReason("");
                      toast.success("收款已作废冲正", { description: "原行保留留痕，口径自动冲减。" });
                    },
                    onError: (err) => setError(rootErrorMessage(err)),
                  },
                );
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

function ReceiptRegisterForm({
  projects,
  initialProjectId = "",
  initialAmountYuan = "",
  planLink = null,
  onDone,
  onError,
}: {
  projects: { id: string; name: string }[];
  /** 9d-03 应收直跳预填：项目（客户详情解析）/金额（应收带出）/挂合同+计划行（成对） */
  initialProjectId?: string;
  initialAmountYuan?: string;
  planLink?: { contractId: string; planId: string } | null;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const mutations = useReceiptMutations();
  const [pickedProject, setPickedProject] = useState(initialProjectId);
  // 项目清单异步到达（managed ∪ summary 全量），未点选时回落到第一项
  const projectId = pickedProject || projects[0]?.id || "";
  const [amountYuan, setAmountYuan] = useState(initialAmountYuan);
  const [receivedOn, setReceivedOn] = useState(new Date().toISOString().slice(0, 10));
  const [referenceNo, setReferenceNo] = useState("");
  const [payerName, setPayerName] = useState("");
  const [note, setNote] = useState("");

  return (
    <div className="grant-apply-form">
      <p className="context-note">
        项目清单来自 receipts.projectOptions（参照级，全部项目）；登记后金额不可编辑，更正=作废+新登记。
      </p>
      {planLink ? (
        <p className="context-note" style={{ color: "#1d4ed8" }}>
          已挂合同付款计划行：登记成功后该计划行状态写回（paid/partial），并同事务勾稽应收。
        </p>
      ) : null}
      <div className="owner-line">
        <label className="form-field">
          <span>项目 *</span>
          <select value={projectId} onChange={(e) => setPickedProject(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>金额（元）*</span>
          <input type="number" min="0.01" step="0.01" value={amountYuan} onChange={(e) => setAmountYuan(e.target.value)} />
        </label>
        <label className="form-field">
          <span>到账日期 *</span>
          <input type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
        </label>
      </div>
      <div className="owner-line">
        <label className="form-field">
          <span>银行回单/流水号 *</span>
          <input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} />
        </label>
        <label className="form-field">
          <span>付款人</span>
          <input value={payerName} onChange={(e) => setPayerName(e.target.value)} />
        </label>
        <label className="form-field">
          <span>备注</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      <button
        className="primary-action"
        disabled={!projectId || !amountYuan || !receivedOn || !referenceNo.trim() || mutations.create.isPending}
        onClick={() => {
          const amountCents = parseYuanToCents(amountYuan);
          if (!amountCents) return;
          onError("");
          mutations.create.mutate(
            {
              projectId,
              amountCents,
              receivedOn,
              referenceNo: referenceNo.trim(),
              payerName: payerName.trim() || undefined,
              note: note.trim() || undefined,
              idempotencyKey: newIdempotencyKey(),
              ...(planLink ? { contractId: planLink.contractId, planId: planLink.planId } : {}),
            },
            { onSuccess: onDone, onError: (err) => onError(rootErrorMessage(err)) },
          );
        }}
      >
        <Receipt size={15} />
        登记收款
      </button>
    </div>
  );
}
