import { type TableDensity } from "../lib/tableDensity";

/** E4：表格密度三档切换（界面偏好，arch/00 §1.3） */
export function DensitySwitch({ density, onChange }: { density: TableDensity; onChange: (d: TableDensity) => void }) {
  const label: Record<TableDensity, string> = { compact: "紧凑", standard: "标准", loose: "宽松" };
  return (
    <div className="ux-density-ops" style={{ margin: "0 0 10px" }}>
      <span className="section-label">E4 · 表格密度</span>
      <div className="ux-seg">
        {(Object.keys(label) as TableDensity[]).map((d) => (
          <button key={d} className={density === d ? "active" : ""} onClick={() => onChange(d)}>
            {label[d]}
          </button>
        ))}
      </div>
    </div>
  );
}
