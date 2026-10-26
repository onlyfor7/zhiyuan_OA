import { History, ShieldCheck } from "lucide-react";

import { useRail } from "../components/shell-rail";
import { NotConnected } from "../components/NotConnected";

function ArchiveRail() {
  return (
    <aside className="context-rail">
      <div className="context-heading">
        <span className="section-label">DOCUMENT PREVIEW</span>
        <h2>文件预览</h2>
      </div>
      <NotConnected hint="选择文件后在此预览内容、版本与元数据（迭代 1 接入）" />
      <div className="assurance">
        <History size={16} />
        <span>预览、导出和授权行为均进入审计日志。</span>
      </div>
    </aside>
  );
}

export default function ArchivePage() {
  useRail(ArchiveRail);

  return (
    <div className="screen archive-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">PROJECT ARCHIVE</span>
          <h1>项目结束，记忆仍然清晰。</h1>
          <p>
            交付文件以版本与校验值存放于受控存储；下载与预览经服务端鉴权，不提供永久公开地址。
          </p>
        </div>
      </div>
      <div className="stat-region">
        <NotConnected hint="归档完整度与必归档项核对随迭代 1 档案域接入" />
      </div>
      <div className="archive-list-region">
        <NotConnected hint="档案目录视图与文件检索随迭代 1 档案域接入；文件下载/预览将使用 /files/:fileVersionId 直链" />
      </div>
      <div className="assurance inline-assurance">
        <ShieldCheck size={16} />
        <span>当前页面不含演示数据。</span>
      </div>
    </div>
  );
}
