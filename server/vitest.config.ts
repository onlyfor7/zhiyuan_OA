import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@lexflow/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120000,
    hookTimeout: 120000,
    // 06b 修稳：Windows 下 forks（子进程）池偶发 0xC0000409 崩溃（fork 启动即退出，整个 run 判红——
    // 取证见 /tmp/06b-verify-fail-round-6.log）。依赖零原生模块（pg 纯 JS、口令散列为 node:crypto），
    // 改线程池规避子进程崩溃路径；fileParallelism 仍 false，执行语义不变。
    pool: "threads",
  },
});
