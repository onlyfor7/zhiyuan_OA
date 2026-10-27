import { bigint, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { confidentialityLevelEnum } from "./enums";
import { users } from "./org";

/**
 * 逻辑文件（arch/01 §1）。
 * current_version_id 逻辑指向 file_versions.id；两表互引，迁移内不建物理外键，
 * 由应用层维护一致性（迭代 1 文件域落地时可再评估）。
 * source_type/source_id 为来源挂载（arch/04 §2.1；新上传必填，迭代 0 存量行允许为 null）。
 */
export const fileObjects = pgTable(
  "file_objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    currentVersionId: uuid("current_version_id"),
    confidentialityLevel: confidentialityLevelEnum("confidentiality_level").notNull().default("internal"),
    sourceType: text("source_type"),
    sourceId: uuid("source_id"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    index("file_objects_created_by_idx").on(t.createdBy),
    index("file_objects_source_idx").on(t.sourceType, t.sourceId),
  ],
);

/**
 * 物理文件版本（arch/01 §1；sha256 建索引供重复票据/文件检查，arch/01 §6）。
 * idempotency_key 唯一可空（arch/04 §2.1 D2：upload 幂等键，重复同键返回首次结果）。
 */
export const fileVersions = pgTable(
  "file_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fileObjectId: uuid("file_object_id")
      .notNull()
      .references(() => fileObjects.id, { onDelete: "restrict" }),
    versionNo: integer("version_no").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    mimeType: text("mime_type").notNull(),
    sha256: text("sha256").notNull(),
    businessDate: date("business_date"),
    uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "restrict" }),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    idempotencyKey: text("idempotency_key").unique(),
  },
  (t) => [
    uniqueIndex("file_versions_object_version_idx").on(t.fileObjectId, t.versionNo),
    index("file_versions_sha256_idx").on(t.sha256),
  ],
);
