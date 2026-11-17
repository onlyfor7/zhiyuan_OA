import type { RouterOutputs } from "../lib/trpc";
import type { FlowStepFlag } from "../lib/flow-step-flags";

type FlowProgress = NonNullable<RouterOutputs["approval"]["getById"]["flowProgress"]>;

/** v2 policySnapshot 中抄送事件（arch/14 §8：cc 不产审批步骤，仅在进度图上标注） */
interface CcEventLike {
  nodeId: string;
  name: string;
  afterStepIndex: number;
  receivers?: Array<{ kind: string; role?: string | null }>;
}

const CC_KIND_LABEL: Record<string, string> = {
  role: "角色",
  user: "指定人员",
  initiator_manager: "提交人主管",
  dept_head: "部门负责人",
  initiator_self: "提交人本人",
  project_manager: "项目负责人",
  manager_chain: "主管链",
  form_contact: "表单联系人",
  initiator_choice: "提交人自选",
};

function ccTargets(ev: CcEventLike): string {
  const rs = ev.receivers ?? [];
  return rs
    .map((r) => (r.kind === "role" ? `角色 ${r.role ?? ""}` : (CC_KIND_LABEL[r.kind] ?? r.kind)))
    .join("、");
}

/**
 * 审批流程节点图（真实 flowProgress：compiledSteps 逐节点 + 条件求值轨迹）。
 * 状态映射：approved/pending/rejected/transferred/skipped → done/current/pending/rejected。
 * v2 适配（arch/14 §8）：policySnapshot 提供抄送事件标注（已发送/待触发），stepFlags 标注系统自动步骤。
 */
export function FlowProgressGraph({
  progress,
  policySnapshot,
  stepFlags,
}: {
  progress: FlowProgress;
  policySnapshot?: unknown;
  stepFlags?: FlowStepFlag[];
}) {
  const nodes = progress.nodes;
  const snap = (policySnapshot ?? {}) as { ccEvents?: CcEventLike[]; ccFired?: string[] };
  const ccEvents = snap.ccEvents ?? [];
  const ccFired = new Set(snap.ccFired ?? []);
  const ccRow = (ev: CcEventLike, keyPrefix: string) => {
    const fired = ccFired.has(ev.nodeId);
    return (
      <div className={`progress-cc ${fired ? "fired" : "pending"}`} key={`${keyPrefix}-${ev.nodeId}`} role="listitem">
        <span aria-hidden="true">✉</span>
        <strong>{fired ? "已抄送" : "待触发抄送"}</strong>
        <small>
          {ev.name} → {ccTargets(ev)}
        </small>
      </div>
    );
  };

  return (
    <div className="progress-graph" role="list" aria-label="审批流程进度">
      {nodes.map((node, i) => {
        const state =
          node.status === "approved"
            ? "done"
            : node.status === "rejected"
              ? "rejected"
              : node.status === "pending"
                ? i === nodes.findIndex((n) => n.status === "pending")
                  ? "current"
                  : "pending"
                : "done";
        const trace = (node.conditionTrace ?? []) as { field: string; op: string; value: unknown; result: boolean }[];
        const auto = stepFlags?.[i]?.auto === true;
        return (
          <div className="progress-step-wrap" key={`${node.label}-${i}`} role="listitem">
            {ccEvents
              .filter((ev) => ev.afterStepIndex === i)
              .map((ev) => ccRow(ev, "before"))}
            <div className={`progress-step state-${state}`}>
              <span aria-hidden="true">{state === "done" ? "✓" : state === "rejected" ? "✕" : state === "current" ? "●" : "○"}</span>
              <strong>
                {node.label}
                {auto ? <em className="progress-auto-tag">系统自动</em> : null}
              </strong>
              <small>
                {node.status === "skipped" ? "（条件未命中跳过）" : ""}
                {trace.length > 0
                  ? trace.map((t) => `${t.field} ${t.op} ${String(t.value)} → ${t.result ? "是" : "否"}`).join("；")
                  : ""}
              </small>
            </div>
            {i < nodes.length - 1 ? <i className="progress-link" aria-hidden="true" /> : null}
          </div>
        );
      })}
      {ccEvents
        .filter((ev) => ev.afterStepIndex >= nodes.length)
        .map((ev) => (
          <div className="progress-step-wrap" key={`tail-${ev.nodeId}`} role="listitem">
            {ccRow(ev, "tail")}
          </div>
        ))}
    </div>
  );
}
