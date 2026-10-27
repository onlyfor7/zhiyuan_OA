/** 财务汇总可见性：项目负责人 / partner / finance（arch/03 §3 矩阵；服务端强制） */
export function canViewFinance(myRole: string | null, globalRoles: string[]): boolean {
  return myRole === "manager" || globalRoles.includes("partner") || globalRoles.includes("finance");
}
