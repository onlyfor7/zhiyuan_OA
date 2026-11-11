import { Link, useNavigate } from "react-router";
import { ArrowLeft, ArrowRight, Lock } from "lucide-react";

import { useMe } from "../api/auth";
import { GLOBAL_ROLE_LABEL } from "../lib/labels";

/**
 * 系统级功能页无权限页（arch/12 §19.2）：菜单可见性可知的存在（如配置中心），
 * 前端按角色+菜单 roles 本地判定后呈现——文案「没有访问权限，请联系管理员」，
 * 不再伪装不存在（存在性不敏感）；业务数据对象仍走同形 404 无泄露（NotFoundPage variant="gone"）。
 */
export default function NoAccessPage() {
  const navigate = useNavigate();
  const me = useMe();
  const roles = me.data?.globalRoles ?? [];
  return (
    <div className="notfound-screen">
      <div className="brand-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <span className="nc-label">ACCESS DENIED</span>
      <h1>没有访问权限</h1>
      <p>
        你当前的角色无法使用此功能，请联系管理员开通。
        <br />
        此功能存在于系统中，仅角色白名单内可用。
      </p>
      {roles.length > 0 ? (
        <div className="noaccess-roles" aria-label="当前角色">
          <Lock size={13} />
          {roles.map((r) => (
            <span key={r} className="badge">{GLOBAL_ROLE_LABEL[r] ?? r}</span>
          ))}
        </div>
      ) : null}
      <div className="notfound-actions">
        <button className="secondary-action" onClick={() => navigate(-1)}>
          <ArrowLeft size={15} />
          返回上一页
        </button>
        <Link to="/cockpit" className="primary-action">
          回到驾驶舱
          <ArrowRight size={15} />
        </Link>
      </div>
    </div>
  );
}
