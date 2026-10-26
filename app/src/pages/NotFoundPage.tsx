import { Link, useNavigate } from "react-router";
import { ArrowLeft, ArrowRight, ShieldCheck } from "lucide-react";

/**
 * 403/404 统一页面（arch/03 §5）：两种代码同形，不泄露对象是否存在。
 * fixedCode 用于独立路由 /403、/404；详情页无权限时也以 404 形态呈现。
 */
export default function NotFoundPage({ fixedCode }: { fixedCode?: "403" | "404" }) {
  const navigate = useNavigate();
  const code = fixedCode ?? "404";
  return (
    <div className="notfound-screen">
      <div className="brand-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <span className="nc-label">ERROR · {code}</span>
      <h1>{code === "403" ? "无权访问" : "页面不存在"}</h1>
      <p>
        你访问的内容不存在，或你没有访问权限。
        <br />
        如需访问，请联系项目负责人或系统管理员授权。
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
      <div className="login-note muted">
        <ShieldCheck size={15} />
        <span>为保密需要，无权访问与不存在的内容在系统内呈现相同形态。</span>
      </div>
    </div>
  );
}
