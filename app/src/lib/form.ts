import type { FieldPath, FieldValues, UseFormSetError } from "react-hook-form";

import { businessCodeOf, fieldErrorsOf } from "./trpc";

/**
 * 统一客户端 ID 生成入口（19-01：外测 HTTP 非安全上下文兼容——部分浏览器不提供 crypto.randomUUID）。
 * 三级策略：crypto.randomUUID 优先 → getRandomValues 构造 RFC4122 v4 → 进程内计数器+时间戳最后兜底
 * （兜底仅作混合熵源之一，不单独依赖 Math.random）；返回值恒满足 uuid zod 校验格式。
 */

/** getRandomValues 路径：16 字节随机数 + version/variant 位（RFC4122 v4） */
function uuidViaGetRandomValues(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version = 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant = 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

let fallbackCounter = 0;

/** 最后兜底：时间戳（48bit）+ 进程内计数器 + Math.random 混合（不单独依赖其一），保持 v4 形态 */
function uuidFallback(): string {
  fallbackCounter = (fallbackCounter + 1) >>> 0;
  const t = Date.now();
  const r = Math.floor(Math.random() * 0xffffffff) >>> 0;
  const h = (n: number, w: number) => (n >>> 0).toString(16).padStart(w, "0");
  const time48 = ((BigInt(t) << 16n) | BigInt(fallbackCounter & 0xffff)).toString(16).padStart(12, "0");
  const randMix = (r ^ (fallbackCounter * 2654435761)) >>> 0;
  return [
    time48.slice(0, 8),
    time48.slice(8, 12),
    `4${h(randMix & 0xfff, 3)}`,
    `${["8", "9", "a", "b"][randMix >>> 30]}${h((randMix >>> 12) & 0xfff, 3)}`,
    `${h((randMix >>> 4) & 0xffff, 4)}${h((fallbackCounter ^ r) & 0xffffff, 6)}${h((t ^ fallbackCounter) & 0xff, 2)}`,
  ].join("-");
}

/** 客户端 UUID 生成唯一入口（幂等键/行 key/参与人 key 等全部经此） */
export function newClientKey(): string {
  const c: Crypto | undefined = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  if (typeof c?.getRandomValues === "function") return uuidViaGetRandomValues();
  return uuidFallback();
}

/** 表单挂载/打开时生成的幂等键（arch/02 §8；19-01 起委托 newClientKey 兼容非安全上下文） */
export function newIdempotencyKey(): string {
  return newClientKey();
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
