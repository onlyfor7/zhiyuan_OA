import { useMemo, useState } from "react";
import { GitBranch } from "lucide-react";

import {
  usePlanCurrent,
  usePlanSimulate,
  usePlanTransitions,
  usePlanVersion,
  usePlanVersions,
  type PlanAdjustment,
} from "../../api/plan";
import { useTaskList } from "../../api/task";
import { GanttBoard } from "./GanttBoard";
import { buildGanttRows } from "./gantt-utils";
import { SimulatePanel } from "./SimulatePanel";
import { ChangeSection } from "./ChangeSection";
import { useSpaceParams } from "./space-context";
import { PLAN_VERSION_KIND_LABEL } from "../../lib/labels";

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 项目空间·计划页签：三轨甘特 + 模拟调整 + 延期申请闭环（PLN-I1：planned_* 无直改入口） */
export default function PlanTab() {
  const { projectId } = useSpaceParams();
  const versions = usePlanVersions(projectId);
  const current = usePlanCurrent(projectId);
  const tasks = useTaskList({ projectId });
  const transitions = usePlanTransitions();
  const [simOpen, setSimOpen] = useState(false);
  const [simAdjustments, setSimAdjustments] = useState<PlanAdjustment[]>([]);
  const [simRun, setSimRun] = useState(false);
  const [changePrefill, setChangePrefill] = useState<PlanAdjustment[] | null>(null);
  const simulate = usePlanSimulate(projectId, simAdjustments, simRun);

  const baselineMeta = useMemo(() => {
    if (!versions.data) return null;
    return versions.data.find((v) => v.kind === "baseline") ?? null;
  }, [versions.data]);
  const baselineDetail = usePlanVersion(baselineMeta && baselineMeta.id !== current.data?.id ? baselineMeta.id : null);

  if (versions.isPending || current.isPending || tasks.isPending) {
    return <p className="list-note">正在加载计划…</p>;
  }
  if (versions.isError) throw versions.error;
  if (current.isError) throw current.error;
  if (tasks.isError) throw tasks.error;

  const rows = buildGanttRows({
    current: current.data,
    baseline: baselineDetail.data ?? null,
    tasks: tasks.data.items,
    simulateItems: simulate.data?.items,
  });

  return (
    <div className="space-tab-body plan-tab">
      <div className="gantt-toolbar">
        <div className="toolbar-group">
          <span className="section-label">
            当前 V{current.data.versionNo} · {PLAN_VERSION_KIND_LABEL[current.data.kind]} ·{" "}
            {current.data.status === "active" ? "生效中" : "已失效"}
          </span>
        </div>
        <div className="toolbar-group">
          <button
            className={simOpen ? "primary-action" : "secondary-action"}
            onClick={() => setSimOpen((v) => !v)}
          >
            <GitBranch size={15} />
            {simOpen ? "收起模拟" : "模拟调整"}
          </button>
        </div>
      </div>
      {simOpen ? (
        <SimulatePanel
          items={current.data.items}
          running={simulate.isFetching}
          result={simulate.data}
          onClose={() => {
            setSimOpen(false);
            setSimRun(false);
          }}
          onRun={(adjustments) => {
            setSimAdjustments(adjustments);
            setSimRun(true);
          }}
          onApplyToChange={(adjustments) => setChangePrefill(adjustments)}
        />
      ) : null}
      <GanttBoard
        rows={rows}
        today={todayStr()}
        onTransitionStage={(refId, action) => transitions.stage.mutate({ stageId: refId, action })}
        onTransitionMilestone={(refId, action) =>
          transitions.milestone.mutate({ milestoneId: refId, action })
        }
      />
      {(transitions.stage.error || transitions.milestone.error) ? (
        <p className="form-error" role="alert">
          {(transitions.stage.error ?? transitions.milestone.error)!.message}
        </p>
      ) : null}
      <ChangeSection
        planItems={current.data.items}
        prefill={changePrefill}
        onPrefillConsumed={() => setChangePrefill(null)}
      />
    </div>
  );
}
