/** 工单 13-03：迭代 13 验收（AI 配置 sysadmin 统筹+用量记账+头像菜单退出入口，arch/12 §17.6）。
 * 取证：dev :3000（LX_BASE）。发布后 prod 复跑同脚本切 :8080。
 * F3 合规：开跑前确认无其他测试会话在跑。截图 D:/tmp/shots-iter13-test/。 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const B = process.env.LX_BASE ?? "http://localhost:8080";
const SHOTS = "D:/tmp/shots-iter13-test";
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
const shared: { usageBefore?: number; chatResp?: any } = {};

test("T1 AI 配置：sysadmin 设置+测试联通+member 404+key 脱敏+enabled=false 拦截不计量", async ({ page }) => {
  await login(page, "zhaokai@lexflow.demo");
  // ① 读配置（空配=mock 态+脱敏位）
  const cfg0 = d(await api(page, "ai.config.get"));
  expect(cfg0, "config.get 返回").toBeTruthy();
  expect(["system_config", "env", "default"]).toContain(cfg0.source);
  // ② member 三探针同形 404
  await login(page, "guanchen@lexflow.demo");
  const mGet = await api(page, "ai.config.get");
  const mSet = await api(page, "ai.config.set", { model: "x" });
  const mTest = await api(page, "ai.config.testConnection", {});
  for (const [tag, r] of [["get", mGet], ["set", mSet], ["testConnection", mTest]] as const) {
    const gone = r.status === 404 || JSON.stringify(r.json).includes("ACCESS_DENIED_OR_GONE");
    expect(gone, `member ai.config.${tag} 同形 404（实测 ${r.status}）`).toBeTruthy();
  }
  await login(page, "zhaokai@lexflow.demo");
  // ③ UI：AI 配置页签三态（空配提示→保存脱敏→清除还原）
  await page.goto(`${B}/admin`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await page.getByRole("tab", { name: "AI 配置" }).or(page.locator("button", { hasText: "AI 配置" })).first().dispatchEvent("click");
  await page.waitForTimeout(800);
  const tabText = await page.evaluate(() => document.body.innerText);
  expect(tabText, "空配 Mock 提示").toMatch(/MockProvider|未配置/);
  await page.locator("input[type=password]").first().fill("sk-iter13-9f8e7d6c");
  const modelInput = page.locator(".form-field", { hasText: "模型" }).locator("input:visible").first();
  if (await modelInput.count()) await modelInput.fill("iter13-test-model");
  await page.getByRole("button", { name: /保\s*存/ }).first().dispatchEvent("click");
  await page.waitForTimeout(1500);
  const cfg1 = d(await api(page, "ai.config.get"));
  expect(cfg1.apiKeyMasked, "脱敏仅后 4 位").toBe("****7d6c");
  expect(cfg1.model, "model 已保存").toBe("iter13-test-model");
  await shot(page, "T1-配置保存脱敏");
  // ④ 审计零明文
  const audits = d(await api(page, `audit.list?input=${encodeURIComponent(JSON.stringify({ limit: 20, action: "ai.config.set" }))}`));
  const auditText = JSON.stringify(audits.items ?? []);
  expect(auditText.includes("sk-iter13-9f8e7d6c"), "审计零明文 key").toBeFalsy();
  expect(/7d6c|\*{4}/.test(auditText), "审计仅脱敏形态").toBeTruthy();
  // ⑤ 测试联通（mock 态 ok）
  const conn = d(await api(page, "ai.config.testConnection", {}));
  expect(conn.ok, "testConnection ok（mock 内置可用）").toBeTruthy();
  // ⑥ enabled=false 拦截 403 不计量
  await api(page, "ai.config.set", { enabled: false });
  const before = d(await api(page, "ai.myUsage"));
  const blocked = await api(page, "ai.chat", { messages: [{ role: "user", content: "拦截探针" }] });
  expect(blocked.status, "enabled=false → 403").toBe(403);
  expect(JSON.stringify(blocked.json), "AI_DISABLED 业务码").toContain("AI_DISABLED");
  const after = d(await api(page, "ai.myUsage"));
  const sum = (u: any) => (u?.days ?? u?.items ?? []).reduce((s: number, x: any) => s + (x.calls ?? x.count ?? 0), 0);
  expect(sum(after), "拦截不计量（行数不变）").toBe(sum(before));
  // ⑦ 恢复 enabled=true 即通 + 清理 key/model 还原空配
  await api(page, "ai.config.set", { enabled: true });
  const okChat = await api(page, "ai.chat", { messages: [{ role: "user", content: "恢复探针" }] });
  expect(okChat.status, "恢复即通 200").toBe(200);
  await api(page, "ai.config.set", { apiKey: null, model: null });
  const cfg2 = d(await api(page, "ai.config.get"));
  expect(cfg2.apiKeyMasked ?? null, "清除 key 还原").toBeNull();
});

test("T2 用量：Mock 调用 myUsage 记账+保存后计数增长勾稽+全局视图", async ({ page }) => {
  await login(page, "guanchen@lexflow.demo");
  const u0 = d(await api(page, "ai.myUsage"));
  const calls0 = (u0?.days ?? u0?.items ?? []).reduce((s: number, x: any) => s + (x.calls ?? x.count ?? 0), 0);
  shared.usageBefore = calls0;
  const chat = d(await api(page, "ai.chat", { messages: [{ role: "user", content: "用量勾稽探针：帮我看看本周安排" }] }));
  expect(chat?.provider, "mock provider").toBe("mock");
  expect(chat?.usage?.tokensOut ?? chat?.usageOut, "响应 usage 记账（Mock chars/4 估算）").toBeGreaterThan(0);
  const u1 = d(await api(page, "ai.myUsage"));
  const calls1 = (u1?.days ?? u1?.items ?? []).reduce((s: number, x: any) => s + (x.calls ?? x.count ?? 0), 0);
  expect(calls1, `保存后计数增长（${calls0}→${calls1}）`).toBeGreaterThan(calls0);
  // UI：设置页「我的 AI 用量」卡
  await page.goto(`${B}/settings`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const setText = await page.evaluate(() => document.body.innerText);
  expect(setText, "我的 AI 用量卡在位").toContain("我的 AI 用量");
  expect(setText, "Mock 估算口径注明").toMatch(/估算|Mock/);
  await shot(page, "T2-我的AI用量卡");
  // 全局视图（sysadmin）
  await login(page, "zhaokai@lexflow.demo");
  const admin = d(await api(page, `ai.usageAdmin?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`));
  const rows = (admin?.rows ?? admin?.items ?? []) as any[];
  expect(rows.length, "全局用量行").toBeGreaterThanOrEqual(1);
  await page.goto(`${B}/admin`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.getByRole("tab", { name: "AI 配置" }).or(page.locator("button", { hasText: "AI 配置" })).first().dispatchEvent("click");
  await page.waitForTimeout(800);
  const adminText = await page.evaluate(() => document.body.innerText);
  expect(adminText, "全局用量视图在位").toMatch(/按人|TOP|用量/i);
  await shot(page, "T2-全局用量");
});

test("T3 头像菜单：切换账号/退出登录在位+退出回登录页", async ({ page }) => {
  await login(page, "guanchen@lexflow.demo");
  await page.locator(".ux-dd-trigger.topnav-trigger, button[aria-label*='头像'], .avatar").first().dispatchEvent("click");
  await page.waitForTimeout(600);
  const menuText = await page.evaluate(() => document.body.innerText);
  expect(menuText, "切换账号在位").toContain("切换账号");
  expect(menuText, "退出登录在位").toContain("退出登录");
  await shot(page, "T3-头像菜单");
  await page.getByText("退出登录", { exact: true }).first().dispatchEvent("click");
  await page.waitForURL(/\/login/, { timeout: 10_000 });
  expect(page.url(), "退出回登录页").toContain("/login");
  // 退出后会话失效（旧 cookie 调 API 401）
  const me = await api(page, "auth.me");
  expect([401, 404]).toContain(me.status);
  await shot(page, "T3-退出回登录页");
});

test("T4 375px 抽查：设置页+AI 配置页零横向溢出", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, "guanchen@lexflow.demo");
  await page.goto(`${B}/settings`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "375 设置页零溢出").toBeLessThanOrEqual(1);
  await login(page, "zhaokai@lexflow.demo");
  await page.goto(`${B}/admin`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "375 管理页零溢出").toBeLessThanOrEqual(1);
  await shot(page, "T4-375管理页");
});
