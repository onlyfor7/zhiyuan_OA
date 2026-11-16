import { and, desc, eq, sql } from "drizzle-orm";

import { ERROR_CODE, FORM_CONTROL_TYPE, type CustomFormSchema, type FormFieldDef } from "@lexflow/shared";

import { customFormDefs, flowDefinitions, users } from "../../db/schema";
import { nextCode } from "../../db/code";
import { BusinessError } from "../../lib/errors";
import { recordAudit } from "../../services/audit";
import { assertFlowPublishable } from "../../services/approval/flow";
import { publishFlowRow } from "../flow/designer";
import type { DbOrTx } from "../../trpc/context";
import type { SessionUser } from "../../modules/auth/session";

/**
 * 自定义表单服务端（arch/14 §4；迭代 20 工单 §3）：CRUD + 绑定流程联动 + payload 校验。
 * 管理门=sysadmin/partner（与流程管理同门槛）；提交链在 requests/generic.ts 接线。
 */

async function requireFormAdmin(_db: DbOrTx, user: SessionUser): Promise<void> {
  if (user.globalRoles.includes("sysadmin") || user.globalRoles.includes("partner")) return;
  throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "表单不存在或无权访问");
}

function notFound(): BusinessError {
  return new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "表单不存在或无权访问");
}

/* ===== form_schema 校验（arch/14 §4.2 P1 控件库；返回字段级错误映射，空=合法） ===== */

const KEY_RE = /^[a-z][a-z0-9_]{0,49}$/;
const OPTION_CONTROLS = new Set(["radio", "multi"]);
const RANGE_CONTROLS = new Set(["number", "money"]);

export function validateFormSchema(raw: unknown): { schema: CustomFormSchema; errors: Record<string, string[]> } {
  const errors: Record<string, string[]> = {};
  const r = (raw ?? {}) as { fields?: unknown };
  if (!Array.isArray(r.fields)) {
    return { schema: { fields: [] }, errors: { formSchema: ["form_schema.fields 须为数组"] } };
  }
  const seen = new Set<string>();
  const fields: FormFieldDef[] = [];
  r.fields.forEach((f, i) => {
    const field = f as Partial<FormFieldDef>;
    const label = `fields[${i}]`;
    const key = typeof field.key === "string" ? field.key.trim() : "";
    if (!KEY_RE.test(key)) {
      errors[label] = [...(errors[label] ?? []), `key 非法（小写字母开头，小写字母/数字/_，≤50）`];
    } else if (seen.has(key)) {
      errors[label] = [...(errors[label] ?? []), `key 重复：${key}`];
    }
    seen.add(key);
    if (!field.label?.trim()) errors[label] = [...(errors[label] ?? []), "标题必填"];
    if (!FORM_CONTROL_TYPE.includes(field.control as never)) {
      errors[label] = [...(errors[label] ?? []), `控件非法：${String(field.control)}`];
      return;
    }
    const control = field.control as FormFieldDef["control"];
    if (OPTION_CONTROLS.has(control)) {
      if (!Array.isArray(field.options) || field.options.length === 0 || field.options.some((o) => typeof o !== "string" || !o.trim())) {
        errors[label] = [...(errors[label] ?? []), "选项类控件 options 须为非空字符串数组"];
      }
    }
    if (RANGE_CONTROLS.has(control)) {
      if (field.min !== undefined && typeof field.min !== "number") errors[label] = [...(errors[label] ?? []), "min 须为数字"];
      if (field.max !== undefined && typeof field.max !== "number") errors[label] = [...(errors[label] ?? []), "max 须为数字"];
      if (typeof field.min === "number" && typeof field.max === "number" && field.min > field.max) {
        errors[label] = [...(errors[label] ?? []), "数值范围 min≤max"];
      }
    }
    if (control === "person" || control === "file") {
      if (field.options !== undefined) errors[label] = [...(errors[label] ?? []), "人员/附件控件为单值，不设 options"];
    }
    if (Object.keys(errors).length === 0 || !errors[label]) {
      fields.push({
        key,
        label: field.label!.trim(),
        control,
        required: field.required === true,
        ...(field.placeholder ? { placeholder: field.placeholder } : {}),
        ...(Array.isArray(field.options) ? { options: field.options as string[] } : {}),
        ...(typeof field.min === "number" ? { min: field.min } : {}),
        ...(typeof field.max === "number" ? { max: field.max } : {}),
      });
    }
  });
  return { schema: { fields }, errors };
}

function visibilityOf(raw: unknown): Record<string, unknown> {
  const v = (raw ?? { mode: "all" }) as Record<string, unknown>;
  const mode = v.mode === "roles" || v.mode === "users" ? v.mode : "all";
  return {
    mode,
    ...(Array.isArray(v.roleKeys) ? { roleKeys: v.roleKeys } : {}),
    ...(Array.isArray(v.userIds) ? { userIds: v.userIds } : {}),
  };
}

