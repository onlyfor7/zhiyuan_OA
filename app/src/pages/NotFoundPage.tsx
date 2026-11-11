import { Link, useNavigate } from "react-router";
import { ArrowLeft, ArrowRight, ShieldCheck } from "lucide-react";

/**
 * 404 提示页（arch/12 §19.2 三类区分）：
 * - variant="missing"（缺省）：真 404——路由不存在，「页面不存在」；
 * - variant="gone"：业务数据对象同形 404（ACCESS_DENIED_OR_GONE 边界渲染）——
 *   维持 arch/03 无泄露中性表述「不存在或无权访问」+ 同形说明，**不破**。
 * fixedCode="403"：独立 /403 路由沿用「无权访问」同形态。
 */
export default function NotFoundPage({ fixedCode, variant }: { fixedCode?: "403" | "404"; variant?: "missing" | "gone" }) {
  const navigate = useNavigate();
  const code = fixedCode ?? "404";
  const kind = variant ?? (code === "403" ? "gone" : "missing");
  const gone = kind === "gone";
  return (
    <div className="notfound-screen">
      <div className="brand-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <span className="nc-label">ERROR · {code}</span>
      <h1>{gone ? (code === "403" ? "无权访问" : "不存在或无权访问") : "页面不存在"}</h1>
      <p>
        {gone ? (
          <>
            你访问的内容不存在，或你没有访问权限。
            <br />
            如需访问，请联系项目负责人或系统管理员授权。
          </>
        ) : (
          <>
            你访问的页面不存在或已被移除。
            <br />
            请检查链接是否正确，或从导航重新进入。
          </>
        )}
      </p>
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
      {gone ? (
        <div className="login-note muted">
          <ShieldCheck size={15} />
          <span>为保密需要，无权访问与不存在的内容在系统内呈现相同形态。</span>
        </div>
      ) : null}
    </div>
  );
}
