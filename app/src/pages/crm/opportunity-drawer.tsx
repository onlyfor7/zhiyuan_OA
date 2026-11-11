import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

import { useContractList, useCrmMutations, useCustomer, useFollowupList } from "../../api/crm";
import { formatYuan } from "../../api/reference";
import type { RouterOutputs } from "../../lib/trpc";
import { useUserNameMap } from "./shared";
import { CRM_CONTRACT_STATUS_LABEL, OPPORTUNITY_STAGE_LABEL, OPPORTUNITY_STAGES } from "../../lib/labels";
import { FormDialog } from "../../components/FormDialog";
import { UserPicker } from "../../components/UserPicker";
import { DomainIconBlock } from "../../lib/DomainIconBlock";
import { rootErrorMessage } from "../../lib/form";

export type OppRow = RouterOutputs["crm"]["opportunities"]["list"]["items"][number];

const amountOf = (o: OppRow): number | null => ("expectedAmountCents" in o && o.expectedAmountCents != null ? (o.expectedAmountCents as number) : null);

/**
 * 商机详情抽屉（arch/12 §18.4）：查看全字段 + 编辑（名称/阶段/金额/赢率/负责人；
 * update 走既有 opportunities.update，阶段即时走 setStage，均审计同事务）+ 关联合同区 +
 * 跟进/备注记录区（followups 多态）。终态（won/lost）整体只读；备注以跟进记录留存（表无 remark 列）。
 */
