import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Check, CheckCircle2, ChevronRight, CircleAlert, Plus, Send, X } from "lucide-react";

import { useDecision, useDecisionList, useDecisionMutations } from "../api/decision";
import { useProjectMembers } from "../api/project";
import { useMe } from "../api/auth";
import { rootErrorMessage } from "../lib/form";
import { DECISION_OPTION_LABEL, DECISION_STATUS_LABEL } from "../lib/labels";
import type { RouterOutputs } from "../lib/trpc";

type DecisionRow = RouterOutputs["decision"]["list"]["items"][number];

interface OptionValue {
  key: string;
  summary: string;
  impact: string;
  risk: string;
}

const OPTION_KEYS = ["delay", "add_staff", "scope_reduce", "phased_delivery", "risk_accept", "other"];

/** 决策单详情工作区：方案比较 + 双意见 + 最终决定/验证（arch/04 §2.6） */
function DecisionDetail({ id }: { id: string }) {
  const decision = useDecision(id);
  if (decision.isPending) return <p className="list-note">正在加载决策单…</p>;
  if (decision.isError) throw decision.error;
  // key 保证切换决策单时表单状态重置
  return <DecisionDetailInner key={decision.data.id} d={decision.data} />;
}

type DecisionDetailData = RouterOutputs["decision"]["getById"];

