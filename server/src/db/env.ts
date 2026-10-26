import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * 进程未注入 DATABASE_URL 时，从仓库根 .env（或 server/.env）读取补齐。
 * 数据会话范围内的最小实现；服务端全量 env 校验属工单 03（server/src/env.ts）。
 */
export function loadEnvFile(): void {
  if (process.env.DATABASE_URL) return;
  const candidates = [resolve(HERE, "../../.env"), resolve(HERE, "../../../.env")];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

export function requireDatabaseUrl(): string {
  loadEnvFile();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL 未设置（进程环境或 .env）");
  return url;
}