/** 新建自定义表单：CF 编号 + 同事务建绑定流程草稿（bizBinding=custom_form:<code>，definition_version=2） */
export async function createForm(
  db: DbOrTx,
  user: SessionUser,
  input: { name: string; description?: string; icon?: string | null; groupName?: string; visibility?: unknown; formSchema?: unknown },
  ip: string | null,
  sessionId: string | null,
) {
  await requireFormAdmin(db, user);
  if (!input.name.trim()) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "表单名称必填", { name: ["表单名称必填"] });
  const { schema, errors } = validateFormSchema(input.formSchema ?? { fields: [] });
  if (Object.keys(errors).length > 0) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "表单结构非法", errors);
  }
  const code = await nextCode("CF", db);
  const bizBinding = `custom_form:${code}`;
  const [flow] = await db
    .insert(flowDefinitions)
    .values({
      name: `${input.name.trim()}审批流`,
      scope: "global",
      bizBinding,
      versionNo: 1,
      definitionJson: {
        schemaVersion: 2,
        settings: { allowWithdrawPending: true, dedupeApprover: "once", titleTemplate: null, summaryFieldKeys: [] },
        nodes: [],
      },
      enabled: false,
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning({ id: flowDefinitions.id });
  if (!flow) throw new Error("绑定流程插入失败");
  const [row] = await db
    .insert(customFormDefs)
    .values({
      code,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      icon: input.icon?.trim() || null,
      groupName: input.groupName?.trim() || "通用",
      visibility: visibilityOf(input.visibility),
      formSchema: schema as unknown as Record<string, unknown>,
      flowId: flow.id,
      status: "draft",
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning();
  if (!row) throw new Error("表单插入失败");
  await recordAudit(db, { actorId: user.id, sessionId, action: "forms.create", targetType: "custom_form", targetId: row.id, result: "success", afterJson: { code, name: row.name }, ip });
  return row;
}

export async function updateFormDraft(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number; name?: string; description?: string; icon?: string | null; groupName?: string; visibility?: unknown; formSchema?: unknown },
  ip: string | null,
  sessionId: string | null,
) {
  await requireFormAdmin(db, user);
  const [before] = await db.select().from(customFormDefs).where(eq(customFormDefs.id, input.id)).limit(1);
  if (!before) throw notFound();
  if (before.status !== "draft") {
    // arch/14 §4.1：published 后结构冻结，改动须产新 form_version（本棒最小集：409 语义）
    throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "已发布表单结构冻结（须停用后重建或产新版本）");
  }
  let schema = before.formSchema as unknown as CustomFormSchema;
  if (input.formSchema !== undefined) {
    const v = validateFormSchema(input.formSchema);
    if (Object.keys(v.errors).length > 0) throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "表单结构非法", v.errors);
    schema = v.schema;
  }
  const [updated] = await db
    .update(customFormDefs)
    .set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description.trim() } : {}),
      ...(input.icon !== undefined ? { icon: input.icon?.trim() || null } : {}),
      ...(input.groupName !== undefined ? { groupName: input.groupName.trim() || "通用" } : {}),
      ...(input.visibility !== undefined ? { visibility: visibilityOf(input.visibility) } : {}),
      ...(input.formSchema !== undefined ? { formSchema: schema as unknown as Record<string, unknown> } : {}),
      updatedBy: user.id,
      updatedAt: new Date().toISOString(),
      rowVersion: sql`${customFormDefs.rowVersion} + 1`,
    })
    .where(and(eq(customFormDefs.id, input.id), eq(customFormDefs.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "表单已被他人修改，请刷新后重试");
  await recordAudit(db, { actorId: user.id, sessionId, action: "forms.updateDraft", targetType: "custom_form", targetId: input.id, result: "success", afterJson: { name: updated.name }, ip });
  return updated;
}

/** 发布：联动绑定流程发布校验（assertFlowPublishable 双读）+ 状态机 draft→published + flow enabled */
export async function publishForm(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number },
  ip: string | null,
  sessionId: string | null,
) {
  await requireFormAdmin(db, user);
  const [form] = await db.select().from(customFormDefs).where(eq(customFormDefs.id, input.id)).limit(1);
  if (!form) throw notFound();
  if (form.status !== "draft") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅草稿表单可发布");
  if (!form.flowId) throw new BusinessError(ERROR_CODE.INTERNAL, "表单未绑定流程（数据异常）");
  const [flow] = await db.select().from(flowDefinitions).where(eq(flowDefinitions.id, form.flowId)).limit(1);
  if (!flow) throw new BusinessError(ERROR_CODE.INTERNAL, "绑定流程缺失（数据异常）");
  const resolveKind = async (kind: string, role: string | null, userId: string | null): Promise<string[]> => {
    if (kind === "user") return userId ? [userId] : [];
    if (kind === "role") {
      const { userRoles } = await import("../../db/schema");
      const rows = await db.select({ userId: userRoles.userId }).from(userRoles).where(eq(userRoles.roleKey, role!));
      return rows.map((r) => r.userId);
    }
    return ["__runtime__"]; // 运行时解析类：发布不预判
  };
  await assertFlowPublishable(db, flow.definitionJson, resolveKind, flow.bizBinding);
  await publishFlowRow(db, user.id, flow, crypto.randomUUID());
  const [updated] = await db
    .update(customFormDefs)
    .set({ status: "published", updatedBy: user.id, updatedAt: new Date().toISOString(), rowVersion: sql`${customFormDefs.rowVersion} + 1` })
    .where(and(eq(customFormDefs.id, input.id), eq(customFormDefs.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "表单已被他人修改，请刷新后重试");
  await recordAudit(db, { actorId: user.id, sessionId, action: "forms.publish", targetType: "custom_form", targetId: input.id, result: "success", afterJson: { code: form.code, flowId: flow.id }, ip });
  return updated;
}

export async function disableForm(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string; rowVersion: number },
  ip: string | null,
  sessionId: string | null,
) {
  await requireFormAdmin(db, user);
  const [form] = await db.select().from(customFormDefs).where(eq(customFormDefs.id, input.id)).limit(1);
  if (!form) throw notFound();
  if (form.status !== "published") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅已发布表单可停用");
  const [updated] = await db
    .update(customFormDefs)
    .set({ status: "disabled", updatedBy: user.id, updatedAt: new Date().toISOString(), rowVersion: sql`${customFormDefs.rowVersion} + 1` })
    .where(and(eq(customFormDefs.id, input.id), eq(customFormDefs.rowVersion, input.rowVersion)))
    .returning();
  if (!updated) throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "表单已被他人修改，请刷新后重试");
  if (form.flowId) {
    await db.update(flowDefinitions).set({ enabled: false, updatedAt: new Date().toISOString() }).where(eq(flowDefinitions.id, form.flowId));
  }
  await recordAudit(db, { actorId: user.id, sessionId, action: "forms.disable", targetType: "custom_form", targetId: input.id, result: "success", afterJson: { code: form.code }, ip });
  return updated;
}

