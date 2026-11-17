import type { CustomFormSchema, FormControlType, FormFieldDef } from "@lexflow/shared";

/** 自定义表单字段模型与校验（arch/14 §4）：由表单设计步与向导保存前预检共用 */

export const CONTROL_LABEL: Record<FormControlType, string> = {
  text: "单行文本",
  textarea: "多行文本",
  note: "说明（只读）",
  number: "数字",
  money: "金额（元）",
  radio: "单选",
  multi: "多选",
  date: "日期",
  daterange: "日期区间",
  person: "人员",
  file: "附件",
};

export const KEY_RE = /^[a-z][a-z0-9_]{0,29}$/;

export function newField(control: FormControlType, existing: FormFieldDef[]): FormFieldDef {
  let i = existing.length + 1;
  let key = `field_${i}`;
  while (existing.some((f) => f.key === key)) {
    i += 1;
    key = `field_${i}`;
  }
  const base: FormFieldDef = { key, label: CONTROL_LABEL[control], control, required: false };
  if (control === "radio" || control === "multi") base.options = ["选项 1", "选项 2"];
  if (control === "note") base.required = false;
  return base;
}

export function validateSchema(schema: CustomFormSchema): Record<string, string> {
  const errs: Record<string, string> = {};
  const keys = new Set<string>();
  schema.fields.forEach((f, i) => {
    const p = `fields.${i}`;
    if (!f.label.trim()) errs[`${p}.label`] = "标题必填";
    if (!KEY_RE.test(f.key)) errs[`${p}.key`] = "key 须小写字母开头，含小写字母/数字/下划线（≤30）";
    if (keys.has(f.key)) errs[`${p}.key`] = "key 必须唯一";
    keys.add(f.key);
    if ((f.control === "radio" || f.control === "multi") && (!f.options || f.options.filter((o) => o.trim()).length === 0))
      errs[`${p}.options`] = "选项集不能为空";
    if ((f.control === "number" || f.control === "money") && f.min != null && f.max != null && f.min > f.max)
      errs[`${p}.range`] = "最小值不能大于最大值";
  });
  return errs;
}
