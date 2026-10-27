import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@lexflow/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
      "@lexflow/server": fileURLToPath(new URL("../server/src/trpc/routers/index.ts", import.meta.url)),
    },
  },
  test: {
    // 迭代 0 前端用例为纯函数/数据层断言，node 环境即可（jsdom 留给后续组件测试）
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
