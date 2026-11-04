import {
  AlertTriangle, Archive, Banknote, BarChart3, Bell, Briefcase, Building2, Calendar,
  CheckSquare, Clock, FileText, Folder, Gavel, ListTodo, Receipt, Settings, ShieldCheck,
  TrendingUp, UserPlus, Users, type LucideIcon,
} from "lucide-react";

/**
 * §4.4 全局图标系统契约（arch/12 v1.6，用户裁定）：全局唯一注册表，禁止同义不同标。
 * 凡指代业务域/对象类型（待办分组、通知、菜单项、徽标、空状态、页签、报表目录……）
 * 必须使用注册表同款图标+同款语义色；新增域类型先入注册表再使用。
 * 验收扫描禁止绕过注册表直引图标（lucide 直引仅限非业务域指代的纯装饰/动作图标）。
 */

export const SEMANTIC_COLORS = {
  blue: "#2563eb",
  green: "#059669",
  orange: "#ea580c",
  purple: "#7c3aed",
  red: "#dc2626",
  cyan: "#0891b2",
  slate: "#64748b",
  gray: "#6b7280",
} as const;
export type SemanticColor = keyof typeof SEMANTIC_COLORS;

export interface DomainIconDef {
  /** 域中文名（注册表展示/检索用） */
  label: string;
  icon: LucideIcon;
  color: SemanticColor;
}

export const DOMAIN_ICONS = {
  approval: { label: "审批", icon: CheckSquare, color: "blue" },
  meeting: { label: "会议", icon: Calendar, color: "green" },
  travel: { label: "出差", icon: Briefcase, color: "orange" },
  time: { label: "工时", icon: Clock, color: "purple" },
  quality: { label: "质量", icon: ShieldCheck, color: "red" },
  project: { label: "项目", icon: Folder, color: "blue" },
  risk: { label: "延期/风险/预警", icon: AlertTriangle, color: "orange" },
  notification: { label: "通知", icon: Bell, color: "slate" },
  org: { label: "组织/公司", icon: Building2, color: "slate" },
  expense: { label: "报销/费用", icon: Receipt, color: "green" },
  finance: { label: "财务/收款", icon: Banknote, color: "green" },
  contract: { label: "合同", icon: FileText, color: "blue" },
  customer: { label: "客户", icon: Users, color: "blue" },
  lead: { label: "线索", icon: UserPlus, color: "cyan" },
  opportunity: { label: "商机", icon: TrendingUp, color: "green" },
  report: { label: "报表", icon: BarChart3, color: "blue" },
  decision: { label: "决策", icon: Gavel, color: "purple" },
  archive: { label: "档案", icon: Archive, color: "gray" },
  settings: { label: "设置/配置", icon: Settings, color: "gray" },
  task: { label: "任务", icon: ListTodo, color: "blue" },
} as const satisfies Record<string, DomainIconDef>;

export type DomainKey = keyof typeof DOMAIN_ICONS;

export function domainColor(key: DomainKey): string {
  return SEMANTIC_COLORS[DOMAIN_ICONS[key].color];
}

/** 语义色浅底（图标块背景，约 10% 透明度） */
export function domainBg(key: DomainKey): string {
  return `${SEMANTIC_COLORS[DOMAIN_ICONS[key].color]}1a`;
}
