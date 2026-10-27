import { useState } from "react";
import { GitBranch, Play, X } from "lucide-react";

import type { PlanAdjustment } from "../../api/plan";
import { PLAN_ITEM_TYPE_LABEL } from "../../lib/labels";
import type { RouterOutputs } from "../../lib/trpc";

type PlanItem = RouterOutputs["plan"]["current"]["items"][number];
type SimResult = RouterOutputs["plan"]["simulate"] | undefined;

interface SimRow extends PlanAdjustment {
  key: string;
}

/** 模拟调整面板（只算不写，PLN-I1）：选择计划项 + 新日期 → 级联推演 */
export function SimulatePanel({
  items,
  running,
  result,
  onRun,
  onApplyToChange,
  onClose,
}: {
  items: PlanItem[];
  running: boolean;
  result: SimResult;
  onRun: (adjustments: PlanAdjustment[]) => void;
  onApplyToChange: (adjustments: PlanAdjustment[]) => void;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<SimRow[]>([]);
  const itemById = new Map(items.map((i) => [i.id, i]));

  const update = (key: string, patch: Partial<SimRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <div className="simulate-panel">
      <div className="section-heading">
        <div>
          <span className="section-label">SIMULATION</span>
          <h2>模拟调整（不落库）</h2>
        </div>
        <button className="icon-button" aria-label="关闭模拟面板" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      <p className="context-note">选择计划项并填写新日期，系统按依赖关系级联推演，结果不会写入正式计划。</p>
      {rows.map((row) => {
        const item = itemById.get(row.ref_id);
        return (
          <div className="sim-row" key={row.key}>
            <select
              value={row.ref_id}
              aria-label="调整目标"
              onChange={(e) => {
                const next = itemById.get(e.target.value);
                update(row.key, {
                  ref_id: e.target.value,
                  item_type: next?.itemType ?? row.item_type,
                  new_start: next?.plannedStart ?? row.new_start,
                  new_end: next?.plannedEnd ?? row.new_end,
                });
              }}
            >
              <option value="">选择计划项</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {PLAN_ITEM_TYPE_LABEL[i.itemType]} #{i.seq}（{i.plannedStart} ~ {i.plannedEnd}）
                </option>
              ))}
            </select>
            <input
              type="date"
              value={row.new_start}
              aria-label="新开始日期"
              onChange={(e) => update(row.key, { new_start: e.target.value })}
            />
            <input
              type="date"
              value={row.new_end}
              aria-label="新完成日期"
              onChange={(e) => update(row.key, { new_end: e.target.value })}
            />
            <button
              className="icon-button"
              aria-label="删除该调整"
              onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}
            >
              <X size={15} />
            </button>
            {item ? null : <em className="field-error">请选择计划项</em>}
          </div>
        );
      })}
      <div className="sim-actions">
        <button
          className="secondary-action"
          onClick={() =>
            setRows((prev) => [
              ...prev,
              { key: crypto.randomUUID(), ref_id: "", item_type: "task", new_start: "", new_end: "" },
            ])
          }
        >
          添加调整项
        </button>
        <button
          className="primary-action"
          disabled={rows.length === 0 || rows.some((r) => !r.ref_id || !r.new_start || !r.new_end) || running}
          onClick={() => {
            const mapped = rows
              .map((r) => {
                const item = itemById.get(r.ref_id);
                return item
                  ? { ref_id: item.refId, item_type: item.itemType, new_start: r.new_start, new_end: r.new_end }
                  : null;
              })
              .filter((x): x is PlanAdjustment => x !== null);
            onRun(mapped);
          }}
        >
          <Play size={15} />
          {running ? "推演中…" : "运行模拟"}
        </button>
      </div>
      {result ? (
        <div className="sim-result" role="status">
          <strong>
            项目计划完成日：{result.projectEndOriginal} → {result.projectEndSimulated}（
            {result.projectEndDeltaDays >= 0 ? "+" : ""}
            {result.projectEndDeltaDays} 天）
          </strong>
          <ul>
            {result.items
              .filter((i) => i.cascaded || i.simulatedStart !== i.originalStart || i.simulatedEnd !== i.originalEnd)
              .map((i) => (
                <li key={i.id}>
                  {PLAN_ITEM_TYPE_LABEL[i.itemType]} #{i.seq}：{i.originalStart}~{i.originalEnd} →{" "}
                  {i.simulatedStart}~{i.simulatedEnd}
                  {i.cascaded ? "（级联）" : ""}
                </li>
              ))}
          </ul>
          <button
            className="text-action"
            onClick={() => {
              const mapped = rows
                .map((r) => {
                  const item = itemById.get(r.ref_id);
                  return item
                    ? { ref_id: item.refId, item_type: item.itemType, new_start: r.new_start, new_end: r.new_end }
                    : null;
                })
                .filter((x): x is PlanAdjustment => x !== null);
              onApplyToChange(mapped);
            }}
          >
            <GitBranch size={14} />
            按此发起书面延期申请
          </button>
        </div>
      ) : null}
    </div>
  );
}
