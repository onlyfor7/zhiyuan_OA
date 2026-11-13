import { useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

import { useCrmMutations, useCustomerList, useOpportunityList } from "../../api/crm";
import { useUserNameMap } from "./shared";
import { OPPORTUNITY_STAGE_LABEL, OPPORTUNITY_STAGES } from "../../lib/labels";
import { OpportunityDrawer } from "./opportunity-drawer";
import { FormDialog } from "../../components/FormDialog";
import { UserPicker } from "../../components/UserPicker";
import { DomainIconBlock } from "../../lib/DomainIconBlock";
import { ListSkeleton } from "../../components/feedback";
import { formatYuan } from "../../api/reference";
import { rootErrorMessage } from "../../lib/form";

/** 新建商机（arch/13 §5.3：客户+PM 必填+售前可选+幂等键开表单一次生成，重试沿用） */
function OpportunityCreateDialog({ onClose }: { onClose: () => void }) {
  const m = useCrmMutations();
  const customers = useCustomerList({});
  const [customerId, setCustomerId] = useState("");
  const [name, setName] = useState("");
  const [amountYuan, setAmountYuan] = useState("");
  const [winRate, setWinRate] = useState(30);
  const [pmId, setPmId] = useState("");
  const [presalesId, setPresalesId] = useState("");
  const [idemKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog title="新建商机" eyebrow="CRM · 商机成立即立项（同事务/幂等）" onClose={onClose}>
      <label className="form-field"><span>客户 *（仅列当前可见范围）</span>
        <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
          <option value="">请选择客户</option>
          {(customers.data?.items ?? []).map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select></label>
      <label className="form-field"><span>商机名称 *</span>
        <input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="owner-line">
        <label className="form-field"><span>预计金额（元，选填）</span>
          <input type="number" min="0" step="0.01" value={amountYuan} onChange={(e) => setAmountYuan(e.target.value)} /></label>
        <label className="form-field"><span>赢率（%）</span>
          <input type="number" min="0" max="100" value={winRate} onChange={(e) => setWinRate(Number(e.target.value))} /></label>
      </div>
      <div className="form-field"><span>项目负责人 *（落 project_members(manager)）</span>
        <UserPicker value={pmId} onChange={setPmId} placeholder="搜索项目负责人" /></div>
      <div className="form-field"><span>售前（可选）</span>
        <UserPicker value={presalesId} onChange={setPresalesId} placeholder="搜索售前" /></div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="drawer-actions">
        <button className="secondary-action" onClick={onClose}>取消</button>
        <button
          className="primary-action"
          disabled={!customerId || !name.trim() || !pmId || m.createOpportunity.isPending}
          onClick={() => {
            setError(null);
            m.createOpportunity.mutate(
              {
                customerId,
                name: name.trim(),
                expectedAmountCents: amountYuan ? Math.round(Number(amountYuan) * 100) : null,
                winRate,
                presalesId: presalesId || null,
                projectManagerId: pmId,
                idempotencyKey: idemKey,
              },
              { onSuccess: () => { toast.success("商机已创建：项目已同事务建立（售前阶段+首版计划）"); onClose(); }, onError: (err) => setError(rootErrorMessage(err)) },
            );
          }}
        >
          创建商机
        </button>
      </div>
    </FormDialog>
  );
}

/** 客户组·商机管理（arch/12 §6.4 + §18.4 + arch/13 §5：T-A 表格/看板切换；表格行点击开详情抽屉（?opp= 深链）；看板拖拽改阶段=setStage 落库+审计） */
export default function OpportunitiesPage() {
  const [view, setView] = useState<"table" | "board">("table");
  const list = useOpportunityList({});
  const m = useCrmMutations();
  const nameOf = useUserNameMap();
  const [sp, setSp] = useSearchParams();
  const openOppId = sp.get("opp");
  const [wonTarget, setWonTarget] = useState<{ id: string; rowVersion: number; name: string } | null>(null);
  const [lostTarget, setLostTarget] = useState<{ id: string; rowVersion: number; name: string } | null>(null);
  const [lostReason, setLostReason] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const dragOppRef = useRef<{ id: string; rowVersion: number; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (list.isPending) return <ListSkeleton rows={6} />;
  if (list.isError) throw list.error;
  const items = list.data.items;
  const openOpp = openOppId ? items.find((o) => o.id === openOppId) ?? null : null;

  const doSetStage = (opp: { id: string; rowVersion: number; name: string }, stage: string) => {
    setError(null);
    m.setStage.mutate(
      { id: opp.id, rowVersion: opp.rowVersion, stage: stage as never },
      {
        onSuccess: () => toast.success(`「${opp.name}」已移动到${OPPORTUNITY_STAGE_LABEL[stage]}`),
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
          <p>阶段机 initial→needs→proposal→negotiation→won/lost；表格行点击开详情抽屉（查看+编辑+合同+跟进），看板拖拽改阶段（审计留痕）。</p>
        </div>
        <div className="row-ops">
          <button className="primary-action" onClick={() => setCreateOpen(true)}>新建商机</button>
          <div className="p9a-mini-tabs" role="tablist">
            <button role="tab" aria-selected={view === "table"} className={view === "table" ? "active" : ""} onClick={() => setView("table")}>
              表格
            </button>
            <button role="tab" aria-selected={view === "board"} className={view === "board" ? "active" : ""} onClick={() => setView("board")}>
              看板
            </button>
          </div>
        </div>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      {view === "table" ? (
        <>
          <div className="p9a-ta-table" style={{ gridTemplateRows: "40px minmax(0,1fr)" }}>
            <div className="p9a-ta-head p9a-ta-row" style={{ gridTemplateColumns: "110px 1.4fr 100px 110px 80px 90px 100px 130px" }}>
              <span>编号</span><span>商机</span><span>阶段</span><span>预计金额</span><span>赢率</span><span>负责人</span><span>更新</span><span />
            </div>
            <div className="p9a-ta-body">
              {items.length === 0 ? <p className="list-note" style={{ padding: "16px 12px" }}>当前范围内暂无商机（arch/13 §4：仅列本人/管辖树/指派/全局范围）。</p> : null}
              {items.map((o) => (
                <div
                  className="p9a-ta-row is-clickable"
                  key={o.id}
                  style={{ gridTemplateColumns: "110px 1.4fr 100px 110px 80px 90px 100px 130px" }}
                  title="点击打开详情抽屉"
                  onClick={() => setSp({ opp: o.id })}
                >
                  <span className="mono">{o.code}</span>
                  <strong>{o.name}</strong>
                  <span>
                    <i className={`p9a-dot ${o.stage === "won" ? "ok" : o.stage === "lost" ? "" : "warn"}`} style={o.stage === "lost" ? { background: "#9ca5b3" } : undefined} />
                    {OPPORTUNITY_STAGE_LABEL[o.stage] ?? o.stage}
                  </span>
                  <span className="mono">{"expectedAmountCents" in o && o.expectedAmountCents != null ? `${formatYuan(o.expectedAmountCents as number)} 元` : "—"}</span>
                  <span className="mono">{o.winRate ?? "—"}%</span>
                  <span>{nameOf(o.ownerId)}</span>
                  <span className="mono" style={{ fontSize: 10 }}>{o.updatedAt.slice(5, 16).replace("T", " ")}</span>
                  <span className="p9a-row-actions" onClick={(e) => e.stopPropagation()}>
                    {(["initial", "needs", "proposal", "negotiation"] as const).filter((s) => s !== o.stage).slice(0, 2).map((s) => (
                      <button key={s} className="text-action" onClick={() => doSetStage(o, s)}>
                        →{OPPORTUNITY_STAGE_LABEL[s]}
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
          {[...OPPORTUNITY_STAGES.map(([s, l]) => [s, l] as const), ["won", "赢单"] as const, ["lost", "输单"] as const].map(([stage, label]) => {
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

      {createOpen ? <OpportunityCreateDialog onClose={() => setCreateOpen(false)} /> : null}
      {openOppId && openOpp ? <OpportunityDrawer key={openOpp.id} opp={openOpp} onClose={() => setSp({})} /> : null}
      {openOppId && !openOpp ? (
        <FormDialog title="商机详情" eyebrow="CRM · OPPORTUNITIES" onClose={() => setSp({})}>
          <p className="context-note">未在当前列表找到该商机（可能不在此筛选范围内）。请调整筛选后重试。</p>
          <div className="drawer-actions">
            <button className="secondary-action" onClick={() => setSp({})}>关闭</button>
          </div>
        </FormDialog>
      ) : null}
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
