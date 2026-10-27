import { PLAN_ITEM_TYPE_LABEL } from "../../lib/labels";
import type { RouterOutputs } from "../../lib/trpc";

type PlanCurrent = RouterOutputs["plan"]["current"];
type PlanItems = Pick<PlanCurrent, "items">;
type LiveTracks = Pick<PlanCurrent, "stages" | "milestones" | "tasks">;
type SimItem = RouterOutputs["plan"]["simulate"]["items"][number];

export interface GanttRow {
  key: string;
  itemType: "stage" | "milestone" | "task";
  refId: string;
  seq: number;
  name: string;
  baselineStart: string | null;
  baselineEnd: string | null;
  currentStart: string;
  currentEnd: string;
  actualStart: string | null;
  actualEnd: string | null;
  status: string;
  dependsOn: string[];
  cascaded?: boolean;
  simulatedStart?: string;
  simulatedEnd?: string;
}

/**
 * 三轨合成（arch/04 §5 v1.1）：items[].name 为版本时点快照名；
 * 实际轨取 plan.current 输出的 stages/milestones/tasks live actual_*（不绕 task.list）。
 */
export function buildGanttRows(args: {
  current: PlanItems;
  baseline: PlanItems | null;
  live?: LiveTracks;
  simulateItems?: SimItem[];
}): GanttRow[] {
  const { current, baseline, live, simulateItems } = args;
  const baseByRef = new Map((baseline?.items ?? []).map((i) => [`${i.itemType}:${i.refId}`, i]));
  const simByRef = new Map((simulateItems ?? []).map((i) => [`${i.itemType}:${i.refId}`, i]));

  const stageById = new Map((live?.stages ?? []).map((s) => [s.id, s]));
  const milestoneById = new Map((live?.milestones ?? []).map((m) => [m.id, m]));
  const taskById = new Map((live?.tasks ?? []).map((t) => [t.id, t]));

  return current.items.map((item) => {
    const base = baseByRef.get(`${item.itemType}:${item.refId}`);
    const sim = simByRef.get(`${item.itemType}:${item.refId}`);
    const fallback = `${PLAN_ITEM_TYPE_LABEL[item.itemType]} #${item.seq}`;
    let actualStart: string | null = null;
    let actualEnd: string | null = null;
    let status = "";
    if (item.itemType === "stage") {
      const stage = stageById.get(item.refId);
      actualStart = stage?.actualStart ?? null;
      actualEnd = stage?.actualEnd ?? null;
      status = stage?.status ?? "";
    } else if (item.itemType === "milestone") {
      const milestone = milestoneById.get(item.refId);
      actualStart = milestone?.actualDate ?? null;
      actualEnd = milestone?.actualDate ?? null;
      status = milestone?.status ?? "";
    } else {
      const task = taskById.get(item.refId);
      actualStart = task?.actualStart?.slice(0, 10) ?? null;
      actualEnd = task?.actualEnd?.slice(0, 10) ?? null;
      status = task?.status ?? "";
    }
    return {
      key: item.id,
      itemType: item.itemType,
      refId: item.refId,
      seq: item.seq,
      name: item.name?.trim() ? item.name : fallback,
      baselineStart: base?.plannedStart ?? null,
      baselineEnd: base?.plannedEnd ?? null,
      currentStart: item.plannedStart,
      currentEnd: item.plannedEnd,
      actualStart,
      actualEnd,
      status,
      dependsOn: item.dependsOn,
      cascaded: sim?.cascaded,
      simulatedStart: sim?.simulatedStart,
      simulatedEnd: sim?.simulatedEnd,
    };
  });
}
