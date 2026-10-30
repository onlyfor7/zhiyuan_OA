import { useEffect, useState } from "react";

/** E4：表格密度三档偏好（localStorage，界面偏好允许 arch/00 §1.3） */
export type TableDensity = "compact" | "standard" | "loose";
const KEY = "lexflow-table-density";

export function useTableDensity() {
  const [density, setDensity] = useState<TableDensity>(() => {
    const raw = localStorage.getItem(KEY);
    return raw === "compact" || raw === "loose" ? raw : "standard";
  });
  useEffect(() => {
    localStorage.setItem(KEY, density);
  }, [density]);
  return { density, setDensity };
}