export async function deleteForm(
  db: DbOrTx,
  user: SessionUser,
  input: { id: string },
  ip: string | null,
  sessionId: string | null,
) {
  await requireFormAdmin(db, user);
  const [form] = await db.select().from(customFormDefs).where(eq(customFormDefs.id, input.id)).limit(1);
  if (!form) throw notFound();
  if (form.status !== "draft") throw new BusinessError(ERROR_CODE.STATE_CONFLICT, "仅草稿表单可删除");
  await db.delete(customFormDefs).where(eq(customFormDefs.id, input.id));
  if (form.flowId) {
    const [flow] = await db.select({ enabled: flowDefinitions.enabled }).from(flowDefinitions).where(eq(flowDefinitions.id, form.flowId)).limit(1);
    if (flow && !flow.enabled) await db.delete(flowDefinitions).where(eq(flowDefinitions.id, form.flowId));
  }
  await recordAudit(db, { actorId: user.id, sessionId, action: "forms.delete", targetType: "custom_form", targetId: input.id, result: "success", beforeJson: { code: form.code, name: form.name }, ip });
  return { id: input.id, deleted: true as const };
}

export async function listForms(db: DbOrTx, user: SessionUser) {
  await requireFormAdmin(db, user);
  const rows = await db.select().from(customFormDefs).orderBy(desc(customFormDefs.updatedAt));
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const g = row.groupName || "通用";
    groups.set(g, [...(groups.get(g) ?? []), row]);
  }
  return {
    items: rows,
    byGroup: [...groups.entries()].map(([groupName, items]) => ({ groupName, items })),
  };
}

export async function getFormById(db: DbOrTx, user: SessionUser, id: string) {
  await requireFormAdmin(db, user);
  const [row] = await db.select().from(customFormDefs).where(eq(customFormDefs.id, id)).limit(1);
  if (!row) throw notFound();
  return row;
}

