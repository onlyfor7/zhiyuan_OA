import { defineConfig } from "@playwright/test";

/**
 * 迭代 5 系统验收 E2E（arch/08 §2）：E2E-01~16 逐条，Playwright + 系统 Chrome。
 * 默认对生产栈（http://localhost:8080，nginx 同源）；dev 栈用 BASE_URL=http://localhost:3000。
 * 截图输出 D:/tmp/shots-iter5-e2e（不入库）。
 */
export default defineConfig({
  testDir: "./specs",
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:8080",
    channel: "chrome",
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "off",
  },
});
