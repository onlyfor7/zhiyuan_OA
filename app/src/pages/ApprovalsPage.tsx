import { useState } from "react";
import { Check, ChevronRight, Send, X } from "lucide-react";

import { useApproval, useApprovalAct, useApprovalsApplied, useApprovalsMine } from "../api/approval";
import { useUserNameMap } from "../api/reference";
import { newIdempotencyKey, rootErrorMessage } from "../lib/form";
import { ListSkeleton } from "../components/feedback";
import { HelpIcon } from "../components/HelpIcon";
import BizSnapshot from "../components/BizSnapshot";
import "../lib/form";
import {
  APPROVAL_BIZ_LABEL,
  APPROVAL_STEP_STATUS_LABEL,
  GLOBAL_ROLE_LABEL,
} from "../lib/labels";
import type { RouterOutputs } from "../lib/trpc";
import { UserPicker } from "../components/UserPicker";
import { FlowProgressGraph } from "../components/FlowProgressGraph";

type MineItem = RouterOutputs["approval"]["listMine"]["items"][number];
type AppliedItem = RouterOutputs["approval"]["listMineApplied"]["items"][number];

interface ApprovalCheck {
  name: string;
  pass: boolean;
  detail: string;
}

/** 审批快照：biz 关键字段 + 提交时检查项（EXP-006；随 formSnapshot 冻结） */
function SnapshotPanel({ instanceId }: { instanceId: string }) {
  const approval = useApproval(instanceId);
  if (approval.isPending) return <p className="list-note">正在加载审批快照…</p>;
  if (approval.isError) return null;
  const snap = approval.data.formSnapshot as {
    checks?: ApprovalCheck[];
    level?: string;
    amountCents?: number;
    changeRequestCode?: string;
    reason?: string;
  } | null;
  const checks = snap?.checks ?? [];
  return (
    <div className="checks-panel">
      {snap?.amountCents != null ? (
        <p className="context-note">
          金额 <strong>{(snap.amountCents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2 })} 元</strong>
          {snap.level ? ` · 级别 ${snap.level}` : ""}
        </p>
      ) : null}
      {checks.length > 0 ? (
        <>
          <span className="section-label">提交时检查项（冻结）</span>
          {checks.map((c) => (
            <div className={`check-line ${c.pass ? "pass" : "fail"}`} key={c.name}>
              <Check size={14} />
              <strong>{c.name}</strong>
              <small>{c.detail}</small>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

function MineCardExtras({ item }: { item: MineItem }) {
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [flowOpen, setFlowOpen] = useState(false);
  return (
    <>
      {/* §16.2：业务详情默认展开——审批人不应盲批 */}
      <BizSnapshot instanceId={item.instance.id} />
      <div className="row-ops" style={{ marginTop: 8 }}>
        <button className="text-action" onClick={() => setSnapshotOpen((v) => !v)}>
          {snapshotOpen ? "收起快照" : "审批快照/检查项"}
        </button>
        <button className="text-action" onClick={() => setFlowOpen((v) => !v)}>
          {flowOpen ? "收起流程节点图" : "流程节点图"}
        </button>
      </div>
      {snapshotOpen ? <SnapshotPanel instanceId={item.instance.id} /> : null}
      {flowOpen ? <FlowProgressPanel id={item.instance.id} /> : null}
      <ActPanel item={item} />
    </>
  );
}

/** 自定义流程实例的节点图进度（arch/09 §3.3；非自定义流程实例返回 null 不渲染） */
function FlowProgressPanel({ id }: { id: string }) {
  const approval = useApproval(id);
  if (approval.isPending) return <p className="list-note">正在加载流程进度…</p>;
  if (approval.isError) return null;
  const progress = approval.data.flowProgress;
  if (!progress) return null;
  return (
    <div className="checks-panel">
      <span className="section-label">
        FLOW · {progress.flowName}
        {progress.flowVersion != null ? ` V${progress.flowVersion}` : ""}
      </span>
      {progress.currentNodeLabel ? <p className="context-note">当前节点：{progress.currentNodeLabel}</p> : null}
      <FlowProgressGraph progress={progress} />
    </div>
  );
}

function ActPanel({ item }: { item: MineItem }) {
  const act = useApprovalAct();
  const [action, setAction] = useState<"approve" | "reject" | "transfer" | null>(null);
  const [comment, setComment] = useState("");
  const [transferTo, setTransferTo] = useState("");
  const [idemKey] = useState(newIdempotencyKey);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const instanceId = item.instance.id;

  return (
    <div className="act-panel">
      <span className="section-label">ACTION</span>
      {notice ? <p className="context-note">{notice}</p> : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {action === null ? (
        <div className="row-ops">
          <button className="primary-action" onClick={() => setAction("approve")}>
            <Check size={15} />
            通过
          </button>
          <button className="secondary-action" onClick={() => setAction("reject")}>
            <X size={15} />
            驳回
          </button>
          <button className="secondary-action" onClick={() => setAction("transfer")}>
            <ChevronRight size={15} />
            转交
          </button>
        </div>
      ) : (
        <div className="act-form">
          {action === "transfer" ? (
            <div className="form-field">
              <span>转交给 *</span>
              <UserPicker value={transferTo} onChange={setTransferTo} />
            </div>
          ) : null}
          <textarea
            rows={2}
            value={comment}
            placeholder={
              action === "reject"
                ? "驳回理由（必填）"
                : action === "transfer"
                  ? "转交说明（选填）"
                  : "审批意见（选填）"
            }
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="row-ops">
            <button
              className={action === "approve" ? "primary-action" : "secondary-action"}
              disabled={
                act.isPending ||
                (action === "reject" && !comment.trim()) ||
                (action === "transfer" && !transferTo)
              }
              onClick={() => {
                setError(null);
                setNotice(null);
                act.mutate(
                  {
                    instanceId,
                    stepSeq: item.step.seq,
                    action,
                    comment: comment.trim() || undefined,
                    transferTo: action === "transfer" ? transferTo : undefined,
                    idempotencyKey: idemKey,
                  },
                  {
                    onSuccess: (result) => {
                      if (!result.applied) {
                        setNotice("该步骤已由他人处理或状态已更新，列表已按最新状态刷新。");
                        setAction(null);
                      }
                    },
                    onError: (err) => setError(rootErrorMessage(err)),
                  },
                );
              }}
            >
              <Send size={15} />
              {act.isPending
                ? "提交中…"
                : action === "approve"
                  ? "确认通过"
                  : action === "reject"
                    ? "确认驳回"
                    : "确认转交"}
            </button>
            <button className="text-action" onClick={() => setAction(null)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AppliedSteps({ id }: { id: string }) {
  const userNames = useUserNameMap();
  const approval = useApproval(id);
  if (approval.isPending) return <p className="list-note">正在加载进度…</p>;
  if (approval.isError) throw approval.error;
  const a = approval.data;
  return (
    <div className="resolution-timeline">
      {a.flowProgress ? <FlowProgressGraph progress={a.flowProgress} /> : null}
      {a.steps.map((s) => (
        <div className={s.status === "pending" ? "active" : "done"} key={s.id}>
          <Check size={15} />
          <span>
            步骤 {Math.floor(s.seq / 1000) || s.seq} ·{" "}
            {s.approverRole ? (GLOBAL_ROLE_LABEL[s.approverRole] ?? s.approverRole) : s.approverId ? (userNames.get(s.approverId) ?? "—") : "—"}{" "}
            · {APPROVAL_STEP_STATUS_LABEL[s.status]}
            {s.comment ? <small>意见：{s.comment}</small> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 审批中心：待我审批队列（act）+ 我申请的（进度） */
export default function ApprovalsPage() {
  const mine = useApprovalsMine();
  const applied = useApprovalsApplied();
  const [tab, setTab] = useState<"mine" | "applied">("mine");
  const [appliedDetail, setAppliedDetail] = useState<string | null>(null);

  if (mine.isPending || applied.isPending) return <ListSkeleton rows={5} />;
  if (mine.isError) throw mine.error;
  if (applied.isError) throw applied.error;

  return (
    <div className="screen approvals-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">APPROVAL CENTER</span>
          <h1 aria-label="审批中心">
            审批中心
            <HelpIcon pageKey="approvals" />
          </h1>
          <p>待我审批 {mine.data.items.length} 项 · 我申请的 {applied.data.items.length} 项</p>
        </div>
      </div>
      <div className="audit-tabs">
        <button className={tab === "mine" ? "active" : ""} onClick={() => setTab("mine")}>
          待我审批
        </button>
        <button className={tab === "applied" ? "active" : ""} onClick={() => setTab("applied")}>
          我申请的
        </button>
      </div>
      {tab === "mine" ? (
        mine.data.items.length === 0 ? (
          <div className="empty-state">
            <strong>没有待审批事项</strong>
            <p>延期申请与档案授权进入您的审批步骤时会出现在这里。</p>
          </div>
        ) : (
          mine.data.items.map((item: MineItem) => (
            <div className="approval-card" key={`${item.instance.id}-${item.step.seq}`}>
              <div className="approval-card-head">
                <span className="badge badge-health-normal">{APPROVAL_BIZ_LABEL[item.instance.bizType] ?? item.instance.bizType}</span>
                <span className="section-label">
                  {item.instance.code} · 申请人 {item.instance.applicantName ?? "—"}
                </span>
                <span className="decision-status">
                  步骤 {Math.floor(item.step.seq / 1000) || item.step.seq} ·{" "}
                  {item.step.countersign === "all" ? "会签（全员）" : "任一通过"}
                </span>
              </div>
              <p>
                提交于 {item.instance.submittedAt?.slice(0, 16).replace("T", " ")}
                {item.instance.projectName ? ` · 项目 ${item.instance.projectName}` : ""}
              </p>
              <MineCardExtras item={item} />
            </div>
          ))
        )
      ) : (
        <div className="report-list">
          {applied.data.items.length === 0 ? (
            <div className="empty-state">
              <strong>暂无申请记录</strong>
            </div>
          ) : (
            applied.data.items.map((item: AppliedItem) => (
              <div className="report-row" key={item.id}>
                <div>
                  <strong>
                    {item.code} · {APPROVAL_BIZ_LABEL[item.bizType] ?? item.bizType}
                  </strong>
                  <small>
                    申请人 {item.applicantName ?? "—"}
                    {item.projectName ? ` · 项目 ${item.projectName}` : ""} · 提交 {item.submittedAt?.slice(0, 16).replace("T", " ") ?? "—"} ·{" "}
                    {item.completedAt ? `完成 ${item.completedAt.slice(0, 16).replace("T", " ")}` : "进行中"}
                  </small>
                </div>
                <button className="text-action" onClick={() => setAppliedDetail(appliedDetail === item.id ? null : item.id)}>
                  {appliedDetail === item.id ? "收起" : "查看进度"}
                  <ChevronRight size={14} />
                </button>
              </div>
            ))
          )}
          {appliedDetail ? <AppliedSteps id={appliedDetail} /> : null}
        </div>
      )}
    </div>
  );
}
