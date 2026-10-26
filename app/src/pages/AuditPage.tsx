import { KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";

import { useRail } from "../components/shell-rail";
import { NotConnected } from "../components/NotConnected";

function AuditRail() {
  return (
    <aside className="context-rail">
      <div className="context-heading">
        <span className="section-label">SECURITY POSTURE</span>
        <h2>保密边界</h2>
      </div>
      <div className="security-score">
        <ShieldCheck size={30} />
        <strong>最小权限</strong>
        <span>默认无权 · 按项目授权</span>
      </div>
      <div className="context-section">
        <div className="section-label">ACCESS RULE</div>
        <h2>撤权即时生效</h2>
        <p className="context-note">
          项目、搜索、报表、预览、下载和分享接口执行同一权限校验，不能通过复制地址绕过。
        </p>
      </div>
      <div className="assurance">
        <LockKeyhole size={16} />
        <span>系统管理员不默认拥有业务文件内容权限。</span>
      </div>
    </aside>
  );
}

export default function AuditPage() {
  useRail(AuditRail);

  return (
    <div className="screen audit-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">ACCESS & AUDIT</span>
          <h1>看得见权限，也查得到足迹。</h1>
          <p>项目授权、临时查阅和每一次敏感操作，都在同一套保密边界内。</p>
        </div>
      </div>
      <div className="audit-list-region">
        <NotConnected hint="授权管理与审计日志查询随迭代 1 接入；授权、撤权与敏感读取均写入审计" />
      </div>
      <div className="assurance inline-assurance">
        <KeyRound size={16} />
        <span>当前页面不含演示数据。</span>
      </div>
    </div>
  );
}
