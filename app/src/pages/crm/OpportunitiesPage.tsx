import { useRef, useState } from "react";
import { toast } from "sonner";

import { useCrmMutations, useOpportunityList } from "../../api/crm";
import { FormDialog } from "../../components/FormDialog";
import { DomainIconBlock } from "../../lib/DomainIconBlock";
import { ListSkeleton } from "../../components/feedback";
import { formatYuan } from "../../api/reference";
import { rootErrorMessage } from "../../lib/form";

const STAGES = [
  ["initial", "初步接触"],
  ["needs", "需求确认"],
  ["proposal", "方案报价"],
  ["negotiation", "商务谈判"],
] as const;
const STAGE_LABEL = Object.fromEntries([...STAGES, ["won", "赢单"], ["lost", "输单"]] as const as Array<[string, string]>);

/** 客户组·商机管理（arch/12 §6.4：T-A 表格/看板切换；看板五列，拖拽改阶段=setStage 落库+审计） */
export default function OpportunitiesPage() {
  const [view, setView] = useState<"table" | "board">("table");
  const list = useOpportunityList({});
  const m = useCrmMutations();
  const [wonTarget, setWonTarget] = useState<{ id: string; rowVersion: number; name: string } | null>(null);
  const [lostTarget, setLostTarget] = useState<{ id: string; rowVersion: number; name: string } | null>(null);
  const [lostReason, setLostReason] = useState("");
  const dragOppRef = useRef<{ id: string; rowVersion: number; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (list.isPending) return <ListSkeleton rows={6} />;
  if (list.isError) throw list.error;
  const items = list.data.items;

  const doSetStage = (opp: { id: string; rowVersion: number; name: string }, stage: string) => {
    setError(null);
    m.setStage.mutate(
      { id: opp.id, rowVersion: opp.rowVersion, stage: stage as never },
      {
        onSuccess: () => toast.success(`「${opp.name}」已移动到${STAGE_LABEL[stage]}`),
        onError: (err) => setError(rootErrorMessage(err)),
      },
    );
  };

  return (
    <div className="screen crm-opps-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">CRM · OPPORTUNITIES</span>
          <h1>商机管理</h1>
          <p>阶段机 initial→needs→proposal→negotiation→won/lost；看板拖拽改阶段（审计留痕）。</p>
        </div>
        <div className="p9a-mini-tabs" role="tablist">
          <button role="tab" aria-selected={view === "table"} className={view === "table" ? "active" : ""} onClick={() => setView("table")}>
            表格
          </button>
          <button role="tab" aria-selected={view === "board"} className={view === "board" ? "active" : ""} onClick={() => setView("board")}>
            看板
          </button>
        </div>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      {view === "table" ? (
        <>
          <div className="p9a-ta-table" style={{ gridTemplateRows: "40px minmax(0,1fr)" }}>
            <div className="p9a-ta-head p9a-ta-row" style={{ gridTemplateColumns: "120px 1.6fr 110px 130px 90px 110px 150px" }}>
              <span>编号</span><span>商机</span><span>阶段</span><span>预计金额</span><span>赢率</span><span>更新</span><span />
            </div>
            <div className="p9a-ta-body">
              {items.map((o) => (
                <div className="p9a-ta-row" key={o.id} style={{ gridTemplateColumns: "120px 1.6fr 110px 130px 90px 110px 150px" }}>
                  <span className="mono">{o.code}</span>
                  <strong>{o.name}</strong>
                  <span>
                    <i className={`p9a-dot ${o.stage === "won" ? "ok" : o.stage === "lost" ? "" : "warn"}`} style={o.stage === "lost" ? { background: "#9ca5b3" } : undefined} />
                    {STAGE_LABEL[o.stage] ?? o.stage}
                  </span>
                  <span className="mono">{"expectedAmountCents" in o && o.expectedAmountCents != null ? `${formatYuan(o.expectedAmountCents as number)} 元` : "—"}</span>
                  <span className="mono">{o.winRate ?? "—"}%</span>
                  <span className="mono" style={{ fontSize: 10 }}>{o.updatedAt.slice(5, 16).replace("T", " ")}</span>
                  <span className="p9a-row-actions">
                    {(["initial", "needs", "proposal", "negotiation"] as const).filter((s) => s !== o.stage).slice(0, 2).map((s) => (
                      <button key={s} className="text-action" onClick={() => doSetStage(o, s)}>
                        →{STAGE_LABEL[s]}
                      </button>
                    ))}
                    {o.stage === "negotiation" ? (
                      <>
                        <button className="text-action" onClick={() => setWonTarget(o)}>赢单</button>
                        <button className="text-action" onClick={() => setLostTarget(o)}>输单</button>
                      </>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="crm-board">
          {[...STAGES.map(([s, l]) => [s, l] as const), ["won", "赢单"] as const, ["lost", "输单"] as const].map(([stage, label]) => {
            const col = items.filter((o) => o.stage === stage);
            const readonly = stage === "won" || stage === "lost";
            return (
              <section
                className="crm-board-col"
                key={stage}
                onDragOver={(e) => !readonly && e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const opp = dragOppRef.current;
                  if (readonly || !opp) return;
                  dragOppRef.current = null;
                  doSetStage(opp, stage);
                }}
              >
                <div className="crm-board-head">
                  <strong>{label}</strong>
                  <span className="count-badge neutral">{col.length}</span>
                </div>
                {col.map((o) => (
                  <div
                    className="crm-board-card"
                    key={o.id}
                    draggable={!readonly}
                    onDragStart={() => { dragOppRef.current = o; }}
                  >
                    <DomainIconBlock domain="opportunity" size={24} iconSize={14} />
                    <div className="p9a-queue-main">
                      <strong>{o.name}</strong>
                      <small>
                        {o.code}
                        {"expectedAmountCents" in o && o.expectedAmountCents != null ? ` · ${formatYuan(o.expectedAmountCents as number)} 元` : ""}
                        {o.winRate != null ? ` · 赢率 ${o.winRate}%` : ""}
                      </small>
                    </div>
                  </div>
                ))}
                {col.length === 0 ? <p className="crm-board-empty">拖卡片到此列</p> : null}
              </section>
            );
          })}
        </div>
      )}

      {wonTarget ? (
        <FormDialog title={`赢单 · ${wonTarget.name}`} eyebrow="CRM · 赢单挂合同（同事务）" onClose={() => setWonTarget(null)}>
          <p className="context-note">赢单必须挂合同：提交后同事务建合同草稿（可勾选直接激活）并置商机为 won。</p>
          <WonForm opp={wonTarget} onDone={() => setWonTarget(null)} />
        </FormDialog>
      ) : null}
      {lostTarget ? (
        <FormDialog title={`输单 · ${lostTarget.name}`} eyebrow="CRM · 高危确认" onClose={() => setLostTarget(null)}>
          <label className="form-field"><span>输单原因 *</span>
            <textarea rows={2} value={lostReason} onChange={(e) => setLostReason(e.target.value)} /></label>
          <div className="drawer-actions">
            <button className="secondary-action" onClick={() => setLostTarget(null)}>取消</button>
            <button className="danger-action" disabled={!lostReason.trim() || m.markLost.isPending}
              onClick={() => {
                setError(null);
                m.markLost.mutate(
                  { id: lostTarget.id, rowVersion: lostTarget.rowVersion, reason: lostReason.trim() },
                  { onSuccess: () => { toast.success("已标记输单"); setLostTarget(null); setLostReason(""); }, onError: (err) => { setError(rootErrorMessage(err)); setLostTarget(null); } },
                );
              }}>
              确认输单
            </button>
          </div>
        </FormDialog>
      ) : null}
    </div>
  );
}

function WonForm({ opp, onDone }: { opp: { id: string; rowVersion: number; name: string }; onDone: () => void }) {
  const m = useCrmMutations();
  const [title, setTitle] = useState(`${opp.name} 合同`);
  const [amountYuan, setAmountYuan] = useState("");
  const [signedAt, setSignedAt] = useState(new Date().toISOString().slice(0, 10));
  const [activate, setActivate] = useState(true);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <label className="form-field"><span>合同标题 *</span><input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      <div className="owner-line">
        <label className="form-field"><span>合同金额（元）*</span>
          <input type="number" min="0.01" step="0.01" value={amountYuan} onChange={(e) => setAmountYuan(e.target.value)} /></label>
        <label className="form-field"><span>签约日期</span>
          <input type="date" value={signedAt} onChange={(e) => setSignedAt(e.target.value)} /></label>
      </div>
      <label className="check-field">
        <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
        直接激活（active 后进入回款勾稽）
      </label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="drawer-actions">
        <button className="secondary-action" onClick={onDone}>取消</button>
        <button className="primary-action" disabled={!title.trim() || !amountYuan || m.markWon.isPending}
          onClick={() => {
            setError(null);
            m.markWon.mutate(
              {
                id: opp.id,
                rowVersion: opp.rowVersion,
                contract: { title: title.trim(), amountCents: Math.round(Number(amountYuan) * 100), signedAt, activate },
              },
              { onSuccess: () => { toast.success("已赢单并创建合同"); onDone(); }, onError: (err) => setError(rootErrorMessage(err)) },
            );
          }}>
          确认赢单
        </button>
      </div>
    </>
  );
}
