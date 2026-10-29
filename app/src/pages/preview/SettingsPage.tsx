import { useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";

import { PreviewNote } from "./PreviewNote";

/** /preview/settings 自助改密（所有角色；校验旧口令+改后全会话失效） */
export default function SettingsPage() {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [strengthNote, setStrengthNote] = useState<string | null>(null);

  const checkStrength = (v: string) => {
    setNewPassword(v);
    if (!v) {
      setStrengthNote(null);
      return;
    }
    const ok = v.length >= 12 && /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v);
    setStrengthNote(ok ? "强度合格（≥12 位且含大小写与数字）" : "建议 ≥12 位且包含大小写字母与数字");
  };

  const canSubmit = oldPassword && newPassword && confirm && newPassword === confirm;

  return (
    <div className="screen preview-screen settings-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">ACCOUNT SECURITY</span>
          <h1>自助改密</h1>
          <p>修改成功后该账号全部会话立即失效，需重新登录。</p>
        </div>
      </div>
      <section className="settings-form">
        <label className="form-field">
          <span>当前密码 *</span>
          <input
            type="password"
            autoComplete="current-password"
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
          />
        </label>
        <label className="form-field">
          <span>新密码 *</span>
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => checkStrength(e.target.value)}
          />
          {strengthNote ? <small className="picker-note">{strengthNote}</small> : null}
        </label>
        <label className="form-field">
          <span>确认新密码 *</span>
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          {confirm && confirm !== newPassword ? (
            <em className="field-error">两次输入不一致</em>
          ) : null}
        </label>
        <PreviewNote>
          <ShieldCheck size={13} style={{ verticalAlign: "-2px" }} /> 服务端校验旧口令；新口令散列存储（scrypt），不落明文。
        </PreviewNote>
        <button
          className="primary-action"
          disabled={!canSubmit}
          onClick={() => window.alert("原型预览：界面为静态示意，操作不会被提交。")}
        >
          <KeyRound size={15} />
          确认修改
        </button>
      </section>
    </div>
  );
}
