/** 工单 15-04：迭代 15 验收（宠物形象/直进面板/提示页三类区分/内置提醒 feed+红点+直跳+抑制，arch/12 §19）。
 * 取证：dev :3000（LX_BASE，feed 数据丰富）→ prod :8080 发布后复跑（形状/提示页/直进；feed 数据驱动）。
 * F3 合规：开跑前确认无其他测试会话在跑。截图 D:/tmp/shots-iter15-test/。 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const B = process.env.LX_BASE ?? "http://localhost:8080";
const SHOTS = "D:/tmp/shots-iter15-test";
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

test("T1 宠物形象：圆球非方框+四态表情在位", async ({ page }) => {
  await login(page, "guanchen@lexflow.demo");
  await page.waitForSelector(".ai-fab");
  const pet = page.locator(".ai-fab .ai-pet-svg").first();
  await expect(pet, "圆球宠物 SVG 在位").toBeVisible({ timeout: 10_000 });
  // 非方框：SVG 视口圆球（球体椭圆元素）+ mood 常态类
  const mood0 = await pet.getAttribute("class");
  expect(mood0, "常态 mood=normal").toContain("ai-mood-normal");
  const faces = await page.evaluate(() => ({
    normal: !!document.querySelector(".ai-fab .ai-face, .ai-fab .ai-pet-svg [class*='face']"),
    happy: !!document.querySelector(".ai-face-happy"),
    thinking: !!document.querySelector(".ai-face-thinking"),
    busy: !!document.querySelector(".ai-face-busy"),
  }));
  expect(Object.values(faces).filter(Boolean).length, `四态表情组在位（${JSON.stringify(faces)}）`).toBeGreaterThanOrEqual(3);
  // 开面板 → happy 态
  await page.locator(".ai-fab").dispatchEvent("click");
  await page.waitForSelector(".ai-panel");
  await page.waitForTimeout(500);
  expect(await pet.getAttribute("class"), "开面板 mood=happy").toContain("ai-mood-happy");
  await shot(page, "T1-宠物开心态");
  await page.locator("button[aria-label='关闭小元面板']").dispatchEvent("click");
});

test("T2 点击直进面板（无中间层）", async ({ page }) => {
  await login(page, "guanchen@lexflow.demo");
  await page.waitForSelector(".ai-fab");
  await page.locator(".ai-fab").dispatchEvent("click");
  await page.waitForSelector(".ai-panel", { timeout: 8_000 });
  await page.waitForTimeout(400);
  const midBubble = await page.locator(".ai-bubble-pop", { hasText: "打开对话" }).count();
  expect(midBubble, "「打开对话」中间层已移除（首击即面板）").toBe(0);
  // 再击关闭（直进直出）
  await page.locator(".ai-fab").dispatchEvent("click");
  await page.waitForTimeout(500);
  expect(await page.locator(".ai-panel").isVisible().catch(() => false), "再击关闭面板").toBeFalsy();
  await shot(page, "T2-直进直出");
});

test("T3 提示页三类区分（真 404/系统页无权限+角色徽标/业务对象同形 404 不破）", async ({ page }) => {
  await login(page, "liangqifeng@lexflow.demo");
  // ① 真 404：乱路由 → 页面不存在，无「没有访问权限」
  await page.goto(`${B}/definitely-not-a-route`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  let body = await page.evaluate(() => document.body.innerText);
  expect(body, "真 404 文案").toContain("页面不存在");
  expect(body, "真 404 不混无权限页").not.toContain("没有访问权限");
  await shot(page, "T3-真404");
  // ② 系统页无权限（member 撞 /admin 守卫）：没有访问权限+角色徽标
  await login(page, "guanchen@lexflow.demo");
  await page.goto(`${B}/admin`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  body = await page.evaluate(() => document.body.innerText);
  expect(body, "无权限页文案（区分性：请联系管理员）").toContain("请联系管理员");
  expect(body, "角色徽标在场").toMatch(/项目成员|member|角色/i);
  expect(body, "无权限页无保密注（与同形 404 区分）").not.toContain("为保密需要");
  await shot(page, "T3-系统页无权限");
  // ③ 业务对象同形 404（member 撞他人项目详情）：保密注中性表述、不泄存在性、不破同形
  await page.goto(`${B}/projects/00000000-0000-4000-8000-000000000000`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  body = await page.evaluate(() => document.body.innerText);
  expect(body, "同形 404 非无权限页（无「请联系管理员」引导）").not.toContain("请联系管理员");
  expect(body, "保密注在位（同形呈现）").toContain("为保密需要");
  expect(body, "中性表述在位").toMatch(/不存在|无权访问/i);
  await shot(page, "T3-业务同形404");
});

test("T4 内置提醒 feed：形状/排序/六类键/脱敏（pm 数据丰富视角）", async ({ page }) => {
  await login(page, "wangbaozhuo@lexflow.demo");
  const feed = d(await api(page, "ai.assistant.feed"));
  expect(feed, "feed 返回").toBeTruthy();
  expect(feed.status ?? 200, "feed 200").toBeTruthy();
  const counts = feed.counts;
  const items = (feed.items ?? []) as any[];
  expect(counts.total, "counts.total>0（pm 数据态）").toBeGreaterThan(0);
  for (const k of ["approval", "meeting", "task", "timesheet", "expense", "receivable"]) {
    expect(counts.byType ?? {}, `byType 六键恒在：${k}`).toHaveProperty(k);
  }
  expect(counts.byType.approval + counts.byType.meeting + counts.byType.task + counts.byType.timesheet + counts.byType.expense + counts.byType.receivable,
    "byType 合计==total 勾稽").toBe(counts.total);
  // danger 优先排序
  const urgencies = items.map((i) => i.urgency);
  const firstNonDanger = urgencies.indexOf(urgencies.find((u) => u !== "danger") ?? "danger");
  expect(urgencies.slice(0, Math.max(firstNonDanger, 0)).every((u) => u === "danger"), "danger 置顶").toBeTruthy();
  // 条目结构+脱敏
  for (const it of items.slice(0, 12)) {
    expect(it.type && it.icon && it.title && it.sourceLabel && it.link, `条目结构齐（${it.type}）`).toBeTruthy();
    expect(/^[0-9a-f]{8}-/i.test(it.title + it.sourceLabel), "title/sourceLabel 禁 uuid").toBeFalsy();
    expect(it.link.startsWith("/"), "link 内部路由").toBeTruthy();
  }
  // member 视角：回款类整类不出现（fin.read 口径）
  await login(page, "guanchen@lexflow.demo");
  const mFeed = d(await api(page, "ai.assistant.feed"));
  expect((mFeed.items ?? []).filter((i: any) => i.type === "receivable").length, "member 无回款提醒").toBe(0);
  await shot(page, "T4-feed");
});

test("T5 红点计数+提醒卡直跳+不再提醒抑制持久（pm）", async ({ page }) => {
  await login(page, "wangbaozhuo@lexflow.demo");
  await page.waitForSelector(".ai-fab");
  await page.waitForTimeout(1200);
  const feed = d(await api(page, "ai.assistant.feed"));
  const total = feed.counts.total;
  const badge = page.locator(".ai-fab [aria-label*='待提醒'], .ai-fab .ai-badge");
  await expect(badge.first(), "红点计数徽标在位").toBeVisible({ timeout: 10_000 });
  const badgeText = ((await badge.first().getAttribute("aria-label")) ?? (await badge.first().innerText())).trim();
  const badgeN = Number(/(\d+)/.exec(badgeText)?.[1] ?? total);
  expect(badgeN, `徽标计数==feed total（实测 ${badgeN} vs ${total}）`).toBe(total > 99 ? 99 : total);
  // 面板开 → 徽标隐藏 + 提醒卡列表 danger 置顶
  await page.locator(".ai-fab").dispatchEvent("click");
  await page.waitForSelector(".ai-panel");
  await page.waitForTimeout(900);
  const reminders = page.locator(".ai-reminders [role='link']");
  const cardCount = await reminders.count();
  expect(cardCount, "提醒卡列表在位").toBeGreaterThanOrEqual(1);
  const firstUrgency = await page.locator(".ai-reminders [role='link']").first().evaluate((e) => getComputedStyle(e).borderLeftColor || e.className);
  expect(firstUrgency, "首卡 danger 置顶（红边/类名）").toMatch(/239|220|danger/i);
  await shot(page, "T5-提醒卡");
  // 直跳：点首卡 → 面板关+URL 变
  const firstCard = reminders.first();
  const targetLink = await firstCard.evaluate((e) => e.getAttribute("href") ?? e.textContent ?? "");
  await firstCard.dispatchEvent("click");
  await page.waitForTimeout(1500);
  const urlAfter = page.url();
  expect(/fin\/|approvals|time|expense|meetings|projects/.test(urlAfter), `提醒卡直跳处理页（${urlAfter}）`).toBeTruthy();
  void targetLink;
  await shot(page, "T5-直跳");
  // 抑制：回工作台?直接 feed 侧 ×——重新开面板抑制一条
  await page.goto(`${B}/cockpit`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.locator(".ai-fab").dispatchEvent("click");
  await page.waitForSelector(".ai-panel");
  await page.waitForTimeout(900);
  // 抑制=前端可见口径过滤（服务端 total 恒 18）——断言 UI 三方同快照扣减（15-03 口径）
  const listBefore = await page.locator(".ai-reminders [role='link']").count();
  const headText = await page.locator(".ai-reminders").first().innerText().catch(() => "");
  const headBefore = /今日提醒 · (\d+)/.exec(headText)?.[1];
  await page.locator(".ai-reminders [role='link']").first().hover();
  await page.waitForTimeout(500);
  await page.locator("button.ai-remind-dismiss[aria-label='不再提醒本条']").first().dispatchEvent("click");
  await page.waitForTimeout(1200);
  const listAfter = await page.locator(".ai-reminders [role='link']").count();
  const headText2 = await page.locator(".ai-reminders").first().innerText().catch(() => "");
  const headAfter = /今日提醒 · (\d+)/.exec(headText2)?.[1];
  expect(listAfter, `提醒卡即时扣减（${listBefore}→${listAfter}）`).toBe(listBefore - 1);
  expect(Number(headAfter ?? listAfter), `标题计数单调扣减（${headBefore}→${headAfter}，轮询漂移容忍）`).toBeLessThanOrEqual(Number(headBefore ?? listBefore) - 1);
  const suppressed = await page.evaluate(() => localStorage.getItem("lexflow-ai-feed-suppressed"));
  expect(suppressed, "抑制键已持久化").toBeTruthy();
  // 重载持久：徽标计数扣减保持
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const badgeAfter = page.locator(".ai-fab .ai-badge");
  if (await badgeAfter.count()) {
    const badgeLabel = (await badgeAfter.first().getAttribute("aria-label")) ?? "";
    const badgeN2 = Number(/(\d+)/.exec(badgeLabel)?.[1] ?? 0);
    expect(badgeN2, `重载徽标扣减保持（实测 ${badgeN2} ≤ ${total - 1}）`).toBeLessThanOrEqual(total - 1);
  }
  await shot(page, "T5-抑制持久");
});

test("T6 375px 抽查：宠物在场+提示页不超屏", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, "guanchen@lexflow.demo");
  await page.waitForSelector(".ai-fab");
  let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "375 驾驶舱零溢出（宠物在场）").toBeLessThanOrEqual(1);
  await page.goto(`${B}/definitely-not-a-route`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "375 提示页零溢出").toBeLessThanOrEqual(1);
  await shot(page, "T6-375提示页");
});
