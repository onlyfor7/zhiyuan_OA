import { useMemo, useState } from "react";
import { Link } from "react-router";

import type { GanttRow } from "./gantt-utils";

function parse(d: string): number {
  return new Date(`${d}T00:00:00`).getTime();
}

function addDays(base: number, days: number): number {
  return base + days * 86_400_000;
}

function axisStartOf(rows: GanttRow[]): number {
  let min = Number.MAX_VALUE;
  for (const r of rows) {
    const s = parse(r.currentStart);
    if (s < min) min = s;
    if (r.baselineStart && parse(r.baselineStart) < min) min = parse(r.baselineStart);
  }
  const d = new Date(min);
  const day = d.getDay() || 7; // 周一为轴起点
  return addDays(d.getTime(), 1 - day);
}

function axisEndOf(rows: GanttRow[]): number {
  let max = 0;
  for (const r of rows) {
    const c = parse(r.currentEnd);
    if (c > max) max = c;
    if (r.baselineEnd && parse(r.baselineEnd) > max) max = parse(r.baselineEnd);
    if (r.simulatedEnd && parse(r.simulatedEnd) > max) max = parse(r.simulatedEnd);
  }
  return max;
}

/** 甘特三轨：基线幽灵轨（V1）/当前计划轨（active）/模拟轨（不落库）/实际轨（任务 live） */
export interface GanttTaskSummary {
  total: number;
  done: number;
  overdue: number;
  delayed: number;
}

