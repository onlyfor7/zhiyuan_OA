import { Link } from "react-router";
import { FolderOpen} from "lucide-react";

import { useMe } from "../api/auth";
import { HelpIcon } from "../components/HelpIcon";

/** 全局档案中心入口：选择项目进入项目空间·档案页签 */
export default function ArchivePage() {
  const me = useMe();
  if (me.isPending) return <p className="list-note">正在加载…</p>;
  if (me.isError) throw me.error;

  return (
    <div className="screen archive-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">PROJECT ARCHIVE</span>
          <h1 aria-label="项目结束，记忆仍然清晰。">
            项目结束，记忆仍然清晰。
            <HelpIcon pageKey="archive" />
          </h1>
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
