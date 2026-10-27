import { Hono, type Context as HonoContext } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";

import { ERROR_CODE, SOURCE_TYPE } from "@lexflow/shared";

import { db } from "../db/client";
import { BusinessError } from "../lib/errors";
import { SESSION_COOKIE, resolveSession, type ResolvedSession } from "../modules/auth/session";
import { canReadFile, findFileVersion } from "../services/access";
import { recordAudit } from "../services/audit";
import { readVersion, saveUpload } from "../services/file/service";
import { verifyDownloadToken } from "../services/file/tokens";

/**
 * 文件路由（arch/00 §5、arch/02 §4：Hono 原生，二进制不走 tRPC）。
 * 鉴权：session cookie 或 ≤15min 短期令牌；无权限与不存在同形 404（arch/03 §5）。
 */

const uploadInputSchema = z.object({
  sourceType: z.enum(SOURCE_TYPE),
  sourceId: z.uuid(),
  businessDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "业务日期须为 YYYY-MM-DD")
    .optional(),
  idempotencyKey: z.string().max(100).optional(),
});

type FilesEnv = { Variables: { requestId: string } };

function requestId(c: HonoContext<FilesEnv>): string {
  return c.get("requestId") ?? "unknown";
}

function statusOf(code: string): number {
  switch (code) {
    case ERROR_CODE.AUTH_REQUIRED:
      return 401;
    case ERROR_CODE.ACCESS_DENIED_OR_GONE:
      return 404;
    case ERROR_CODE.VALIDATION_FAILED:
      return 400;
    case ERROR_CODE.INTERNAL:
      return 500;
    default:
      return 400;
  }
}

function errorJson(
  c: HonoContext<FilesEnv>,
  code: string,
  message: string,
  status: number,
  fieldErrors?: Record<string, string[] | undefined>,
) {
  return c.json(
    {
      error: {
        businessCode: code,
        message,
        ...(fieldErrors ? { fieldErrors } : {}),
        requestId: requestId(c),
      },
    },
    status as never,
  );
}

/** session cookie → 用户；未登录返回 null */
async function authenticateSession(c: HonoContext<FilesEnv>): Promise<ResolvedSession | null> {
  return resolveSession(db, getCookie(c, SESSION_COOKIE));
}

/** 令牌鉴权：?token= 须与路径 fileVersionId 匹配（一令一文件） */
function authenticateToken(c: HonoContext<FilesEnv>, fileVersionId: string): boolean {
  const token = c.req.query("token");
  if (!token) return false;
  return verifyDownloadToken(token) === fileVersionId;
}

export const filesRoute = new Hono<FilesEnv>();

filesRoute.post("/upload", async (c) => {
  const resolved = await authenticateSession(c);
  if (!resolved) {
    return errorJson(c, ERROR_CODE.AUTH_REQUIRED, "未登录或会话已失效", 401);
  }

  const body = await c.req.parseBody();
  const parsed = uploadInputSchema.safeParse({
    sourceType: body.sourceType,
    sourceId: body.sourceId,
    businessDate: body.businessDate === "" || body.businessDate === undefined ? undefined : body.businessDate,
    idempotencyKey:
      body.idempotencyKey === "" || body.idempotencyKey === undefined ? undefined : body.idempotencyKey,
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.length > 0 ? String(issue.path[0]) : "_";
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return c.json(
      {
        error: {
          businessCode: ERROR_CODE.VALIDATION_FAILED,
          message: "上传参数校验失败",
          fieldErrors,
          requestId: requestId(c),
        },
      },
      400,
    );
  }

  const file = body.file;
  if (!(file instanceof File)) {
    return errorJson(c, ERROR_CODE.VALIDATION_FAILED, "缺少上传文件（字段名 file）", 400);
  }

  const data = new Uint8Array(await file.arrayBuffer());
  try {
    const saved = await db.transaction((tx) =>
      saveUpload(tx, {
        data,
        filename: file.name || "unnamed",
        declaredMime: file.type || null,
        sourceType: parsed.data.sourceType,
        sourceId: parsed.data.sourceId,
        businessDate: parsed.data.businessDate ?? null,
        uploadedBy: resolved.user.id,
        ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        sessionId: resolved.sessionId,
        idempotencyKey: parsed.data.idempotencyKey ?? null,
      }),
    );
    return c.json(saved);
  } catch (error) {
    if (error instanceof BusinessError) {
      return errorJson(c, error.businessCode, error.message, statusOf(error.businessCode), error.fieldErrors);
    }
    throw error;
  }
});

async function sendFile(c: HonoContext<FilesEnv>, disposition: "attachment" | "inline") {
  const fileVersionId = c.req.param("fileVersionId") ?? "";
  if (!z.uuid().safeParse(fileVersionId).success) {
    return errorJson(c, ERROR_CODE.ACCESS_DENIED_OR_GONE, "文件不存在或无权访问", 404);
  }

  const resolved = await authenticateSession(c);
  const viaToken = !resolved && authenticateToken(c, fileVersionId);
  if (!resolved && !viaToken) {
    return errorJson(c, ERROR_CODE.AUTH_REQUIRED, "未登录或会话已失效", 401);
  }

  const version = await findFileVersion(db, fileVersionId);
  if (!version) {
    return errorJson(c, ERROR_CODE.ACCESS_DENIED_OR_GONE, "文件不存在或无权访问", 404);
  }

  // 令牌放行：验签时已确认 fileVersionId 一致；权限按令牌等价于已授权读取
  const actor = resolved?.user ?? null;
  if (actor) {
    const allowed = await canReadFile(db, actor, version.fileObjectId);
    if (!allowed) {
      return errorJson(c, ERROR_CODE.ACCESS_DENIED_OR_GONE, "文件不存在或无权访问", 404);
    }
  }

  const stored = await readVersion(db, fileVersionId);
  if (!stored) {
    return errorJson(c, ERROR_CODE.ACCESS_DENIED_OR_GONE, "文件不存在或无权访问", 404);
  }

  await recordAudit(db, {
    actorId: actor?.id ?? null,
    sessionId: resolved?.sessionId ?? null,
    action: disposition === "inline" ? "file.preview" : "file.download",
    targetType: "file_object",
    targetId: version.fileObjectId,
    result: "success",
    afterJson: { fileVersionId, storageKey: stored.storageKey },
    ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  const filename = stored.storageKey.split("/").pop() ?? "file";
  c.header("Content-Type", stored.mimeType);
  c.header("Content-Length", String(stored.sizeBytes));
  c.header("Content-Disposition", `${disposition}; filename="${filename}"`);
  c.header("Cache-Control", "private, no-store");
  const body = stored.data.buffer.slice(
    stored.data.byteOffset,
    stored.data.byteOffset + stored.data.byteLength,
  ) as ArrayBuffer;
  return c.body(body);
}

filesRoute.get("/:fileVersionId/download", (c) => sendFile(c, "attachment"));
filesRoute.get("/:fileVersionId/preview", (c) => sendFile(c, "inline"));
