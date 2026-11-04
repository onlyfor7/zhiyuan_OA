import { useSearchParams } from "react-router";

import { DomainIconBlock } from "../lib/DomainIconBlock";
import { DOMAIN_ICONS, type DomainKey } from "../lib/icons";

const SUB_MAP: Record<string, string> = {
  lead: "CRM 域（9c）",
  opportunity: "CRM 域（9c）",
  customer: "CRM 域（9c）",
  contract: "CRM 域（9c）",
  finance: "财务核算域（9d）",
  report: "报表中心（9e）",
  org: "基础信息维护（9b）",
  project: "项目域（既有）",
  settings: "治理域（既有）",
};

/** 新域/既有页占位卡：客户/报表等组内项点击进「即将上线」卡（含所属域与子迭代说明） */
export default function ComingSoonPage() {
  const [params] = useSearchParams();
  const title = params.get("title") ?? "即将上线";
  const sub = params.get("sub") ?? "";
  const domainParam = (params.get("domain") ?? "settings") as DomainKey;
  const domain: DomainKey = domainParam in DOMAIN_ICONS ? domainParam : "settings";
  return (
    <div className="p9a-main" style={{ overflowY: "auto" }}>
      <section className="p9a-placeholder-card">
        <span className="p9a-placeholder-icon">
          <DomainIconBlock domain={domain} size={44} iconSize={22} />
        </span>
        <span className="section-label">即将上线 · {SUB_MAP[domain] ?? "后续子迭代"}</span>
        <h1>{title}</h1>
        <p>{sub || "该功能按 arch/12 迭代切分在对应子迭代落地。"}</p>
        <p className="context-note">
          所属域：{SUB_MAP[domain] ?? "后续子迭代"}——本页为占位卡，不建空页面；落地后同路由替换为真实页面。
        </p>
      </section>
    </div>
  );
}
