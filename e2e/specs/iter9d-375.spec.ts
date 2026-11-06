import { test, expect } from "@playwright/test";

const B = process.env.LX_BASE ?? "http://localhost:8080";

test.use({ viewport: { width: 375, height: 812 } });

test("375px 抽查：fin 三页零横向溢出（9d-05 回归）", async ({ page }) => {
  await page.goto(`${B}/login`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("name@firm.com").fill("guojingwen@lexflow.demo");
  await page.locator('input[type="password"]').fill("Demo@2026");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 25_000 });
  for (const path of ["/fin/receivables", "/fin/invoices", "/fin/project-costing"]) {
    await page.goto(`${B}${path}`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(600);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${path} 横向溢出`).toBeLessThanOrEqual(1);
  }
});
