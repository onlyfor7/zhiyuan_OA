/**
 * 工单 05b：生产栈（:8080）深链复测。P0 修复（vite base '/'）后验证：
 * 多级路径直开渲染/资产 content-type/刷新恢复/浏览器返回/375px 移动深链/核心链冒烟。
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { installE2eSelfClean } from "./e2e-cleanup";
installE2eSelfClean();

const SHOTS = "D:/tmp/shots-iter5-deeplink";
mkdirSync(SHOTS, { recursive: true });

const B = "http://localhost:8080";

async function login(page: Page, email: string): Promise<void> {
  await page.goto(`${B}/login`);
  await page.getByPlaceholder("name@firm.com").fill(email);
  await page.locator('input[type="password"]').fill("Demo@2026");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15_000 });
}

async function api(page: Page, path: string, method = "GET") {
  const res = await page.request.fetch(`${B}/trpc/${path}`, { method });
  return { status: res.status(), json: await res.json().catch(() => ({})) };
}

test.describe.configure({ mode: "serial" });

let projectAId = "";
let meetingId = "";
let travelId = "";

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, "pm@lexflow.demo");
  const projects = await api(page, "project.list");
  projectAId = (projects.json as any).result.data.items.find((p: any) => p.code.endsWith("-00001")).id;
  const meetings = await api(page, `meeting.list?input=${encodeURIComponent(JSON.stringify({ projectId: projectAId }))}`);
  meetingId = (meetings.json as any).result.data.items[0].id;
  const travels = await api(page, `travel.list?input=${encodeURIComponent(JSON.stringify({ projectId: projectAId }))}`);
  travelId = (travels.json as any).result.data.items[0].id;
  await ctx.close();
});

const DEEP_LINKS: { name: string; path: () => string; expectText: string }[] = [
  { name: "projects-overview", path: () => `/projects/${projectAId}/overview`, expectText: "治理要点" },
  { name: "projects-plan", path: () => `/projects/${projectAId}/plan`, expectText: "基线（V1 幽灵轨）" },
  { name: "projects-quality", path: () => `/projects/${projectAId}/quality`, expectText: "质量检查清单" },
  { name: "projects-timesheet", path: () => `/projects/${projectAId}/timesheet`, expectText: "工时" },
  { name: "meetings-detail", path: () => `/meetings/${meetingId}`, expectText: "LEXFLOW" },
  { name: "travel-detail", path: () => `/travel/${travelId}`, expectText: "LEXFLOW" },
  { name: "operations-expenses", path: () => "/operations/expenses", expectText: "费用中心" },
  { name: "operations-time", path: () => "/operations/time", expectText: "本周" },
  { name: "operations-budget", path: () => "/operations/budget", expectText: "预算管理" },
  { name: "funding-detail", path: () => `/operations/funding/${"PLACEHOLDER"}`, expectText: "已获批" },
];

test("P0 复测：多级深链直开全部真实渲染（非白屏）+ 资产 content-type", async ({ page }) => {
  await login(page, "pm@lexflow.demo");
  // funding id 动态取
  const fundings = await api(page, "funding.list?input=%7B%7D");
  const fundingId = (fundings.json as any).result?.data?.items?.[0]?.id ?? projectAId;
  const links = DEEP_LINKS.map((l) => (l.name === "funding-detail" ? { ...l, path: () => `/operations/funding/${fundingId}` } : l));
  const badAssets: string[] = [];
  for (const link of links) {
    const resp = await page.goto(`${B}${link.path()}`);
    expect(resp?.status(), `${link.name} HTTP`).toBe(200);
    // 资产 content-type 核验（index.html 引用的 /assets/* 应为 javascript/css）
    const assetUrls = await page.evaluate(() =>
      [...document.querySelectorAll("script[src],link[rel=stylesheet]")].map((e) => (e as HTMLScriptElement).src || (e as HTMLLinkElement).href).filter((u) => u.includes("/assets/")),
    );
    for (const url of assetUrls.slice(0, 4)) {
      const r = await page.request.get(url);
      const ct = r.headers()["content-type"] ?? "";
      if (url.endsWith(".js") && !ct.includes("javascript")) badAssets.push(`${url} → ${ct}`);
      if (url.endsWith(".css") && !ct.includes("css")) badAssets.push(`${url} → ${ct}`);
    }
    await page.waitForSelector("text=LEXFLOW", { timeout: 15_000 });
    await expect(page.getByText(link.expectText).first()).toBeVisible({ timeout: 10_000 });
    const bodyLen = await page.evaluate(() => document.body.innerText.length);
    expect(bodyLen, `${link.name} 白屏检测`).toBeGreaterThan(50);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/deeplink-${link.name}.png` });
  }
  expect(badAssets, "资产 content-type").toEqual([]);
});

test("P0 复测：刷新恢复 + 浏览器返回", async ({ page }) => {
  await login(page, "pm@lexflow.demo");
  await page.goto(`${B}/projects/${projectAId}/plan`);
  await expect(page.getByText("基线（V1 幽灵轨）")).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByText("基线（V1 幽灵轨）")).toBeVisible({ timeout: 15_000 }); // 刷新恢复
  await page.goto(`${B}/projects/${projectAId}/overview`);
  await expect(page.getByRole("heading", { name: "治理要点" })).toBeVisible({ timeout: 15_000 });
  await page.goBack();
  await expect(page.getByText("基线（V1 幽灵轨）")).toBeVisible({ timeout: 15_000 }); // 浏览器返回
  await page.screenshot({ path: `${SHOTS}/deeplink-back-navigation.png` });
});

test("E2E-16 顺带：375px 移动深链直开", async ({ page, browser }) => {
  await login(page, "pm@lexflow.demo");
  const mob = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const mp = await mob.newPage();
  await mob.addCookies((await page.context().cookies()).map((c) => ({ ...c, sameSite: (c.sameSite ?? "Lax") as "Lax" })));
  for (const [name, path, text] of [
    ["mobile-plan", `/projects/${projectAId}/plan`, "基线（V1 幽灵轨）"],
    ["mobile-meeting", `/meetings/${meetingId}`, "LEXFLOW"],
    ["mobile-expenses", "/operations/expenses", "费用中心"],
  ] as const) {
    await mp.goto(`${B}${path}`);
    await mp.waitForSelector("text=LEXFLOW", { timeout: 15_000 });
    await expect(mp.getByText(text).first()).toBeVisible({ timeout: 10_000 });
    await mp.screenshot({ path: `${SHOTS}/deeplink-${name}.png` });
  }
  await mob.close();
});

test("prod 核心链冒烟：登录 / 项目列表 / 审批中心", async ({ page }) => {
  await page.goto(`${B}/login`);
  await page.getByPlaceholder("name@firm.com").fill("pm@lexflow.demo");
  await page.locator('input[type="password"]').fill("Demo@2026");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 15_000 });
  await page.goto(`${B}/projects`);
  await expect(page.getByText("你权限范围内的全部项目").first()).toBeVisible({ timeout: 15_000 });
  await page.goto(`${B}/approvals`);
  await expect(page.getByRole("heading", { name: "审批中心" })).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${SHOTS}/smoke-prod-core.png` });
});