/** 发起入口公开读：按 visibility 过滤（mode all/roles/users） */
export async function listPublicForms(db: DbOrTx, user: SessionUser) {
  const rows = await db.select().from(customFormDefs).where(eq(customFormDefs.status, "published")).orderBy(desc(customFormDefs.updatedAt));
  const visible = rows.filter((row) => {
    const v = row.visibility as { mode?: string; roleKeys?: string[]; userIds?: string[] };
    if (v.mode === "roles") return (v.roleKeys ?? []).some((r) => user.globalRoles.includes(r));
    if (v.mode === "users") return (v.userIds ?? []).includes(user.id);
    return true;
  });
  return visible.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    icon: r.icon,
    groupName: r.groupName,
    formVersion: r.formVersion,
  }));
}

/* ===== 提交链辅助（requests/generic.ts 调用） ===== */

/** 按 code 取已发布表单 + visibility 校验 */
export async function loadPublishedFormForSubmit(db: DbOrTx, user: SessionUser, code: string) {
  const [form] = await db.select().from(customFormDefs).where(eq(customFormDefs.code, code)).limit(1);
  if (!form || form.status !== "published") return { form: null as never, fieldErrors: { requestType: ["表单不存在或未发布"] } };
  const v = form.visibility as { mode?: string; roleKeys?: string[]; userIds?: string[] };
  const ok = v.mode === "roles"
    ? (v.roleKeys ?? []).some((r) => user.globalRoles.includes(r))
    : v.mode === "users"
      ? (v.userIds ?? []).includes(user.id)
      : true;
  if (!ok) return { form: null as never, fieldErrors: { requestType: ["无权提交该表单（visibility 不满足）"] } };
  return { form, fieldErrors: null as never };
}

/** payload 按 form_schema 逐字段校验（提交时快照 form_version）；返回 fieldErrors（key=payload.<key>） */
export function validatePayloadAgainstSchema(
  schema: CustomFormSchema,
  payload: Record<string, unknown>,
): Record<string, string[]> {
  const errors: Record<string, string[]> = {};
  for (const field of schema.fields) {
    const value = payload[field.key];
    const label = `payload.${field.key}`;
    const empty = value === undefined || value === null || value === "";
    if (field.required && empty) {
      errors[label] = [...(errors[label] ?? []), "必填"];
      continue;
    }
    if (empty) continue;
    switch (field.control) {
      case "text":
      case "textarea":
      case "note":
        if (typeof value !== "string") errors[label] = [...(errors[label] ?? []), "须为字符串"];
        break;
      case "number":
      case "money": {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          errors[label] = [...(errors[label] ?? []), "须为数字"];
          break;
        }
        if (field.min !== undefined && value < field.min) errors[label] = [...(errors[label] ?? []), `小于最小值 ${field.min}`];
        if (field.max !== undefined && value > field.max) errors[label] = [...(errors[label] ?? []), `大于最大值 ${field.max}`];
        break;
      }
      case "radio":
        if (typeof value !== "string" || !(field.options ?? []).includes(value)) errors[label] = [...(errors[label] ?? []), "选项不在域内"];
        break;
      case "multi":
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string") || (field.options ?? []) && value.some((v) => !(field.options ?? []).includes(v))) {
          errors[label] = [...(errors[label] ?? []), "须为选项域内字符串数组"];
        }
        break;
      case "date":
        if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) errors[label] = [...(errors[label] ?? []), "须为 YYYY-MM-DD"];
        break;
      case "daterange":
        if (!Array.isArray(value) || value.length !== 2 || value.some((v) => typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v))) {
          errors[label] = [...(errors[label] ?? []), "须为 [开始, 结束] 日期二元组"];
        }
        break;
      case "person":
        if (typeof value !== "string") errors[label] = [...(errors[label] ?? []), "人员控件值为用户 id"];
        break;
      case "file":
        if (typeof value !== "string") errors[label] = [...(errors[label] ?? []), "附件控件值为文件版本 id"];
        break;
    }
  }
  return errors;
}

/** person/file 引用存在与启用态复核（DB 级，提交时同事务） */
export async function validatePayloadRefs(db: DbOrTx, schema: CustomFormSchema, payload: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors: Record<string, string[]> = {};
  for (const field of schema.fields) {
    const value = payload[field.key];
    if (value === undefined || value === null || value === "") continue;
    if (field.control === "person") {
      const [u] = await db.select({ id: users.id, status: users.status }).from(users).where(eq(users.id, String(value))).limit(1);
      if (!u) errors[`payload.${field.key}`] = ["人员不存在"];
      else if (u.status !== "active") errors[`payload.${field.key}`] = ["人员已停用"];
    }
    if (field.control === "file") {
      const { fileVersions } = await import("../../db/schema");
      const [fv] = await db.select({ id: fileVersions.id }).from(fileVersions).where(eq(fileVersions.id, String(value))).limit(1);
      if (!fv) errors[`payload.${field.key}`] = ["附件不存在"];
    }
  }
  return errors;
}