function DecisionDetailInner({ d }: { d: DecisionDetailData }) {
  const mutations = useDecisionMutations();
  const members = useProjectMembers(d.projectId);
  const [pmOpinion, setPmOpinion] = useState("");
  const [qualityOpinion, setQualityOpinion] = useState("");
  const [finalOption, setFinalOption] = useState(d.finalOption ?? "");
  const [finalReason, setFinalReason] = useState(d.finalReason ?? "");
  const [conditions, setConditions] = useState(d.conditions ?? "");
  const initialCheckpoints = (() => {
    const cps = (d.checkpoints ?? null) as { point: string; date: string; owner_id: string }[] | null;
    return cps && cps.length > 0
      ? cps.map((c) => ({ point: c.point, date: c.date, ownerId: c.owner_id }))
      : [{ point: "", date: "", ownerId: "" }];
  })();
  const [checkpoints, setCheckpoints] = useState(initialCheckpoints);
  const [verifyNote, setVerifyNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const options = (d.options ?? []) as unknown as OptionValue[];
  const decided = d.status === "decided" || d.status === "verified";

  return (
    <section className="decision-detail">
      <div className="decision-detail-head">
        <div>
          <span className="section-label">
            {d.code} · {DECISION_STATUS_LABEL[d.status]}
            {d.sourceType ? ` · 来源 ${d.sourceType}` : ""}
          </span>
          <h2>{d.title}</h2>
        </div>
        <span className={`issue-status ${d.status === "verified" ? "status-closed" : "status-待复核"}`}>
          {DECISION_STATUS_LABEL[d.status]}
        </span>
      </div>
      <div className="conflict-summary">
        <CircleAlert size={20} />
        <p>{d.context}</p>
      </div>
      <span className="section-label">OPTIONS · 方案比较</span>
      <div className="decision-options">
        {options.map((o) => (
          <div key={o.key} className={d.finalOption === o.key ? "selected readonly" : ""}>
            <div>
              <span>方案 · {DECISION_OPTION_LABEL[o.key] ?? o.key}</span>
              {d.finalOption === o.key ? <CheckCircle2 size={17} /> : null}
            </div>
            <strong>{o.summary}</strong>
            <p>{o.impact}</p>
            <small>风险：{o.risk || "—"}</small>
          </div>
        ))}
      </div>
      <span className="section-label">OPINIONS · 双意见</span>
      <div className="opinion-grid">
        <div>
          <span>项目负责人意见</span>
          <p>{d.pmOpinion ?? "未提交"}</p>
        </div>
        <div>
          <span>质量负责人意见</span>
          <p>{d.qualityOpinion ?? "未提交"}</p>
        </div>
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {!decided ? (
        <div className="decision-forms">
          <span className="section-label">SUBMIT OPINIONS · 按角色各写各的（服务端按身份落位）</span>
          <div className="owner-line">
            <label className="form-field">
              <span>项目负责人意见</span>
              <textarea rows={2} value={pmOpinion} onChange={(e) => setPmOpinion(e.target.value)} />
            </label>
            <label className="form-field">
              <span>质量负责人意见</span>
              <textarea rows={2} value={qualityOpinion} onChange={(e) => setQualityOpinion(e.target.value)} />
            </label>
          </div>
          <button
            className="secondary-action"
            disabled={(!pmOpinion.trim() && !qualityOpinion.trim()) || mutations.submitOpinions.isPending}
            onClick={() => {
              setError(null);
              mutations.submitOpinions.mutate(
                {
                  id: d.id,
                  pmOpinion: pmOpinion.trim() || undefined,
                  qualityOpinion: qualityOpinion.trim() || undefined,
                },
                {
                  onSuccess: () => {
                    setPmOpinion("");
                    setQualityOpinion("");
                  },
                  onError: (err) => setError(rootErrorMessage(err)),
                },
              );
            }}
          >
            <Send size={15} />
            提交意见
          </button>

          <span className="section-label">FINAL DECISION · 最终决定（四项必填）</span>
          <div className="owner-line">
            <label className="form-field">
              <span>最终方案 *</span>
              <select value={finalOption} onChange={(e) => setFinalOption(e.target.value)}>
                <option value="">选择方案</option>
                {options.map((o) => (
                  <option key={o.key} value={o.key}>
                    {DECISION_OPTION_LABEL[o.key] ?? o.key} · {o.summary.slice(0, 20)}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field span-2">
              <span>决定理由 *</span>
              <textarea rows={2} value={finalReason} onChange={(e) => setFinalReason(e.target.value)} />
            </label>
            <label className="form-field span-2">
              <span>附加条件 *</span>
              <textarea rows={2} value={conditions} onChange={(e) => setConditions(e.target.value)} />
            </label>
          </div>
          <div className="form-field">
            <span>执行检查点 *（决定通过后自动生成任务）</span>
            {checkpoints.map((cp, idx) => (
              <div className="measure-row" key={idx}>
                <input
                  value={cp.point}
                  placeholder="检查点内容"
                  aria-label="检查点"
                  onChange={(e) => setCheckpoints((prev) => prev.map((x, i) => (i === idx ? { ...x, point: e.target.value } : x)))}
                />
                <input
                  type="date"
                  value={cp.date}
                  aria-label="检查点日期"
                  onChange={(e) => setCheckpoints((prev) => prev.map((x, i) => (i === idx ? { ...x, date: e.target.value } : x)))}
                />
                <select
                  value={cp.ownerId}
                  aria-label="检查点责任人"
                  onChange={(e) => setCheckpoints((prev) => prev.map((x, i) => (i === idx ? { ...x, ownerId: e.target.value } : x)))}
                >
                  <option value="">责任人</option>
                  {(members.data ?? []).map((m) => (
                    <option key={m.userId} value={m.userId}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <button
                  className="icon-button"
                  aria-label="删除检查点"
                  onClick={() => setCheckpoints((prev) => prev.filter((_, i) => i !== idx))}
                >
                  <X size={15} />
                </button>
              </div>
            ))}
            <button className="secondary-action" onClick={() => setCheckpoints((prev) => [...prev, { point: "", date: "", ownerId: "" }])}>
              添加检查点
            </button>
          </div>
          <div className="decision-submit">
            <p>决定后将生成检查点任务并通知相关人；决定永久留痕不可回退。</p>
            <button
              className="primary-action"
              disabled={
                !finalOption ||
                !finalReason.trim() ||
                !conditions.trim() ||
                checkpoints.some((c) => !c.point.trim() || !c.date || !c.ownerId) ||
                mutations.decide.isPending
              }
              onClick={() => {
                setError(null);
                mutations.decide.mutate(
                  {
                    id: d.id,
                    finalOption,
                    finalReason: finalReason.trim(),
                    conditions: conditions.trim(),
                    checkpoints: checkpoints.map((c) => ({ point: c.point.trim(), date: c.date, owner_id: c.ownerId })),
                    rowVersion: d.rowVersion,
                  },
                  { onError: (err) => setError(rootErrorMessage(err)) },
                );
              }}
            >
              <Check size={16} />
              确认最终决定
            </button>
          </div>
        </div>
      ) : (
        <div className="decision-executing">
          <CheckCircle2 size={19} />
          <div>
            <strong>已决定：{DECISION_OPTION_LABEL[d.finalOption ?? ""] ?? d.finalOption}</strong>
            <p>理由：{d.finalReason}</p>
            <p>条件：{d.conditions}</p>
            {d.decidedAt ? <small>决定时间 {d.decidedAt.slice(0, 16).replace("T", " ")}</small> : null}
          </div>
        </div>
      )}

      {d.status === "decided" ? (
        <div className="issue-section">
          <span>执行验证</span>
          <textarea rows={2} value={verifyNote} placeholder="验证说明（必填）" onChange={(e) => setVerifyNote(e.target.value)} />
          <button
            className="primary-action"
            disabled={!verifyNote.trim() || mutations.verify.isPending}
            onClick={() => {
              setError(null);
              mutations.verify.mutate(
                { id: d.id, note: verifyNote.trim() },
                {
                  onSuccess: () => setVerifyNote(""),
                  onError: (err) => setError(rootErrorMessage(err)),
                },
              );
            }}
          >
            确认执行验证
          </button>
        </div>
      ) : null}
      {d.status === "verified" ? (
        <div className="decision-executing">
          <CheckCircle2 size={19} />
          <div>
            <strong>执行已验证</strong>
            <p>{d.verificationNote}</p>
            {d.verifiedAt ? <small>{d.verifiedAt.slice(0, 16).replace("T", " ")}</small> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** 决策中心（项目页签与全局决策中心共用）：队列 + 工作区 */
export function DecisionCenter({ projectId }: { projectId?: string }) {
  const list = useDecisionList(projectId ? { projectId } : {});
  const [status, setStatus] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const navigate = useNavigate();
  const filtered = list.data?.items.filter((i) => !status || i.status === status);

  if (list.isPending) return <p className="list-note">正在加载决策单…</p>;
  if (list.isError) throw list.error;

  return (
    <div className={projectId ? "space-tab-body" : "screen decision-screen"}>
      {!projectId ? (
        <div className="screen-heading">
          <div>
            <span className="eyebrow">DECISION CENTER</span>
            <h1>重要取舍，应当被认真记录。</h1>
            <p>比较方案、明确条件、跟踪执行，而不是只留下一句“同意”。</p>
          </div>
          <Link to="/decisions/new" className="primary-action">
            <Plus size={15} />
            新建决策单
          </Link>
        </div>
      ) : (
        <div className="quality-toolbar">
          <select value={status} aria-label="决策状态" onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部状态</option>
            <option value="draft">草稿</option>
            <option value="deciding">决策中</option>
            <option value="decided">已决定</option>
            <option value="verified">已验证</option>
          </select>
          <span>{filtered?.length ?? 0} 项</span>
          <button className="primary-action" onClick={() => navigate(`/decisions/new?projectId=${projectId}`)}>
            <Plus size={15} />
            新建决策单
          </button>
        </div>
      )}
      {!projectId ? (
        <div className="quality-toolbar">
          <select value={status} aria-label="决策状态" onChange={(e) => setStatus(e.target.value)}>
            <option value="">全部状态</option>
            <option value="draft">草稿</option>
            <option value="deciding">决策中</option>
            <option value="decided">已决定</option>
            <option value="verified">已验证</option>
          </select>
          <span>{filtered?.length ?? 0} 项</span>
        </div>
      ) : null}
      <div className="decision-workspace">
        <section className="decision-queue">
          <div className="section-label">DECISION QUEUE</div>
          {filtered?.length === 0 ? (
            <div className="empty-state">
              <strong>暂无决策单</strong>
              <p>从质量问题或延期记录可直接带入上下文发起决策。</p>
            </div>
          ) : (
            filtered?.map((item: DecisionRow) => (
              <button
                className={selectedId === item.id ? "selected" : ""}
                key={item.id}
                onClick={() => setSelectedId(item.id)}
              >
                <div>
                  <span>{item.code}</span>
                  <small className="decision-status">{DECISION_STATUS_LABEL[item.status]}</small>
                </div>
                <strong>{item.title}</strong>
                <small>{item.projectId.slice(0, 8)}</small>
              </button>
            ))
          )}
        </section>
        {selectedId ? (
          <DecisionDetail id={selectedId} />
        ) : (
          <section className="decision-detail empty-detail">
            <p className="list-note">从左侧队列选择决策单查看方案比较与处理。</p>
          </section>
        )}
      </div>
    </div>
  );
}

/** 新建决策单页：支持从质量问题/延期带入上下文（?projectId&sourceType&sourceId&context） */
export function DecisionNewPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const preProjectId = params.get("projectId") ?? "";
  const preContext = params.get("context") ?? "";
  const preSourceType = params.get("sourceType") ?? "";
  const [title, setTitle] = useState("");
  const [context, setContext] = useState(preContext);
  const [projectId, setProjectId] = useState(preProjectId);
  const [options, setOptions] = useState<OptionValue[]>([
    { key: "delay", summary: "", impact: "", risk: "" },
    { key: "add_staff", summary: "", impact: "", risk: "" },
  ]);
  const [error, setError] = useState<string | null>(null);
  const mutations = useDecisionMutations();

  // 从质量/延期带入时锁定项目
  const lockedProject = !!preProjectId;

  return (
    <div className="screen decision-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">NEW DECISION</span>
          <h1>新建决策单</h1>
          <p>至少两个备选方案；决定需双意见齐备并附理由、条件与检查点。</p>
        </div>
      </div>
      <section className="decision-new">
        <label className="form-field">
          <span>所属项目 *</span>
          {lockedProject ? (
            <input value={projectId} disabled aria-label="所属项目" />
          ) : (
            <ProjectSelect value={projectId} onChange={setProjectId} />
          )}
        </label>
        <label className="form-field">
          <span>标题 *</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="form-field">
          <span>背景与冲突说明 *{preSourceType ? "（已带入来源上下文）" : ""}</span>
          <textarea rows={4} value={context} onChange={(e) => setContext(e.target.value)} />
        </label>
        <div className="form-field">
          <span>备选方案 *（≥2）</span>
          {options.map((o, idx) => (
            <div className="option-edit" key={idx}>
              <select
                value={o.key}
                aria-label="方案类型"
                onChange={(e) => setOptions((prev) => prev.map((x, i) => (i === idx ? { ...x, key: e.target.value } : x)))}
              >
                {OPTION_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {DECISION_OPTION_LABEL[k]}
                  </option>
                ))}
              </select>
              <input
                value={o.summary}
                placeholder="方案要点"
                aria-label="方案要点"
                onChange={(e) => setOptions((prev) => prev.map((x, i) => (i === idx ? { ...x, summary: e.target.value } : x)))}
              />
              <input
                value={o.impact}
                placeholder="影响"
                aria-label="影响"
                onChange={(e) => setOptions((prev) => prev.map((x, i) => (i === idx ? { ...x, impact: e.target.value } : x)))}
              />
              <input
                value={o.risk}
                placeholder="风险"
                aria-label="风险"
                onChange={(e) => setOptions((prev) => prev.map((x, i) => (i === idx ? { ...x, risk: e.target.value } : x)))}
              />
              <button
                className="icon-button"
                aria-label="删除方案"
                onClick={() => setOptions((prev) => prev.filter((_, i) => i !== idx))}
              >
                <X size={15} />
              </button>
            </div>
          ))}
          <button className="secondary-action" onClick={() => setOptions((prev) => [...prev, { key: "other", summary: "", impact: "", risk: "" }])}>
            添加方案
          </button>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="primary-action"
          disabled={
            !projectId ||
            !title.trim() ||
            !context.trim() ||
            options.length < 2 ||
            options.some((o) => !o.summary.trim()) ||
            mutations.create.isPending
          }
          onClick={() => {
            setError(null);
            mutations.create.mutate(
              {
                projectId,
                title: title.trim(),
                context: context.trim(),
                options: options.map((o) => ({ key: o.key, summary: o.summary.trim(), impact: o.impact.trim(), risk: o.risk.trim() })),
              },
              {
                onSuccess: () => navigate(projectId ? `/projects/${projectId}/decisions` : "/decisions"),
                onError: (err) => setError(rootErrorMessage(err)),
              },
            );
          }}
        >
          {mutations.create.isPending ? "创建中…" : "创建决策单"}
          <ChevronRight size={15} />
        </button>
      </section>
    </div>
  );
}

/** 我的项目选择（auth.me 项目清单；仅项目维度） */
export function ProjectSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const me = useMe();
  return (
    <select value={value} aria-label="所属项目" onChange={(e) => onChange(e.target.value)}>
      <option value="">选择项目</option>
      {(me.data?.projects ?? []).map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}
