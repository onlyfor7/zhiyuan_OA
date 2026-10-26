import { useState } from "react";
import { useNavigate } from "react-router";
import { ChevronRight, ShieldCheck } from "lucide-react";
import { PROJECT_HEALTH_STATUS, PROJECT_LIFECYCLE_STATUS } from "@lexflow/shared";

import { useProjectList } from "../api/project";
import { useRail } from "../components/shell-rail";
import type { ProjectListFilters } from "../lib/trpc";
import { formatDateTime } from "../lib/trpc";
import { CONFIDENTIALITY_LABEL, HEALTH_LABEL, LIFECYCLE_LABEL } from "../lib/labels";

function ProjectsRail() {
  return (
    <aside className="context-rail">
      <div className="context-heading">
        <span className="section-label">PORTFOLIO</span>
        <h2>项目组合说明</h2>
      </div>
      <div className="context-section">
        <p className="context-note">
          项目列表由服务端按你的项目成员身份与有效授权过滤；未授权项目不会出现在列表中，也不会泄露其存在。
        </p>
      </div>
      <div className="assurance">
        <ShieldCheck size={17} />
        <span>列表、详情与直链执行同一套服务端权限校验（arch/03 §5）。</span>
      </div>
    </aside>
  );
}

export default function ProjectsPage() {
  useRail(ProjectsRail);
  const navigate = useNavigate();
  const [keywordInput, setKeywordInput] = useState("");
  const [filters, setFilters] = useState<ProjectListFilters>({});
  const list = useProjectList(filters);

  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  const applyKeyword = () => {
    const keyword = keywordInput.trim();
    setFilters((prev) => ({ ...prev, keyword: keyword || undefined }));
  };

  return (
    <div className="screen projects-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">PROJECT PORTFOLIO</span>
          <h1>项目全周期</h1>
          <p>你权限范围内的全部项目；筛选与分页由服务端执行。</p>
        </div>
      </div>
      <div className="quality-toolbar projects-toolbar">
        <div className="inline-search">
          <input
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyKeyword();
            }}
            placeholder="搜索项目名称或编号，回车确认"
            aria-label="搜索项目"
          />
        </div>
        <select
          value={filters.lifecycle ?? ""}
          onChange={(e) =>
            setFilters((prev) => ({
              ...prev,
              lifecycle: (e.target.value || undefined) as ProjectListFilters["lifecycle"],
            }))
          }
          aria-label="生命周期"
        >
          <option value="">全部周期</option>
          {PROJECT_LIFECYCLE_STATUS.map((value) => (
            <option key={value} value={value}>
              {LIFECYCLE_LABEL[value]}
            </option>
          ))}
        </select>
        <select
          value={filters.health ?? ""}
          onChange={(e) =>
            setFilters((prev) => ({
              ...prev,
              health: (e.target.value || undefined) as ProjectListFilters["health"],
            }))
          }
          aria-label="健康度"
        >
          <option value="">全部健康度</option>
          {PROJECT_HEALTH_STATUS.map((value) => (
            <option key={value} value={value}>
              {HEALTH_LABEL[value]}
            </option>
          ))}
        </select>
        <button className="secondary-action toolbar-apply" onClick={applyKeyword}>
          查询
        </button>
        <span>{list.isPending ? "加载中…" : `已加载 ${items.length} 个`}</span>
      </div>
      <div className="project-table">
        <div className="project-table-head">
          <span>项目</span>
          <span>客户 · 事项</span>
          <span>负责人</span>
          <span>周期</span>
          <span>健康度</span>
          <span>密级</span>
          <span>更新</span>
          <span />
        </div>
        {list.isPending ? (
          <p className="list-note">正在加载…</p>
        ) : list.isError ? (
          <div className="error-state inline" role="alert">
            <p>项目列表加载失败，请重试。</p>
            <button className="secondary-action" onClick={() => void list.refetch()}>
              重试
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="empty-state">
            <strong>没有匹配的项目</strong>
            <p>调整筛选条件，或联系项目负责人将你加入项目。</p>
          </div>
        ) : (
          items.map((project) => (
            <button
              className="project-row"
              key={project.id}
              onClick={() => navigate(`/projects/${project.id}`)}
            >
              <div>
                <strong>{project.name}</strong>
                <small>{project.code}</small>
              </div>
              <span className="project-client">
                {project.clientName}
                <small>{project.matterName}</small>
              </span>
              <span>{project.managerName}</span>
              <span className={`badge badge-lifecycle-${project.lifecycleStatus}`}>
                {LIFECYCLE_LABEL[project.lifecycleStatus]}
              </span>
              <span className={`badge badge-health-${project.healthStatus}`}>
                {HEALTH_LABEL[project.healthStatus]}
              </span>
              <span>{CONFIDENTIALITY_LABEL[project.confidentialityLevel]}</span>
              <span className="project-updated">{formatDateTime(project.updatedAt)}</span>
              <ChevronRight size={16} />
            </button>
          ))
        )}
      </div>
      {list.data?.pages.some((page) => page.nextCursor) ? (
        <div className="load-more">
          <button
            className="secondary-action"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            {list.isFetchingNextPage ? "加载中…" : "加载更多"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
