import * as esbuild from "esbuild";

/**
 * server 生产构建（arch/08 §5 裁定）：esbuild 打包为 dist/ 单文件产物。
 * - @lexflow/shared 与全部 TS 源码打入产物；pg 等原生/运行时依赖保持 external。
 * - 三个平铺入口：dist/index.js（服务本体，npm start）、dist/migrate.js（容器启动迁移）、
 *   dist/seed.js（演示数据，可选执行）。
 */
const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  minify: false,
  external: ["pg", "pg-native"],
  logLevel: "info",
};

await Promise.all([
  esbuild.build({ ...shared, entryPoints: ["src/index.ts"], outfile: "dist/index.js" }),
  esbuild.build({ ...shared, entryPoints: ["src/db/migrate.ts"], outfile: "dist/migrate.js" }),
  esbuild.build({ ...shared, entryPoints: ["src/db/seed/index.ts"], outfile: "dist/seed.js" }),
]);
