import { useRef, useState } from "react";

import type { FormFieldDef } from "@lexflow/shared";
import { UserPicker } from "../../components/UserPicker";
import { formatYuan, useUserNameMap } from "../../api/reference";
import { toast } from "sonner";

/** 人员控件只读态：id → 姓名映射 */
function PersonName({ id }: { id: string }) {
  const userNames = useUserNameMap();
  return <>{userNames.get(id) ?? "—"}</>;
}

/**
 * 自定义表单运行时渲染（arch/14 §4.3/§5）：按 form_schema 渲染 11 控件。
 * editable=发起表单；readonly=详情/审批快照。hidden 字段（fieldPerms）由调用方过滤后传入。
 * money=元输入转分；person=UserPicker/姓名映射；file=既有 files 上传 cookie 直链组件。
 */

export type FormPayload = Record<string, unknown>;

function fileUrl(fileVersionId: string, kind: "download" | "preview"): string {
  return `/files/${fileVersionId}/${kind}`;
}

function FileField({ value, readonly, onChange }: { value: unknown; readonly: boolean; onChange?: (v: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const id = typeof value === "string" ? value : "";
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("sourceType", "generic_request");
      const r = await fetch("/files/upload", { method: "POST", body: fd, credentials: "same-origin" });
      if (!r.ok) throw new Error(`上传失败 ${r.status}`);
      const j = (await r.json()) as { fileVersionId?: string };
      if (!j.fileVersionId) throw new Error("上传响应缺 fileVersionId");
      onChange?.(j.fileVersionId);
      toast.success("附件已上传");
    } catch (e) {
      toast.error(String(e).slice(0, 80));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };
  if (readonly) {
    return id ? <a className="text-action" href={fileUrl(id, "download")}>下载附件</a> : <span>—</span>;
  }
  return (
    <span className="fw-file-field">
      {id ? <a className="text-action" href={fileUrl(id, "download")}>已上传 · 重新选择</a> : <span className="list-note">{busy ? "上传中…" : "未选择文件"}</span>}
      <input ref={inputRef} type="file" aria-label="选择附件" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
    </span>
  );
}

export function FormFieldControl({ field, value, payload, editable, readonly, onChange }: {
  field: FormFieldDef;
  value: unknown;
  payload: FormPayload;
  editable: boolean;
  readonly: boolean;
  onChange?: (v: unknown) => void;
}) {
  const v = value;
  if (readonly) {
    const text =
      v == null || v === "" ? "—"
        : field.control === "money" ? `${formatYuan(typeof v === "number" ? v : Number(v))} 元`
        : field.control === "daterange" && Array.isArray(v) ? `${v[0] ?? "—"} ~ ${v[1] ?? "—"}`
        : field.control === "multi" && Array.isArray(v) ? v.join("、")
        : String(v);
    return <span className="fw-ro-value">{field.control === "person" ? <PersonName id={String(v)} /> : text}</span>;
  }
  switch (field.control) {
    case "text":
      return <input value={String(v ?? "")} placeholder={field.placeholder} onChange={(e) => onChange?.(e.target.value)} />;
    case "textarea":
      return <textarea rows={3} value={String(v ?? "")} placeholder={field.placeholder} onChange={(e) => onChange?.(e.target.value)} />;
    case "note":
      return <p className="context-note">{field.label}</p>;
    case "number":
      return <input type="number" value={v == null ? "" : Number(v)} min={field.min} max={field.max} placeholder={field.placeholder} onChange={(e) => onChange?.(e.target.value === "" ? undefined : Number(e.target.value))} />;
    case "money":
      return <span className="fw-money"><input type="number" value={v == null ? "" : Number(v) / 100} min={field.min} max={field.max} step="0.01" placeholder="元" onChange={(e) => onChange?.(e.target.value === "" ? undefined : Math.round(Number(e.target.value) * 100))} /><i>元</i></span>;
    case "radio":
      return (
        <span className="fw-options">
          {(field.options ?? []).filter((o) => o.trim()).map((o) => (
            <label key={o} className="check-field"><input type="radio" checked={v === o} onChange={() => onChange?.(o)} />{o}</label>
          ))}
        </span>
      );
    case "multi":
      return (
        <span className="fw-options">
          {(field.options ?? []).filter((o) => o.trim()).map((o) => (
            <label key={o} className="check-field">
              <input type="checkbox" checked={Array.isArray(v) && (v as unknown[]).includes(o)} onChange={(e) => {
                const cur = Array.isArray(v) ? [...(v as unknown[])] : [];
                onChange?.(e.target.checked ? [...cur, o] : cur.filter((x) => x !== o));
              }} />
              {o}
            </label>
          ))}
        </span>
      );
    case "date":
      return <input type="date" value={String(v ?? "")} onChange={(e) => onChange?.(e.target.value || undefined)} />;
    case "daterange":
      return (
        <span className="owner-line">
          <input type="date" aria-label="开始日期" value={Array.isArray(v) ? String(v[0] ?? "") : ""} onChange={(e) => onChange?.([e.target.value, Array.isArray(v) ? v[1] : undefined])} />
          <input type="date" aria-label="结束日期" value={Array.isArray(v) ? String(v[1] ?? "") : ""} onChange={(e) => onChange?.([Array.isArray(v) ? v[0] : undefined, e.target.value])} />
        </span>
      );
    case "person":
      return <UserPicker value={typeof v === "string" ? v : ""} onChange={(id) => onChange?.(id || undefined)} />;
    case "file":
      return <FileField value={v} readonly={false} onChange={(id) => onChange?.(id)} />;
    default:
      return <span className="list-note">未知控件 {field.control}</span>;
  }
  void payload; void editable;
}

/** 只读视图（详情/快照）：fields 已由调用方按 fieldPerms 过滤 */
export function FormReadonlyView({ fields, payload, PersonNames }: { fields: FormFieldDef[]; payload: FormPayload; PersonNames?: (id: string) => string }) {
  return (
    <div className="fw-ro-form">
      {fields.map((f) => (
        <div key={f.key} className="fw-ro-row">
          <span className="fw-ro-label">{f.label}</span>
          {f.control === "person" && typeof payload[f.key] === "string" && PersonNames ? (
            <span className="fw-ro-value">{PersonNames(String(payload[f.key]))}</span>
          ) : f.control === "file" ? (
            <FileField value={payload[f.key]} readonly />
          ) : (
            <FormFieldControl field={f} value={payload[f.key]} payload={payload} editable={false} readonly />
          )}
        </div>
      ))}
    </div>
  );
}
