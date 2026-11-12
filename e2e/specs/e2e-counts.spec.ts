/** 迭代 17-01 验收辅助：打印未结业务计数（两轮零增长验收度量）。用法：npx playwright test e2e-counts.spec.ts --reporter=line */
import { test } from "@playwright/test";
import { collectOpenCounts } from "./e2e-cleanup";

test("counts", async () => {
  const counts = await collectOpenCounts();
  console.log("OPEN-COUNTS " + JSON.stringify(counts));
});
