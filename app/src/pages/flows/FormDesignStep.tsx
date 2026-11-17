import { useState } from "react";

import type { CustomFormSchema, FormControlType, FormFieldDef } from "@lexflow/shared";
import { FORM_CONTROL_TYPE } from "@lexflow/shared";
import { CONTROL_LABEL, newField, validateSchema } from "./form-model";

/**
 * ② 表单设计步（arch/14 §4）：左控件库（11 控件）+ 中手机式预览画布 + 右字段属性抽屉。
 * 校验：key 唯一/合法、选项类 options 非空、min≤max（保存前客户端预检，服务端 400 落位由向导承接）。
 */

export function FormDesignStep({ schema, onChange }: { schema: CustomFormSchema; onChange: (s: CustomFormSchema) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const sel = schema.fields.find((f) => f.key === selected) ?? null;

  const patchField = (key: string, p: Partial<FormFieldDef>) => {
    onChange({ fields: schema.fields.map((f) => (f.key === key ? { ...f, ...p } : f)) });
    setFieldErr((e) => {
      const n = { ...e };
      for (const k of Object.keys(n)) if (k.startsWith(`fields.${schema.fields.findIndex((x) => x.key === key)}`)) delete n[k];
      return n;
    });
  };

  const add = (control: FormControlType) => {
    const f = newField(control, schema.fields);
    onChange({ fields: [...schema.fields, f] });
    setSelected(f.key);
  };

  const move = (key: string, dir: -1 | 1) => {
    const i = schema.fields.findIndex((f) => f.key === key);
    const j = i + dir;
    if (j < 0 || j >= schema.fields.length) return;
    const next = [...schema.fields];
    [next[i], next[j]] = [next[j], next[i]];
    onChange({ fields: next });
  };

  const errOf = (suffix: string) => {
    const idx = sel ? schema.fields.findIndex((f) => f.key === sel.key) : -1;
    return idx >= 0 ? fieldErr[`fields.${idx}.${suffix}`] : undefined;
  };

  return (
    <div className="fw-formdesign">
      <div className="fw-palette">
        <span className="section-label">控件库（点击加入画布）</span>
        {FORM_CONTROL_TYPE.map((c) => (
          <button key={c} type="button" className="fw-palette-item" onClick={() => add(c)}>
            ＋ {CONTROL_LABEL[c]}
          </button>
        ))}
      </div>
      <div className="fw-canvas">
        <span className="section-label">表单预览（手机式）</span>
        <div className="fw-phone">
          {schema.fields.length === 0 ? (
            <p className="fw-empty">点击或拖拽左侧控件至此处</p>
          ) : (
            schema.fields.map((f, i) => (
              <div key={f.key} className={`fw-field-card ${selected === f.key ? "selected" : ""}`} onClick={() => setSelected(f.key)}>
                <div className="fw-field-head">
                  <strong>{f.label}{f.required ? <i className="req">*</i> : null}</strong>
                  <span className="p9a-row-actions" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="text-action" disabled={i === 0} onClick={() => move(f.key, -1)}>↑</button>
                    <button type="button" className="text-action" disabled={i === schema.fields.length - 1} onClick={() => move(f.key, 1)}>↓</button>
                    <button type="button" className="text-action" onClick={() => { onChange({ fields: schema.fields.filter((x) => x.key !== f.key) }); if (selected === f.key) setSelected(null); }}>删除</button>
                  </span>
                </div>
                <small className="mono">{f.control} · {f.key}</small>
              </div>
            ))
          )}
        </div>
      </div>
      <div className="fw-props">
        <span className="section-label">字段属性</span>
        {!sel ? (
          <p className="list-note">选中画布字段以配置属性。</p>
        ) : (
          <>
            <label className="form-field">
              <span>标题 *</span>
              <input value={sel.label} onChange={(e) => patchField(sel.key, { label: e.target.value })} />
              {errOf("label") ? <em className="ux-err">{errOf("label")}</em> : null}
            </label>
            <label className="form-field">
              <span>key（自动生成可改）</span>
              <input value={sel.key} onChange={(e) => patchField(sel.key, { key: e.target.value })} />
              {errOf("key") ? <em className="ux-err">{errOf("key")}</em> : null}
            </label>
            <label className="check-field">
              <input type="checkbox" checked={sel.required} onChange={(e) => patchField(sel.key, { required: e.target.checked })} />
              必填
            </label>
            {sel.control !== "note" ? (
              <label className="form-field">
                <span>占位提示</span>
                <input value={sel.placeholder ?? ""} onChange={(e) => patchField(sel.key, { placeholder: e.target.value || undefined })} />
              </label>
            ) : null}
            {sel.control === "radio" || sel.control === "multi" ? (
              <label className="form-field">
                <span>选项集（每行一个）</span>
                <textarea rows={3} value={(sel.options ?? []).join("\n")} onChange={(e) => patchField(sel.key, { options: e.target.value.split("\n") })} />
                {errOf("options") ? <em className="ux-err">{errOf("options")}</em> : null}
              </label>
            ) : null}
            {sel.control === "number" || sel.control === "money" ? (
              <div className="owner-line">
                <label className="form-field">
                  <span>最小值</span>
                  <input type="number" value={sel.min ?? ""} onChange={(e) => patchField(sel.key, { min: e.target.value === "" ? undefined : Number(e.target.value) })} />
                </label>
                <label className="form-field">
                  <span>最大值</span>
                  <input type="number" value={sel.max ?? ""} onChange={(e) => patchField(sel.key, { max: e.target.value === "" ? undefined : Number(e.target.value) })} />
                </label>
                {errOf("range") ? <em className="ux-err">{errOf("range")}</em> : null}
              </div>
            ) : null}
            <button type="button" className="secondary-action" onClick={() => setFieldErr(validateSchema(schema))}>
              校验表单
            </button>
            {Object.keys(fieldErr).length > 0 ? <p className="form-error" role="alert">{Object.values(fieldErr)[0]}</p> : null}
          </>
        )}
      </div>
    </div>
  );
}
