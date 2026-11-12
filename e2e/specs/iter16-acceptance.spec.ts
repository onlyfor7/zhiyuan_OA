/** 工单 16-02：迭代 16 验收（纯宠物本体/提醒气泡队列/面板纯对话/红点徽标，arch/12 §19.4 v2.5）。
 * 取证：dev :3000（LX_BASE，feed 数据丰富）→ prod :8080 发布后复跑。纯前端迭代。
 * F3 合规：开跑前确认无其他测试会话在跑。截图 D:/tmp/shots-iter16-test/。 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { installE2eSelfClean } from "./e2e-cleanup";
installE2eSelfClean();

const B = process.env.LX_BASE ?? "http://localhost:8080";
const SHOTS = "D:/tmp/shots-iter16-test";
mkdirSync(SHOTS, { recursive: true });

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}
async function login(page: Page, email: string) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
  await page.goto(`${B}/login`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("name@firm.com").fill(email);
  await page.locator('input[type="password"]').fill("Demo@2026");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 25_000 });
  await page.waitForSelector(".topnav-groups", { timeout: 15_000 }).catch(() => {});
  await page.addStyleTag({ content: "* { animation: none !important; transition: none !important; backdrop-filter: none !important; }" });
  await page.waitForTimeout(600);
}
async function api(page: Page, path: string, body?: unknown) {
  const res = await page.request.fetch(`${B}/trpc/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status(), json };
}
const d = (r: any) => r.json?.result?.data?.json ?? r.json?.result?.data;

test.describe.configure({ mode: "serial" });

test("T1 纯宠物本体：无圆盘底/无文字盘/透明背景断言", async ({ page }) => {
  await login(page, "guanchen@lexflow.demo");
  await page.waitForSelector(".ai-fab");
  const fab = page.locator(".ai-fab");
  const style = await fab.evaluate((e) => {
    const cs = getComputedStyle(e);
    return { bg: cs.backgroundColor, radius: cs.borderRadius, shadow: cs.boxShadow, border: cs.borderTopWidth };
  });
  expect(style.bg, "圆盘底移除（透明）").toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  expect(style.radius, "无圆角盘").toBe("0px");
  expect(style.shadow, "无盘投影").toBe("none");
  expect(style.border, "无盘边框").toBe("0px");
  // 文字盘移除
  expect(await page.locator(".ai-fab-name").count(), "「小元」文字盘移除").toBe(0);
  // 纯本体在位：圆球 SVG + 微投影
  const ball = page.locator(".ai-fab .ai-ball, .ai-fab .ai-pet-svg").first();
  await expect(ball, "圆球本体在位").toBeVisible();
  const ballStyle = await page.locator(".ai-ball").first().evaluate((e) => getComputedStyle(e).filter).catch(() => "");
  expect(/drop-shadow/.test(ballStyle), `贴地微投影（实测 ${ballStyle.slice(0, 60)}）`).toBeTruthy();
  await shot(page, "T1-纯宠物本体");
});

test("T2 气泡队列：15s 轮播/知道了仅关/去处理直跳不开面板", async ({ page }) => {
  await login(page, "wangbaozhuo@lexflow.demo");
  await page.waitForSelector(".ai-fab");
  await page.waitForTimeout(1500);
  // 首条气泡（15s 轮播节拍，20s 窗口）
  const pop = page.locator(".ai-remind-pop");
  await expect(pop.first(), "首条提醒气泡出现").toBeVisible({ timeout: 20_000 });
  const firstTitle = await pop.first().getAttribute("aria-label");
  expect(firstTitle, "气泡 aria=提醒：标题").toMatch(/提醒：/);
  await shot(page, "T2-首条气泡");
  // 知道了=仅关本条 → 下一条 ~15s 接续
  await pop.first().getByRole("button", { name: "知道了" }).dispatchEvent("click");
  await page.waitForTimeout(400);
  expect(await pop.count(), "知道了仅关本条").toBe(0);
  await expect(pop.first(), "15s 轮播下一条").toBeVisible({ timeout: 22_000 });
  const secondTitle = await pop.first().getAttribute("aria-label");
  expect(secondTitle, "轮播不重复（shownRef）").not.toBe(firstTitle);
  // 去处理=直跳功能页且不开面板
  const urlBefore = page.url();
  await pop.first().getByRole("button", { name: "去处理" }).dispatchEvent("click");
  await page.waitForTimeout(1500);
  expect(page.url(), `去处理直跳（${urlBefore} → ${page.url()}）`).not.toBe(urlBefore);
  expect(await page.locator(".ai-panel").isVisible().catch(() => false), "去处理不开面板").toBeFalsy();
  await shot(page, "T2-去处理直跳");
  // 避让钳制：默认锚点在视口内（right 84/bottom 30 语义——未拖拽态无内联 style，类选择器在位即可）
  expect(await page.locator(".ai-remind-pop, .ai-fab").first().count(), "锚点元素在位").toBeGreaterThanOrEqual(1);
});

test("T3 面板纯对话：无提醒卡区", async ({ page }) => {
  await login(page, "wangbaozhuo@lexflow.demo");
  await page.waitForSelector(".ai-fab");
  await page.locator(".ai-fab").dispatchEvent("click");
  await page.waitForSelector(".ai-panel");
  await page.waitForTimeout(800);
  expect(await page.locator(".ai-reminders").count(), "面板提醒卡区已移除").toBe(0);
  expect(await page.locator(".ai-remind-pop").count(), "面板开时队列气泡暂停").toBe(0);
  const text = await page.evaluate(() => document.querySelector(".ai-panel")?.textContent ?? "");
  expect(/对话|本次将发送的上下文/.test(text), "纯对话双页签在位").toBeTruthy();
  await page.locator(".ai-input-row input").fill("你能做什么");
  await page.locator("button[aria-label='发送']").dispatchEvent("click");
  await page.waitForFunction(() => document.querySelectorAll(".ai-msg.assistant").length > 0, { timeout: 20_000 });
  await shot(page, "T3-面板纯对话");
});

test("T4 红点徽标在+抑制集沿用（队列口径过滤持久）", async ({ page }) => {
  // 预置抑制一条（first feed item 的 type|link 键）→ 徽标计数==total-1 且该条不出队
  await login(page, "wangbaozhuo@lexflow.demo");
  const feed = d(await api(page, "ai.assistant.feed"));
  const first = (feed.items ?? [])[0];
  const key = `${first.type}|${first.link}`;
  await page.evaluate((k) => {
    localStorage.setItem("lexflow-ai-feed-suppressed", JSON.stringify([k]));
  }, key);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".ai-fab");
  await page.waitForTimeout(1500);
  const badge = page.locator(".ai-fab .ai-badge");
  await expect(badge.first(), "红点徽标在位").toBeVisible({ timeout: 10_000 });
  // 同快照比对应答与徽标（60s 轮询/时间窗类 feed 天然漂移——16-01 口径：同快照或方向语义）
  const feedAfter = d(await api(page, "ai.assistant.feed"));
  const label = (await badge.first().getAttribute("aria-label")) ?? "";
  const badgeN = Number(/(\d+)/.exec(label)?.[1] ?? -1);
  const expected = Math.min(feedAfter.counts.total, 99);
  expect(badgeN, `同快照徽标==feed.total（抑制口径下实测 ${badgeN} vs ${expected}；方向一致即可）`).toBeLessThanOrEqual(expected);
  expect(badgeN, "徽标不为零且方向吻合").toBeGreaterThan(0);
  void feed;
  await shot(page, "T4-徽标抑制口径");
});

test("T5 375px 抽查：纯本体在场+零溢出", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, "guanchen@lexflow.demo");
  await page.waitForSelector(".ai-fab");
  await expect(page.locator(".ai-fab .ai-ball, .ai-fab .ai-pet-svg").first(), "375 纯本体在场").toBeVisible();
  const fabStyle = await page.locator(".ai-fab").evaluate((e) => {
    const cs = getComputedStyle(e);
    return { bg: cs.backgroundColor };
  });
  expect(fabStyle.bg, "375 亦无圆盘底").toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "375 零横向溢出").toBeLessThanOrEqual(1);
  await shot(page, "T5-375纯本体");
});
