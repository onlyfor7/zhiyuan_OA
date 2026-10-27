import { Link } from "react-router";
import { FolderOpen, History } from "lucide-react";

import { useMe } from "../api/auth";
import { useRail } from "../components/shell-rail";

function ArchiveRail() {
  return (
    <aside className="context-rail">
      <div className="context-heading">
        <span className="section-label">PROJECT ARCHIVE</span>
        <h2>档案中心</h2>
      </div>
      <div className="context-section">
        <div className="section-label">CONTROLLED ACCESS</div>
        <h2>受控访问</h2>
        <p className="context-note">
          项目档案按固定十一目录组织；文件下载与预览经服务端鉴权直链，授权到期或撤销即时失效。
        </p>
      </div>
      <div className="assurance">
        <History size={16} />
        <span>预览、导出和授权行为均进入审计日志。</span>
      </div>
    </aside>
  );
}

/** 全局档案中心入口：选择项目进入项目空间·档案页签 */
export default function ArchivePage() {
  useRail(ArchiveRail);
  const me = useMe();
  if (me.isPending) return <p className="list-note">正在加载…</p>;
  if (me.isError) throw me.error;

  return (
    <div className="screen archive-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">PROJECT ARCHIVE</span>
          <h1>项目结束，记忆仍然清晰。</h1>
          <p>档案按项目组织；请选择项目进入其档案空间。</p>
        </div>
      </div>
      <div className="project-table">
        <div className="project-table-head">
          <span>项目</span>
          <span>编号</span>
          <span>我的角色</span>
          <span />
        </div>
        {me.data.projects.length === 0 ? (
          <div className="empty-state">
            <FolderOpen size={24} />
            <strong>暂无可见项目</strong>
          </div>
        ) : (
          me.data.projects.map((p) => (
            <Link className="project-row" key={p.id} to={`/projects/${p.id}/archive`}>
              <div>
                <strong>{p.name}</strong>
              </div>
              <span>{p.code}</span>
              <span>{p.projectRole}</span>
              <span className="text-action">进入档案</span>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