export function OpportunityDrawer({ opp, onClose }: { opp: OppRow; onClose: () => void }) {
  const m = useCrmMutations();
  const nameOf = useUserNameMap();
  const customer = useCustomer(opp.customerId);
  const followups = useFollowupList("opportunity", opp.id);
  const contracts = useContractList({ customerId: opp.customerId, limit: 100 });
  const editable = !["won", "lost"].includes(opp.stage);
  const canSeeAmount = "expectedAmountCents" in opp;
  const linked = (contracts.data?.items ?? []).filter((c) => c.opportunityId === opp.id || c.id === opp.wonContractId);
  const [form, setForm] = useState(() => ({
    name: opp.name,
    amountYuan: amountOf(opp) != null ? String((amountOf(opp) as number) / 100) : "",
    winRate: opp.winRate != null ? String(opp.winRate) : "",
    ownerId: opp.ownerId ?? "",
  }));
  const [stage, setStage] = useState(opp.stage);
  const [rv, setRv] = useState(opp.rowVersion);
  const [followText, setFollowText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const dirty =
    form.name.trim() !== opp.name ||
    form.amountYuan !== (amountOf(opp) != null ? String((amountOf(opp) as number) / 100) : "") ||
    form.winRate !== (opp.winRate != null ? String(opp.winRate) : "") ||
    (form.ownerId || null) !== opp.ownerId;

  const onStageChange = (next: string) => {
    if (next === stage) return;
    setError(null);
    m.setStage.mutate(
      { id: opp.id, rowVersion: rv, stage: next as never },
      {
        onSuccess: (row) => {
          toast.success(`阶段已变更：${OPPORTUNITY_STAGE_LABEL[next] ?? next}`);
          setStage(row.stage);
          setRv(row.rowVersion);
        },
        onError: (err) => setError(rootErrorMessage(err)),
      },
    );
  };

  const addFollow = () => {
    setError(null);
    if (!followText.trim()) return;
    m.createFollowup.mutate(
      { targetType: "opportunity", targetId: opp.id, content: followText.trim() },
      {
        onSuccess: () => { toast.success("跟进/备注已记录"); setFollowText(""); },
        onError: (err) => setError(rootErrorMessage(err)),
      },
    );
  };

  return (
    <FormDialog title={opp.name} eyebrow={`CRM · 商机详情 · ${opp.code}`} onClose={onClose} wide>
      <div className="p9a-drawer-body">
        <p className="context-note">
          阶段：{OPPORTUNITY_STAGE_LABEL[stage] ?? stage}{!editable ? "（终态只读）" : ""} · 所属客户：{customer.data?.customer.name ?? "加载中…"}
          {customer.data ? <> · <Link className="text-action" to={`/crm/customers/${opp.customerId}`}>查看客户档案 →</Link></> : null}
        </p>
        <div className="p9a-field-grid two">
          <label className="form-field"><span>商机编号</span><input value={opp.code} disabled /></label>
          <label className="form-field"><span>创建 / 最近更新</span>
            <input
              value={`${opp.createdAt.slice(0, 16).replace("T", " ")}（${nameOf(opp.createdBy)}）→ ${opp.updatedAt.slice(0, 16).replace("T", " ")}（${nameOf(opp.updatedBy)}）`}
              disabled
            /></label>
          <label className="form-field"><span>商机名称 *</span>
            <input value={form.name} disabled={!editable} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></label>
          <label className="form-field"><span>阶段（即时生效，审计留痕）</span>
            <select value={stage} disabled={!editable} onChange={(e) => onStageChange(e.target.value)}>
              {([...OPPORTUNITY_STAGES, ["won", "赢单"], ["lost", "输单"]] as const).map(([s, l]) => (
                <option key={s} value={s}>{l}{["won", "lost"].includes(s) ? "（须走赢单/输单流程）" : ""}</option>
              ))}
            </select></label>
          <label className="form-field"><span>预计金额（元）{canSeeAmount ? "" : "（无财务权限不可见）"}</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.amountYuan}
              disabled={!editable || !canSeeAmount}
              onChange={(e) => setForm((f) => ({ ...f, amountYuan: e.target.value }))}
            /></label>
          <label className="form-field"><span>赢率（%）</span>
            <input
              type="number"
              min="0"
              max="100"
              value={form.winRate}
              disabled={!editable}
              onChange={(e) => setForm((f) => ({ ...f, winRate: e.target.value }))}
            /></label>
          <div className="form-field"><span>负责人</span>
            {editable ? (
              <UserPicker value={form.ownerId} onChange={(userId) => setForm((f) => ({ ...f, ownerId: userId }))} placeholder="搜索新负责人" />
            ) : (
              <input value={nameOf(opp.ownerId)} disabled />
            )}
          </div>
          <label className="form-field"><span>赢单合同</span>
            <input value={opp.wonContractId ? "已挂合同（见关联合同区）" : "—"} disabled /></label>
        </div>

        <span className="section-label">关联合同（{linked.length}）</span>
        {contracts.isPending ? <p className="list-note">合同加载中…</p> : null}
        {contracts.data && linked.length === 0 ? <p className="list-note">该商机暂无关联合同（赢单时挂合同）。</p> : null}
        {linked.map((c) => (
          <div className="p9a-schedule-row" key={c.id}>
            <DomainIconBlock domain="finance" size={22} iconSize={13} />
            <div className="p9a-queue-main">
              <strong>{c.title}{c.id === opp.wonContractId ? "（赢单合同）" : ""}</strong>
              <small>
                {c.code} · {"amountCents" in c && c.amountCents != null ? `${formatYuan(c.amountCents as number)} 元` : "金额—"}
                {"cumulativeReceivedCents" in c && c.cumulativeReceivedCents != null ? ` · 已回款 ${formatYuan(c.cumulativeReceivedCents as number)} 元` : ""}
                {" · "}{CRM_CONTRACT_STATUS_LABEL[c.status] ?? c.status}
              </small>
            </div>
            <span className={`badge ${c.status === "active" ? "badge-health-normal" : c.status === "draft" ? "badge-minutes-pending_confirm" : ""}`}>
              {CRM_CONTRACT_STATUS_LABEL[c.status] ?? c.status}
            </span>
          </div>
        ))}

        <span className="section-label">跟进 / 备注记录（{followups.data?.length ?? 0}）</span>
        {followups.isPending ? <p className="list-note">跟进记录加载中…</p> : null}
        {followups.data && followups.data.length === 0 ? <p className="list-note">暂无跟进/备注；备注以跟进记录形式留存（商机表无独立备注列）。</p> : null}
        {(followups.data ?? []).map((f) => (
          <div className="p9a-schedule-row" key={f.id}>
            <DomainIconBlock domain="opportunity" size={22} iconSize={13} />
            <div className="p9a-queue-main">
              <strong>{f.content}</strong>
              <small>{f.createdAt.slice(0, 16).replace("T", " ")}{f.nextAt ? ` · 下次跟进 ${f.nextAt.slice(0, 16).replace("T", " ")}` : ""} · {nameOf(f.createdBy)}</small>
            </div>
          </div>
        ))}
        <div className="owner-line" style={{ marginTop: 8 }}>
          <input value={followText} placeholder="写跟进/备注…" aria-label="跟进或备注内容" onChange={(e) => setFollowText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addFollow(); }} />
          <button className="secondary-action" onClick={addFollow} disabled={!followText.trim() || m.createFollowup.isPending}>
            记录
          </button>
        </div>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
      </div>
      <div className="p9a-modal-foot">
        <span>口径：名称/金额/赢率/负责人走 opportunities.update；阶段即时走 setStage（均审计同事务，rowVersion 冲突请刷新）。</span>
        <div className="row-ops">
          <button className="secondary-action" onClick={onClose}>关闭</button>
          {editable ? (
            <button
              className="primary-action"
              disabled={!dirty || !form.name.trim() || m.updateOpportunity.isPending}
              onClick={() => {
                setError(null);
                const amountCents = form.amountYuan.trim() ? Math.round(Number(form.amountYuan) * 100) : null;
                const winRate = form.winRate.trim() ? Math.max(0, Math.min(100, Math.round(Number(form.winRate)))) : null;
                m.updateOpportunity.mutate(
                  {
                    id: opp.id,
                    rowVersion: rv,
                    name: form.name.trim(),
                    ...(canSeeAmount ? { expectedAmountCents: amountCents && amountCents > 0 ? amountCents : null } : {}),
                    winRate,
                    ownerId: form.ownerId || null,
                  },
                  {
                    onSuccess: (row) => {
                      toast.success("商机已更新");
                      const amt = "expectedAmountCents" in row && row.expectedAmountCents != null ? (row.expectedAmountCents as number) : null;
                      setForm({ name: row.name, amountYuan: amt != null ? String(amt / 100) : form.amountYuan, winRate: row.winRate != null ? String(row.winRate) : "", ownerId: row.ownerId ?? "" });
                      setRv(row.rowVersion);
                    },
                    onError: (err) => setError(rootErrorMessage(err)),
                  },
                );
              }}
            >
              保存修改
            </button>
          ) : null}
        </div>
      </div>
    </FormDialog>
  );
}
