import { TRPCError } from "@trpc/server";

import { ERROR_CODE, type ErrorCode } from "@lexflow/shared";

/** 业务错误码 → tRPC code 映射（arch/02 §6，冻结） */
const TRPC_CODE_BY_BUSINESS: Record<ErrorCode, TRPCError["code"]> = {
  AUTH_REQUIRED: "UNAUTHORIZED",
  ACCESS_DENIED_OR_GONE: "NOT_FOUND",
  VALIDATION_FAILED: "BAD_REQUEST",
  STATE_CONFLICT: "CONFLICT",
  DUPLICATE_SUBMIT: "CONFLICT",
  SELF_APPROVAL_BLOCKED: "FORBIDDEN",
  SELF_REVIEW_BLOCKED: "FORBIDDEN",
  POLICY_NOT_FOUND: "PRECONDITION_FAILED",
  FLOW_INVALID: "BAD_REQUEST",
  FLOW_UNPUBLISHABLE: "PRECONDITION_FAILED",
  BUDGET_EXCEEDED: "CONFLICT",
  DUPLICATE_RECEIPT: "CONFLICT",
  PERIOD_LOCKED: "FORBIDDEN",
  ARCHIVED_READONLY: "FORBIDDEN",
  INTERNAL: "INTERNAL_SERVER_ERROR",
};

export interface FieldErrors {
  [field: string]: string[] | undefined;
}

/**
 * 业务错误：携带冻结业务错误码，经 errorFormatter 统一输出形状（arch/02 §6、arch/00 §6）。
 * cause 即本实例，formatter 据此取 businessCode / fieldErrors。
 */
export class BusinessError extends TRPCError {
  readonly businessCode: ErrorCode;
  readonly fieldErrors?: FieldErrors;
  /** 错误数据载体（如 DUPLICATE_RECEIPT 的原报销定位 code/id），随 data.details 输出 */
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, fieldErrors?: FieldErrors, details?: Record<string, unknown>) {
    super({ code: TRPC_CODE_BY_BUSINESS[code], message });
    this.businessCode = code;
    this.fieldErrors = fieldErrors;
    this.details = details;
    // tRPC v11 结果流中 error.cause 在传导中丢失：formatter 同时认 error/cause 两种入口
    Object.defineProperty(this, "cause", { value: this, configurable: true, writable: true });
    Object.setPrototypeOf(this, BusinessError.prototype);
  }
}

/** 提取 Postgres 驱动错误码：drizzle 包装后 pg 原生错误在 error.cause 上，部分路径直接抛原生错误在 error.code 上 */
export function pgErrorCode(error: unknown): string | undefined {
  const direct = (error as { code?: string } | null)?.code;
  if (direct) return direct;
  const cause = (error as { cause?: unknown } | null)?.cause;
  return (cause as { code?: string } | null)?.code;
}

export function businessCodeFromTrpcCode(code: TRPCError["code"]): ErrorCode {
  switch (code) {
    case "UNAUTHORIZED":
      return ERROR_CODE.AUTH_REQUIRED;
    case "NOT_FOUND":
      return ERROR_CODE.ACCESS_DENIED_OR_GONE;
    case "BAD_REQUEST":
      return ERROR_CODE.VALIDATION_FAILED;
    case "CONFLICT":
      return ERROR_CODE.STATE_CONFLICT;
    case "FORBIDDEN":
      return ERROR_CODE.SELF_APPROVAL_BLOCKED;
    default:
      return ERROR_CODE.INTERNAL;
  }
}

/**
 * tRPC 统一错误形状（前后端一致）：
 * { ...shape, data: { businessCode, requestId, fieldErrors? } }
 * - zod 字段错误 → VALIDATION_FAILED + fieldErrors 字段映射
 * - 兜底 INTERNAL 无堆栈，带 requestId
 */
export function formatTrpcError(opts: {
  shape: { message: string; code: number; data: unknown };
  error: unknown & {
    code?: string;
    cause?: unknown;
    message?: string;
  };
  ctx?: unknown;
}): { message: string; code: number; data: unknown } {
  const { shape, error, ctx } = opts;
  const requestId =
    (ctx as { requestId?: string } | undefined)?.requestId ?? undefined;

  let businessCode: ErrorCode | undefined;
  let fieldErrors: FieldErrors | undefined;

  const cause = error instanceof BusinessError ? error : error.cause;
  if (cause instanceof BusinessError) {
    businessCode = cause.businessCode;
    fieldErrors = cause.fieldErrors;
  } else if (isZodError(error.cause)) {
    businessCode = ERROR_CODE.VALIDATION_FAILED;
    fieldErrors = {};
    for (const issue of (error.cause as ZodLikeError).issues) {
      const key = issue.path.length > 0 ? issue.path.map(String).join(".") : "_";
      const list = (fieldErrors[key] ??= []);
      list.push(issue.message);
    }
  }

  if (!businessCode) {
    businessCode =
      error.code === "INTERNAL_SERVER_ERROR"
        ? ERROR_CODE.INTERNAL
        : businessCodeFromTrpcCode(error.code as TRPCError["code"]);
  }

  return {
    message:
      businessCode === ERROR_CODE.INTERNAL ? "服务器内部错误" : shape.message,
    code: shape.code,
    data: {
      businessCode,
      requestId,
      ...(fieldErrors ? { fieldErrors } : {}),
      ...(cause instanceof BusinessError && cause.details ? { details: cause.details } : {}),
    },
  };
}

interface ZodLikeError {
  issues: { path: PropertyKey[]; message: string }[];
}

function isZodError(cause: unknown): cause is ZodLikeError {
  return (
    typeof cause === "object" &&
    cause !== null &&
    Array.isArray((cause as ZodLikeError).issues)
  );
}
