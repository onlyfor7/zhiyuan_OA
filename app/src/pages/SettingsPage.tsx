import { useState } from "react";
import { useNavigate } from "react-router";
import { KeyRound, LogOut, ShieldCheck } from "lucide-react";

import { useChangePassword, useLogout, useMe } from "../api/auth";
import { useRail } from "../components/shell-rail";
import { rootErrorMessage } from "../lib/form";

function SettingsRail() {
  return (
    <aside className="context-rail">
      <div className="context-heading">
        <span className="section-label">ACCOUNT</span>
        <h2>账号安全</h2>
      </div>
      <div className="context-section">
        <div className="section-label">SESSIONS</div>
        <h2>改密即全端失效</h2>
        <p className="context-note">修改成功后该账号全部会话立即失效（含当前会话），需用新口令重新登录。</p>
      </div>
      <div className="assurance">
        <ShieldCheck size={16} />
        <span>口令 scrypt 散列存储；操作写入审计。</span>
      </div>
    </aside>
  );
}

/** /settings 自助改密（auth.changePassword 真实） */
export default function SettingsPage() {
  useRail(SettingsRail);
  const navigate = useNavigate();
  const me = useMe();
  const change = useChangePassword();
  const logout = useLogout();
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canSubmit = oldPassword && newPassword.length >= 8 && confirm && newPassword === confirm;

  return (
    <div className="screen settings-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">ACCOUNT SECURITY</span>
          <h1>自助改密</h1>
          <p>
            {me.data?.mustChangePassword
              ? "当前账号使用初始口令，须修改后才能继续使用。"
              : "修改成功后需重新登录。"}
          </p>
        </div>
      </div>
      <section className="settings-form">
        <label className="form-field">
          <span>当前密码 *</span>
          <input type="password" autoComplete="current-password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
        </label>
        <label className="form-field">
          <span>新密码 *（8-100 位）</span>
          <input type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
        </label>
        <label className="form-field">
          <span>确认新密码 *</span>
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          {confirm && confirm !== newPassword ? <em className="field-error">两次输入不一致</em> : null}
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="primary-action"
          disabled={!canSubmit || change.isPending}
          onClick={() => {
            setError(null);
            change.mutate(
              { oldPassword, newPassword },
              {
                onSuccess: () => navigate("/login", { replace: true }),
                onError: (err) => setError(rootErrorMessage(err)),
              },
            );
          }}
        >
          <KeyRound size={15} />
          {change.isPending ? "修改中…" : "确认修改（改后需重新登录）"}
        </button>
        <button
          className="secondary-action"
          style={{ marginTop: 10 }}
          disabled={logout.isPending}
          onClick={() => {
            logout.mutate(undefined, {
              onSettled: () => navigate("/login", { replace: true }),
            });
          }}
        >
          <LogOut size={15} />
          {logout.isPending ? "正在退出…" : "退出登录"}
        </button>
      </section>
    </div>
  );
}
