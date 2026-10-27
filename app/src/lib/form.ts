import type { FieldPath, FieldValues, UseFormSetError } from "react-hook-form";

import { businessCodeOf, fieldErrorsOf } from "./trpc";

/** 表单挂载/打开时生成的幂等键（arch/02 §8） */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * 服务端字段错误映射到 react-hook-form（VALIDATION_FAILED 的 fieldErrors）。
 * 返回 true 表示已按字段错误处理。
 */
export function applyServerFieldErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
): boolean {
  const fieldErrors = fieldErrorsOf(error);
  if (!fieldErrors) return false;
  for (const [field, messages] of Object.entries(fieldErrors)) {
    const message = messages[0] ?? "输入无效";
    const path = field as FieldPath<T>;
    try {
      setError(path, { message });
    } catch {
      // 字段不存在于表单时落入根错误
      setError("root" as FieldPath<T>, { message });
    }
  }
  return true;
}

/** 页面级/根错误文案：STATE_CONFLICT 保留输入提示刷新，其余用服务端统一文案 */
export function rootErrorMessage(error: unknown): string {
  if (businessCodeOf(error) === "STATE_CONFLICT") {
    return "数据已被他人变更（版本冲突），请刷新后重试；已填写内容已保留。";
  }
  if (error instanceof Error && error.message) return error.message;
  return "操作失败，请稍后重试。";
}

/** 平铺日期（YYYY-MM-DD，服务端 date 字段原样返回） */
export function fmtDate(d: string | null | undefined): string {
  return d ? d.slice(0, 10) : "—";
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
