import { CheckCircle2 } from "lucide-react";

import { useApproval } from "../api/approval";
import { useUserNameMap } from "../api/reference";
import { APPROVAL_STEP_STATUS_LABEL, GLOBAL_ROLE_LABEL } from "../lib/labels";

/** 审批步骤进度（change_request / access_grant 通用；arch/04 §4） */
export function ApprovalSteps({ instanceId }: { instanceId: string }) {
  const userNames = useUserNameMap();
  const approval = useApproval(instanceId);
  if (approval.isPending) return <p className="list-note">正在加载审批进度…</p>;
  if (approval.isError) throw approval.error;
  const instance = approval.data;
  const currentGroup = Math.floor(instance.currentStepSeq / 1000) || instance.currentStepSeq;

  return (
    <div className="approval-progress">
      <div className="section-label">
        APPROVAL · {instance.code} · 当前第 {currentGroup} 步
      </div>
      <div className="resolution-timeline">
        {instance.steps.map((step) => {
          const done = step.status !== "pending";
          const active = step.status === "pending" && instance.status === "pending";
          const approver = step.approverRole
            ? (GLOBAL_ROLE_LABEL[step.approverRole] ?? step.approverRole)
            : (step.approverId ? (userNames.get(step.approverId) ?? "—") : "—");
          return (
            <div className={done ? "done" : active ? "active" : ""} key={step.id}>
              <CheckCircle2 size={16} />
              <span>
                步骤 {Math.floor(step.seq / 1000) || step.seq} · {approver} ·{" "}
                {APPROVAL_STEP_STATUS_LABEL[step.status]}
                {step.actedBy ? ` · 操作人 ${userNames.get(step.actedBy) ?? "—"}` : ""}
                {step.comment ? (
                  <small>
                    意见：{step.comment}
                  </small>
                ) : null}
                {step.actedAt ? <small>{step.actedAt.slice(0, 16).replace("T", " ")}</small> : null}
              </span>
            </div>
          );
        })}
      </div>
      {instance.status !== "pending" ? (
        <p className="context-note">
          审批已{instance.status === "approved" ? "通过" : instance.status === "rejected" ? "驳回" : "撤回"}。
        </p>
      ) : null}
    </div>
  );
}
