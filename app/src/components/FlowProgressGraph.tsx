import type { RouterOutputs } from "../lib/trpc";

type FlowProgress = NonNullable<RouterOutputs["approval"]["getById"]["flowProgress"]>;

/**
 * 审批流程节点图（真实 flowProgress：compiledSteps 逐节点 + 条件求值轨迹）。
 * 状态映射：approved/pending/rejected/transferred/skipped → done/current/pending/rejected。
 */
export function FlowProgressGraph({ progress }: { progress: FlowProgress }) {
  const nodes = progress.nodes;
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
        return (
          <div className="progress-step-wrap" key={`${node.label}-${i}`} role="listitem">
            <div className={`progress-step state-${state}`}>
              <span aria-hidden="true">{state === "done" ? "✓" : state === "rejected" ? "✕" : state === "current" ? "●" : "○"}</span>
              <strong>{node.label}</strong>
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
    </div>
  );
}
