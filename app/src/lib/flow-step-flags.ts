/** 审批进度图每步标记（arch/14 §8 适配）：auto=auto_pass/auto_reject 系统自动节点 */
export interface FlowStepFlag {
  auto?: boolean;
}

/** 从 approval.getById 详情组装每步标记（stepMeta key=step.seq，与服务端取法一致） */
export function stepFlagsFrom(detail: { steps: Array<{ seq: number }>; policySnapshot?: unknown }): FlowStepFlag[] {
  const meta = (detail.policySnapshot ?? {}) as { stepMeta?: Record<string, { approvalType?: string }> };
  return detail.steps.map((s) => {
    const t = meta.stepMeta?.[String(s.seq)]?.approvalType;
    return { auto: !!t && t !== "manual" };
  });
}