/** §12 节点级甘特：阶段/里程碑画时间条；节点行可展开任务三态摘要（完成/逾期/延后）+ 任务清单链接 */
export function GanttBoard({
  rows,
  today,
  taskSummary,
  tasksLink,
  onTransitionStage,
  onTransitionMilestone,
}: {
  rows: GanttRow[];
  today: string;
  taskSummary?: Map<string, GanttTaskSummary>;
  tasksLink?: (stageRefId: string) => string;
  onTransitionStage?: (refId: string, action: "start" | "done") => void;
  onTransitionMilestone?: (refId: string, action: "reach" | "miss") => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { axisStart, axisEnd, columns } = useMemo(() => {
    const start = axisStartOf(rows);
    const end = Math.max(axisEndOf(rows), parse(today));
    const totalDays = Math.max(7, Math.ceil((end - start) / 86_400_000) + 7);
    const columnCount = Math.min(18, Math.max(4, Math.ceil(totalDays / 7)));
    const cols: number[] = [];
    for (let i = 0; i < columnCount; i++) cols.push(addDays(start, i * 7));
    return { axisStart: start, axisEnd: addDays(start, columnCount * 7), columns: cols };
  }, [rows, today]);

  const total = Math.max(axisEnd - axisStart, 7 * 86_400_000);
  const pos = (date: string) => `${(((parse(date) - axisStart) / total) * 100).toFixed(3)}%`;
  const width = (from: string, to: string) =>
    `${Math.max(0.8, ((parse(to) - parse(from)) / total) * 100).toFixed(3)}%`;
  const todayPos = Math.min(Math.max((parse(today) - axisStart) / total, 0), 1);

  return (
    <div className="gantt-board three-track">
      <div className="gantt-head">
        <div>工作分解 / 类型</div>
        <div className="date-grid" style={{ gridTemplateColumns: `repeat(${columns.length}, 1fr)` }}>
          {columns.map((c) => (
            <span key={c}>{new Date(c).toISOString().slice(5, 10)}</span>
          ))}
        </div>
      </div>
      <div className="today-line" style={{ left: `calc(34% + 66% * ${todayPos.toFixed(4)})` }}>
        <span>今天</span>
      </div>
      {rows.map((row) => {
        const tsum = taskSummary?.get(row.refId) ?? null;
        const expandable = !!tsum && tsum.total > 0 && row.itemType === "stage";
        const isOpen = expanded.has(row.key);
        return (
          <div className={`gantt-row track-row item-${row.itemType}`} key={row.key}>
          <div className="task-label">
            {expandable ? (
              <button
                type="button"
                className="gantt-expander"
                aria-expanded={isOpen}
                aria-label={isOpen ? "收起任务摘要" : "展开任务摘要"}
                onClick={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(row.key)) next.delete(row.key);
                    else next.add(row.key);
                    return next;
                  })
                }
              >
                {isOpen ? "▾" : "▸"}
              </button>
            ) : null}
            <span
              className={`task-state ${
                row.status === "done"
                  ? "done"
                  : row.status === "in_progress"
                    ? "active"
                    : row.itemType === "milestone"
                      ? "milestone"
                      : ""
              }`}
            />
            <div>
              <strong>{row.name}</strong>
              <small>
                {row.currentStart.slice(5)} ~ {row.currentEnd.slice(5)}
                {row.cascaded ? " · 级联顺移" : ""}
              </small>
            </div>
            {row.itemType === "stage" && onTransitionStage ? (
              <span className="row-actions">
                <button type="button" onClick={() => onTransitionStage(row.refId, "start")}>
                  开始
                </button>
                <button type="button" onClick={() => onTransitionStage(row.refId, "done")}>
                  完成
                </button>
              </span>
            ) : null}
            {row.itemType === "milestone" && onTransitionMilestone ? (
              <span className="row-actions">
                <button type="button" onClick={() => onTransitionMilestone(row.refId, "reach")}>
                  到达
                </button>
                <button type="button" onClick={() => onTransitionMilestone(row.refId, "miss")}>
                  错过
                </button>
              </span>
            ) : null}
          </div>
          <div className="task-track">
            <div
              className="track-grid"
              style={{
                backgroundImage: `repeating-linear-gradient(to right, transparent 0, transparent calc(${100 / columns.length}% - 1px), #e8ebef calc(${100 / columns.length}% - 1px), #e8ebef ${100 / columns.length}%)`,
              }}
            />
            {row.baselineStart && row.baselineEnd ? (
              <span
                className="baseline-bar"
                style={{ left: pos(row.baselineStart), width: width(row.baselineStart, row.baselineEnd) }}
                title={`基线 ${row.baselineStart} ~ ${row.baselineEnd}`}
              />
            ) : null}
            {row.simulatedStart && row.simulatedEnd ? (
              <span
                className="simulated-bar"
                style={{ left: pos(row.simulatedStart), width: width(row.simulatedStart, row.simulatedEnd) }}
                title={`模拟 ${row.simulatedStart} ~ ${row.simulatedEnd}`}
              />
            ) : null}
            <span
              className={`task-bar ${
                row.status === "done"
                  ? "done"
                  : row.status === "in_progress"
                    ? "active"
                    : row.itemType === "milestone"
                      ? "milestone"
                      : ""
              }`}
              style={{ left: pos(row.currentStart), width: width(row.currentStart, row.currentEnd) }}
              title={`当前计划 ${row.currentStart} ~ ${row.currentEnd}`}
            >
              {row.itemType === "milestone" ? (
                <span className="milestone-diamond" />
              ) : (
                <span
                  className="bar-fill"
                  style={{
                    width: row.status === "done" ? "100%" : row.status === "in_progress" ? "58%" : "0%",
                  }}
                />
              )}
            </span>
            {row.actualStart ? (
              <span
                className="actual-bar"
                style={{
                  left: pos(row.actualStart),
                  width: row.actualEnd ? width(row.actualStart, row.actualEnd) : "1.2%",
                }}
                title={`实际 ${row.actualStart} ~ ${row.actualEnd ?? "进行中"}`}
              />
            ) : null}
          </div>
          {expandable && isOpen && tsum ? (
            <div className="gantt-task-summary">
              <span className="gantt-ts-total">任务 {tsum.total}</span>
              <span className="gantt-ts done">完成 {tsum.done}</span>
              <span className="gantt-ts overdue">逾期 {tsum.overdue}</span>
              <span className="gantt-ts delayed">延后 {tsum.delayed}</span>
              {tasksLink ? <Link className="text-action" to={tasksLink(row.refId)}>任务清单 →</Link> : null}
            </div>
          ) : null}
        </div>
        );
      })}
      <div className="gantt-foot">
        <div>
          <span className="legend-line baseline" />
          基线（V1 幽灵轨）
        </div>
        <div>
          <span className="legend-line current" />
          当前计划（active 版本）
        </div>
        <div>
          <span className="legend-line simulated" />
          模拟调整（不落库）
        </div>
        <div>
          <span className="legend-line actual" />
          实际（live）
        </div>
      </div>
    </div>
  );
}
