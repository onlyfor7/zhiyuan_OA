import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { ERROR_CODE, type SourceType } from "@lexflow/shared";

import { env, storageRoot } from "../../env";
import { fileObjects, fileVersions } from "../../db/schema";
import type { DbOrTx } from "../../trpc/context";
import { BusinessError } from "../../lib/errors";
import { recordAudit } from "../audit";

/**
 * 文件存储服务（arch/00 §5、arch/01 §1 file_objects/file_versions）。
 * 物理内容写 STORAGE_DIR（storage_key 自带扩展名、服务端生成，天然防穿越）；
 * DB 只存元数据 + sha256。web 层（routes/files.ts）只做解析与响应。
 */

/** 扩展名白名单（arch/00 §5） */
export const ALLOWED_EXTENSIONS = ["pdf", "png", "jpg", "jpeg", "docx", "xlsx", "zip", "csv"] as const;

/** 扩展名 → 允许的 MIME（声明 MIME 缺失或不符时以扩展名为准纠正） */
const MIME_BY_EXTENSION: Record<string, string> = {
  csv: "text/csv",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

export const MAX_FILE_BYTES = () => env.FILE_MAX_MB * 1024 * 1024;

export interface SaveUploadInput {
  data: Uint8Array;
  filename: string;
  declaredMime: string | null;
  sourceType: SourceType;
  /** uuid 列可空：业务键（如报表 key）非 uuid 时传 null，溯源走审计行 */
  sourceId: string | null;
  businessDate: string | null;
  uploadedBy: string;
  ip: string | null;
  sessionId: string | null;
  /** D2（arch/04 §7）：可选幂等键；命中唯一约束返回首次结果 */
  idempotencyKey?: string | null;
}

export interface SavedFile {
  fileObjectId: string;
  fileVersionId: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * 保存上传：白名单 + 20MB 校验 → 落盘 → 建行（file_objects v1 + file_versions）。
 * D2 幂等（arch/04 §7）：带 idempotencyKey 时先查后插，命中唯一约束（并发兜底）返回首次结果。
 * 在事务中调用（业务建行 + 审计同事务，arch/02 §7）。
 */
export async function saveUpload(db: DbOrTx, input: SaveUploadInput): Promise<SavedFile> {
  const ext = extname(input.filename).slice(1).toLowerCase();
  if (!ext || !(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "不支持的文件类型", {
      file: [`仅允许：${ALLOWED_EXTENSIONS.join(" / ")}`],
    });
  }
  if (input.data.byteLength === 0) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "文件内容为空", { file: ["文件内容为空"] });
  }
  if (input.data.byteLength > MAX_FILE_BYTES()) {
    throw new BusinessError(
      ERROR_CODE.VALIDATION_FAILED,
      `文件超过 ${env.FILE_MAX_MB}MB 上限`,
      { file: [`单文件不超过 ${env.FILE_MAX_MB}MB`] },
    );
  }

  // D2 幂等：命中即返回首次结果（不重写盘、不重复建行）
  if (input.idempotencyKey) {
    const dup = await db
      .select({
        id: fileVersions.id,
        fileObjectId: fileVersions.fileObjectId,
        sha256: fileVersions.sha256,
        sizeBytes: fileVersions.sizeBytes,
      })
      .from(fileVersions)
      .where(eq(fileVersions.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (dup[0]) {
      return {
        fileVersionId: dup[0].id,
        fileObjectId: dup[0].fileObjectId,
        sha256: dup[0].sha256,
        sizeBytes: dup[0].sizeBytes,
      };
    }
  }

  // 存储键 = uuid + 白名单扩展名（服务端生成，禁止路径穿越；arch/00 §5）
  const storageKey = `${randomUUID()}.${ext === "jpeg" ? "jpg" : ext}`;
  const absolutePath = join(storageRoot, storageKey);
  if (!absolutePath.startsWith(storageRoot)) {
    throw new BusinessError(ERROR_CODE.VALIDATION_FAILED, "非法存储路径", { file: ["非法存储路径"] });
  }

  const sha256 = createHash("sha256").update(input.data).digest("hex");
  await mkdir(dirname(absolutePath), { recursive: true });
  const tmpPath = `${absolutePath}.tmp-${process.pid}`;
  await writeFile(tmpPath, input.data);
  await rename(tmpPath, absolutePath);

  const mimeType = MIME_BY_EXTENSION[ext];
  const [object] = await db
    .insert(fileObjects)
    .values({
      confidentialityLevel: "internal",
      createdBy: input.uploadedBy,
      // 新上传必填来源（arch/04 §2.1），老行允许为 null 由种子回填
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    })
    .returning({ id: fileObjects.id });

  let version: { id: string } | undefined;
  try {
    [version] = await db
      .insert(fileVersions)
      .values({
        fileObjectId: object.id,
        versionNo: 1,
        storageKey,
        sizeBytes: input.data.byteLength,
        mimeType: input.declaredMime && input.declaredMime === mimeType ? input.declaredMime : mimeType,
        sha256,
        businessDate: input.businessDate,
        uploadedBy: input.uploadedBy,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning({ id: fileVersions.id });
  } catch (error) {
    // 并发同键兜底：唯一约束命中 → 返回首次结果（本方落盘文件成孤儿，已知留坑迭代清理）
    if (input.idempotencyKey && (error as { code?: string }).code === "23505") {
      const dup = await db
        .select({
          id: fileVersions.id,
          fileObjectId: fileVersions.fileObjectId,
          sha256: fileVersions.sha256,
          sizeBytes: fileVersions.sizeBytes,
        })
        .from(fileVersions)
        .where(eq(fileVersions.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (dup[0]) {
        return {
          fileVersionId: dup[0].id,
          fileObjectId: dup[0].fileObjectId,
          sha256: dup[0].sha256,
          sizeBytes: dup[0].sizeBytes,
        };
      }
    }
    throw error;
  }

  await db
    .update(fileObjects)
    .set({ currentVersionId: version.id })
    .where(eq(fileObjects.id, object.id));

  await recordAudit(db, {
    actorId: input.uploadedBy,
    sessionId: input.sessionId,
    action: "file.upload",
    targetType: "file_object",
    targetId: object.id,
    result: "success",
    afterJson: {
      fileVersionId: version.id,
      storageKey,
      sizeBytes: input.data.byteLength,
      sha256,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    },
    ip: input.ip,
  });

  return {
    fileObjectId: object.id,
    fileVersionId: version.id,
    sha256,
    sizeBytes: input.data.byteLength,
  };
}

export interface StoredFile {
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  data: Uint8Array;
}

/** 按版本读取物理内容（调用方已完成鉴权） */
export async function readVersion(
  db: DbOrTx,
  fileVersionId: string,
): Promise<StoredFile | null> {
  const rows = await db
    .select({
      storageKey: fileVersions.storageKey,
      mimeType: fileVersions.mimeType,
      sizeBytes: fileVersions.sizeBytes,
      sha256: fileVersions.sha256,
    })
    .from(fileVersions)
    .where(eq(fileVersions.id, fileVersionId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const absolutePath = join(storageRoot, row.storageKey);
  if (!absolutePath.startsWith(storageRoot)) return null;
  const data = await readFile(absolutePath);
  return { ...row, data };
}
