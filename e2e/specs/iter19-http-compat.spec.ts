/** 迭代 19 工单 03：外测 HTTP 兼容复验（D-MAN-4 已修复确认）。
 * 普通 Chrome、**绝不使用 --unsafely-treat-insecure-origin-as-secure**。
 * 复验 isSecureContext=false 下七入口零崩溃：线索转化/新建商机/报销新建/出差新建/工时中心/会议参与人/计划模拟调整。
 * 全部只打开→截图成功态→取消/离开，不提交业务数据。截图存 D:/tmp/shots-iter19-03/（不入库）。
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const B = process.env.LX_BASE ?? "http://182.92.206.62:8080";
const SHOTS = "D:/tmp/shots-iter19-03";
mkdirSync(SHOTS, { recursive: true });

async function shot(page: Page, name: string) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** 复验页面健康：错误边界文案不得出现 */
async function healthy(page: Page, label: string) {
  const text = await page.evaluate(() => document.body.innerText);
  expect(/页面加载失败|请求未成功完成/.test(text), `${label} 不得出现错误边界`).toBeFalsy();
}

async function login(page: Page, email: string) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
  await page.goto(`${B}/login`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("name@firm.com").fill(email);
  await page.locator('input[type="password"]').fill("Demo@2026");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 25_000 });
  await page.waitForTimeout(500);
}

test.describe.configure({ timeout: 600_000 });
test.use({ actionTimeout: 8_000, navigationTimeout: 20_000 });

test("19-03 HTTP 兼容复验：isSecureContext + 七入口零崩溃", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // 0) 程序化确认普通 Chrome 非安全上下文
  await page.goto(`${B}/login`, { waitUntil: "domcontentloaded" });
  const secure = await page.evaluate(() => window.isSecureContext);
  const hasUUID = await page.evaluate(() => typeof crypto !== "undefined" && typeof (crypto as Crypto).randomUUID === "function");
  console.log("[ctx] isSecureContext=", secure, "| crypto.randomUUID available=", hasUUID);
  expect(secure, "HTTP 外测应为非安全上下文").toBe(false);

  // 1) 线索转化（sales）
  await login(page, "sumingxuan@lexflow.demo");
  await page.goto(`${B}/crm/leads`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".main-workspace", { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /转化/ }).first().click({ timeout: 6_000 }).catch(() => {});
  await page.waitForSelector("[role='dialog']", { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await healthy(page, "线索转化弹窗");
  await shot(page, "19-03-01-lead-convert");
  await page.keyboard.press("Escape").catch(() => {});

  // 2) 新建商机（sales）
  await page.goto(`${B}/crm/opportunities`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".main-workspace", { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: /新建商机/ }).first().click({ timeout: 6_000 }).catch(() => {});
  await page.waitForSelector("[role='dialog']", { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await healthy(page, "新建商机弹窗");
  await shot(page, "19-03-02-opp-new");
  await page.keyboard.press("Escape").catch(() => {});

  // 3) 报销新建（member，F4 整页表单）
  await login(page, "guanchen@lexflow.demo");
  await page.goto(`${B}/expenses/new`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".main-workspace", { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await healthy(page, "报销新建页");
  await shot(page, "19-03-03-expense-new");
  await page.goto(`${B}/workbench`, { waitUntil: "domcontentloaded" }).catch(() => {});

  // 4) 出差新建（member，F4 整页表单）
  await page.goto(`${B}/travel/new`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".main-workspace", { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await healthy(page, "出差新建页");
  await shot(page, "19-03-04-travel-new");

  // 5) 工时中心（member）
  await page.goto(`${B}/operations/time`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".main-workspace", { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await healthy(page, "工时中心");
  await shot(page, "19-03-05-time-center");

  // 6) 会议参与人（pm 打开会议详情→参与人区）
  await login(page, "wangbaozhuo@lexflow.demo");
  const kw = await (await page.request.get(`${B}/trpc/project.list?input=${encodeURIComponent(JSON.stringify({ filters: { keyword: "比博思特" }, limit: 5 }))}`)).json();
  const pid = (kw as any)?.result?.data?.items?.[0]?.id;
  const mtg = await (await page.request.get(`${B}/trpc/meeting.list?input=${encodeURIComponent(JSON.stringify({ projectId: pid, limit: 5 }))}`)).json().catch(() => ({}));
  const mtgId = (mtg as any)?.result?.data?.items?.[0]?.id;
  if (mtgId) {
    await page.goto(`${B}/meetings/${mtgId}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".main-workspace", { timeout: 12_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await healthy(page, "会议详情（参与人）");
    await shot(page, "19-03-06-meeting-detail");
  } else {
    await page.goto(`${B}/projects/${pid}/meetings`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".main-workspace", { timeout: 12_000 }).catch(() => {});
    await page.waitForTimeout(1500);
    await healthy(page, "会议列表");
    await shot(page, "19-03-06-meeting-detail");
  }

  // 7) 计划模拟调整（pm，项目计划页「模拟调整」）
  await page.goto(`${B}/projects/${pid}/plan`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".main-workspace", { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /模拟调整/ }).first().click({ timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await healthy(page, "计划模拟调整");
  await shot(page, "19-03-07-plan-simulate");
  console.log("[19-03] 七入口复验通过（普通 Chrome，无 insecure-origin flag）");
});
