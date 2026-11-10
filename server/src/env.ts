import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { loadEnvFile } from "./db/env";

loadEnvFile();

/**
 * 服务端环境变量全量校验（arch/00 §7；键与 .env.example 对齐）。
 * 进程未注入时由 loadEnvFile 从仓库根 .env 兜底（数据会话实现）。
 */
const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL 不能为空"),
  SESSION_SECRET: z.string().min(16, "SESSION_SECRET 至少 16 字符"),
  STORAGE_DIR: z.string().min(1).default("./server/storage"),
  PORT: z.coerce.number().int().positive().default(3001),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(8),
  /** 单文件上传上限（MB，arch/00 §5 默认 20，可配置） */
  FILE_MAX_MB: z.coerce.number().int().positive().default(20),
  /** AI 提供方三键（arch/12 §17.4；缺省时内置 MockProvider 兜底——dev/test/演示可验收） */
  AI_PROVIDER_URL: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export const env: Env = envSchema.parse(process.env);

/** STORAGE_DIR 一律解析为绝对路径（相对路径以仓库根为基准），杜绝路径穿越歧义 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const storageRoot = resolve(REPO_ROOT, env.STORAGE_DIR);
