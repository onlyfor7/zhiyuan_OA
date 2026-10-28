import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { closeDb, db } from "./client";

/**
 * 生产迁移执行器（工单 04）：随 esbuild 产物 dist/migrate.js 使用，
 * 由 drizzle-orm 自带 migrator 重放 server/drizzle 下的迁移文件，
 * 不依赖 drizzle-kit（生产镜像不含 devDependencies）。
 *
 * 路径约定：本文件打包后位于 <server>/dist/migrate.js，迁移目录为同级 ../drizzle；
 * 容器内为 /app/dist/migrate.js 与 /app/drizzle，两者同构。
 * 开发期迁移仍走 drizzle-kit（npm run db:migrate），本脚本仅供产物使用。
 */
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");

console.log(`[lexflow] migrate: ${migrationsFolder}`);
await migrate(db, { migrationsFolder });
console.log("[lexflow] migrate: done");
await closeDb();
