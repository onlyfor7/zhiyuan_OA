import { useState } from "react";
import { useNavigate } from "react-router";
import { KeyRound, LogOut} from "lucide-react";

import { useChangePassword, useLogout, useMe } from "../api/auth";
import { HelpIcon } from "../components/HelpIcon";
import { rootErrorMessage } from "../lib/form";

/** /settings 自助改密（auth.changePassword 真实） */
export default function SettingsPage() {
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
          <h1>
            自助改密
            <HelpIcon pageKey="settings" />
          </h1>
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
