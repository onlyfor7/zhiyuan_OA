import { PLAN_ITEM_TYPE_LABEL } from "../../lib/labels";
import type { RouterOutputs } from "../../lib/trpc";

type PlanVersionDetail = RouterOutputs["plan"]["current"];
type TaskItem = RouterOutputs["task"]["list"]["items"][number];
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

/** 将 plan items 与任务 live 数据合成为三轨行；阶段/里程碑暂无名称契约（STATUS 待裁定），以类型+序号呈现 */
export function buildGanttRows(args: {
  current: PlanVersionDetail;
  baseline: PlanVersionDetail | null;
  tasks: TaskItem[];
  simulateItems?: SimItem[];
}): GanttRow[] {
  const { current, baseline, tasks, simulateItems } = args;
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const baseByRef = new Map((baseline?.items ?? []).map((i) => [`${i.itemType}:${i.refId}`, i]));
  const simByRef = new Map((simulateItems ?? []).map((i) => [`${i.itemType}:${i.refId}`, i]));
  return current.items.map((item) => {
    const base = baseByRef.get(`${item.itemType}:${item.refId}`);
    const sim = simByRef.get(`${item.itemType}:${item.refId}`);
    const task = item.itemType === "task" ? taskById.get(item.refId) : undefined;
    const name =
      item.itemType === "task"
        ? (task?.title ?? `任务 ${item.refId.slice(0, 6)}`)
        : `${PLAN_ITEM_TYPE_LABEL[item.itemType]} #${item.seq}`;
    return {
      key: item.id,
      itemType: item.itemType,
      refId: item.refId,
      seq: item.seq,
      name,
      baselineStart: base?.plannedStart ?? null,
      baselineEnd: base?.plannedEnd ?? null,
      currentStart: item.plannedStart,
      currentEnd: item.plannedEnd,
      actualStart: task?.actualStart?.slice(0, 10) ?? null,
      actualEnd: task?.actualEnd?.slice(0, 10) ?? null,
      status: task?.status ?? "",
      dependsOn: item.dependsOn,
      cascaded: sim?.cascaded,
      simulatedStart: sim?.simulatedStart,
      simulatedEnd: sim?.simulatedEnd,
    };
  });
}
