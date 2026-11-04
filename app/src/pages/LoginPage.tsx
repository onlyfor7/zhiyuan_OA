import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowRight, LockKeyhole, ShieldCheck } from "lucide-react";

import { useLogin, useMe } from "../api/auth";
import { fieldErrorsOf } from "../lib/trpc";

const loginSchema = z.object({
  email: z.email("邮箱格式不正确"),
  password: z.string().min(1, "请输入密码"),
});

type LoginFormValues = z.infer<typeof loginSchema>;

interface LocationState {
  from?: string;
}

export default function LoginPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const from = (location.state as LocationState | null)?.from ?? "/cockpit";
  const me = useMe();
  const login = useLogin();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  // 已登录用户访问 /login 时直接回跳来源地址
  if (me.isSuccess) {
    return <Navigate to={from} replace />;
  }

  const onSubmit = handleSubmit((values) => {
    setFormError(null);
    login.mutate(values, {
      onSuccess: () => navigate(from, { replace: true }),
      onError: (error) => {
        const fieldErrors = fieldErrorsOf(error);
        if (fieldErrors) {
          for (const [field, messages] of Object.entries(fieldErrors)) {
            if (field === "email" || field === "password") {
              setError(field, { message: messages[0] ?? "输入无效" });
            }
          }
          return;
        }
        // 失败统一提示，不区分账号不存在 / 口令错误（arch/00 §4）
        setFormError(error.message || "登录失败，请稍后重试");
      },
    });
  });

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-card-top">
          <div className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div>
            <strong>因诺智元</strong>
            <span>业务管理平台</span>
          </div>
        </div>
        <div className="login-card-body">
          <h1>登录</h1>
          <p className="login-intro">使用工作邮箱登录，进入你的项目工作区。</p>
          <form onSubmit={onSubmit} noValidate>
            <label className="form-field">
              <span>邮箱</span>
              <input
                type="email"
                autoComplete="username"
                placeholder="name@firm.com"
                aria-invalid={!!errors.email}
                {...register("email")}
              />
              {errors.email ? <em className="field-error">{errors.email.message}</em> : null}
            </label>
            <label className="form-field">
              <span>密码</span>
              <input
                type="password"
                autoComplete="current-password"
                placeholder="请输入密码"
                aria-invalid={!!errors.password}
                {...register("password")}
              />
              {errors.password ? <em className="field-error">{errors.password.message}</em> : null}
            </label>
            {formError ? (
              <p className="form-error" role="alert">
                {formError}
              </p>
            ) : null}
            <button
              type="submit"
              className="primary-action full-action"
              disabled={login.isPending}
            >
              {login.isPending ? "正在登录…" : "登录"}
              <ArrowRight size={16} />
            </button>
          </form>
          <div className="login-note">
            <ShieldCheck size={15} />
            <span>登录与后续敏感操作均会记录审计日志。</span>
          </div>
          <div className="login-note muted">
            <LockKeyhole size={15} />
            <span>会话 8 小时有效；账号停用后会话立即失效。</span>
          </div>
        </div>
      </div>
    </div>
  );
}
