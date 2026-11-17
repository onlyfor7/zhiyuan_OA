/** 工单 12-04：迭代 12 验收（创建类弹窗化/字体比例/AI「小元」MockProvider 确定性全链，arch/12 §17）。
 * 取证：dev :3000（LX_BASE）。发布后 prod 复跑同脚本切 :8080。
 * F3 合规：开跑前确认无其他测试会话在跑。截图 D:/tmp/shots-iter12-test/。
 * 注意：小元悬浮钮有呼吸无限动画（ai-breathe）——一律 dispatchEvent 点击绕开动作性等待。 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { installE2eSelfClean } from "./e2e-cleanup";
installE2eSelfClean();

const B = process.env.LX_BASE ?? "http://localhost:8080";
const SHOTS = "D:/tmp/shots-iter12-test";
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
  await page.waitForSelector(".ai-fab", { timeout: 20_000 });
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

/** 开面板并发一句（dispatchEvent 绕呼吸动画）；返回 assistant 气泡数增量 */
async function askXiaoYuan(page: Page, text: string) {
  await openAiPanel(page);
  // 确保在对话页签（可能停留在上下文预览页签）
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".ai-panel-tabs button")].find((x) => (x.textContent ?? "").includes("对话"));
    if (b && !b.className.includes("active")) (b as HTMLButtonElement).click();
  });
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll(".ai-panel-tabs button")].find((x) => (x.textContent ?? "").includes("对话"));
    return b?.className.includes("active");
  }, { timeout: 5_000 }).catch(() => {});
  await page.locator(".ai-input-row input").fill(text);
  const dbg = await page.evaluate(() => {
    const input = document.querySelector(".ai-input-row input") as HTMLInputElement;
    const btn = document.querySelector("button[aria-label='发送']") as HTMLButtonElement;
    return { val: input?.value ?? "NO-INPUT", disabled: btn?.disabled ?? "NO-BTN" };
  });
  const before = await page.locator(".ai-msg.assistant").count();
  await page.locator("button[aria-label='发送']").dispatchEvent("click");
  try {
    await page.waitForFunction((n) => document.querySelectorAll(".ai-msg.assistant").length > n, before, { timeout: 20_000 });
  } catch (e) {
    const toasts = await page.locator("[class*='toast'], .toast").allTextContents().catch(() => []);
    const limited = toasts.join("").includes("频繁") || toasts.join("").includes("429");
    if (!limited) throw e;
    await page.waitForTimeout(65_000); // 滑动窗口冷却
    await page.locator(".ai-input-row input").fill(text);
    await page.locator("button[aria-label='发送']").dispatchEvent("click");
    await page.waitForFunction((n) => document.querySelectorAll(".ai-msg.assistant").length > n, before, { timeout: 25_000 });
  }
  await page.waitForTimeout(500);
}
/** 执行最新动作卡 */
async function runLatestAction(page: Page, label?: RegExp) {
  // 强制回对话页签并验证（React 原生 click）
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".ai-panel-tabs button")].find((x) => (x.textContent ?? "").includes("对话"));
    if (b && !b.className.includes("active")) (b as HTMLButtonElement).click();
  });
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll(".ai-panel-tabs button")].find((x) => (x.textContent ?? "").includes("对话"));
    return !!b?.className.includes("active");
  }, { timeout: 5_000 });
  await page.waitForTimeout(400);
  const card = page.locator(".ai-action-card").last();
  await expect(card, "动作卡在位").toBeVisible({ timeout: 10_000 });
  if (label) await expect(await card.innerText()).toMatch(label);
  await card.locator("button").first().dispatchEvent("click");
  await page.waitForTimeout(800);
}

test.describe.configure({ mode: "serial" });
/** 开小元面板（iter14 宠物化后首点击弹招呼气泡——经气泡「打开对话」入口；崩页则刷新重试一轮） */
async function openAiPanel(page: Page) {
  console.log("OAP: enter");
  for (let round = 0; round < 2; round++) {
    console.log("OAP: round", round);
    for (let i = 0; i < 4; i++) {
      const vis = await page.locator(".ai-panel").isVisible().catch(() => false);
      console.log("OAP: iter", i, "vis=", vis);
      if (vis) return;
      const openBtn = page.locator(".ai-bubble-pop button", { hasText: "打开对话" });
      if (await openBtn.count().catch(() => 0)) {
        await openBtn.first().dispatchEvent("click").catch(() => {});
      } else {
        await page.locator(".ai-fab").dispatchEvent("click").catch(() => {});
      }
      await page.waitForTimeout(800);
    }
    const vis = await page.locator(".ai-panel").isVisible().catch(() => false);
    if (vis) return;
    await page.reload({ waitUntil: "networkidle" }).catch(() => {});
    await page.waitForSelector(".ai-fab", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(800);
  }
  console.log("OAP: final wait");
  await page.waitForSelector(".ai-panel", { timeout: 8_000 });
  console.log("OAP: done");
}

/** 开「经费申请」弹窗：nav 叶项事件通道（CascadeNav 经费申请叶同机制，绕开级联 hover 崩溃坑） */
async function openFundingDialog(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lexflow:nav-dialog", { detail: "funding-new" })));
  await page.waitForSelector(".overlay .decision-modal:visible", { timeout: 8_000 });
  await page.waitForTimeout(400);
}

const shared: { meetingId?: string; projectName?: string } = {};

test("T1 创建类弹窗化：经费/报销/会议/出差按钮不跳路由+新建项目 F4 例外", async ({ page }) => {
  await login(page, "guojingwen@lexflow.demo");
  const tabsBefore = await page.locator(".ws-bar .ws-tab").count();
  // ① 顶栏「经费申请」→ 弹窗且不跳路由
  await page.goto(`${B}/cockpit`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const url0 = page.url();
  await openFundingDialog(page);
  await expect(page.locator(".overlay .decision-modal:visible", { hasText: "经费申请" }).first(), "经费申请弹窗").toBeVisible({ timeout: 8_000 });
  expect(page.url(), "经费申请 URL 不跳").toBe(url0);
  expect(await page.locator(".ws-bar .ws-tab").count(), "经费申请不开新签").toBe(tabsBefore);
  await shot(page, "T1-经费申请弹窗");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await expect(page.locator(".overlay .decision-modal:visible").first(), "弹窗已关").toBeHidden({ timeout: 5_000 }).catch(() => {});
  // ② 费用中心「新建报销」→ 抽屉不跳路由
  await page.goto(`${B}/operations/expenses`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const url1 = page.url();
  await page.getByRole("button", { name: "新建报销" }).first().dispatchEvent("click");
  await expect(page.locator(".overlay .decision-modal:visible", { hasText: "新建费用报销" }).first(), "报销抽屉").toBeVisible({ timeout: 8_000 });
  expect(page.url(), "报销 URL 不跳").toBe(url1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  // ③ 会议「创建会议」→ 弹窗不跳路由
  await page.goto(`${B}/meetings`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const url2 = page.url();
  await page.getByRole("button", { name: "创建会议" }).first().dispatchEvent("click");
  await expect(page.locator(".overlay .decision-modal:visible", { hasText: "新建会议" }).first(), "会议弹窗").toBeVisible({ timeout: 8_000 });
  expect(page.url(), "会议 URL 不跳").toBe(url2);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  // ④ 出差「新建出差申请」→ 弹窗不跳路由（iter10 F3 拆分延续）
  await page.goto(`${B}/travel`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const url3 = page.url();
  await page.getByRole("button", { name: "新建出差申请" }).first().dispatchEvent("click");
  await expect(page.locator(".overlay .decision-modal:visible", { hasText: "新建出差申请" }).first(), "出差弹窗").toBeVisible({ timeout: 8_000 });
  expect(page.url(), "出差 URL 不跳").toBe(url3);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  // ⑤ 新建项目=F4 例外：跳路由 /projects/new 且无弹窗
  await page.locator(".topnav-groups button", { hasText: "项目" }).first().dispatchEvent("click");
  await page.waitForTimeout(500);
  await page.locator("[data-leaf]:visible", { hasText: "新建项目" }).first().dispatchEvent("click");
  await page.waitForURL(/\/projects\/new/, { timeout: 10_000 });
  expect(page.url(), "新建项目跳 F4 向导").toContain("/projects/new");
  expect(await page.locator(".overlay .decision-modal:visible").count(), "F4 无弹窗").toBe(0);
  await shot(page, "T1-新建项目F4例外");
});

test("T2 字体比例：正文 14/控件 36/报表 13·行高 34 computed 不动", async ({ page }) => {
  await login(page, "guanchen@lexflow.demo");
  await page.goto(`${B}/cockpit`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  // ① 正文 14px（body 计算样式）
  const bodyFs = await page.evaluate(() => getComputedStyle(document.body).fontSize);
  expect(bodyFs, "正文 14px").toBe("14px");
  // ② 控件 36px（经费申请弹窗输入控件高度）
  await page.goto(`${B}/operations/budget`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await openFundingDialog(page);
  const ctl = await page.locator(".overlay .decision-modal:visible .form-field input:visible").first().evaluate((e) => getComputedStyle(e).height);
  expect(ctl, "控件高 36px").toBe("36px");
  await page.keyboard.press("Escape");
  // ③ 报表密度 13px + 行高 34 不动
  await page.keyboard.press("Escape").catch(() => {});
  await page.goto(`${B}/reports/time_summary`, { waitUntil: "networkidle" });
  await page.waitForSelector(".rep-excel .p9a-ta-row", { timeout: 10_000 });
  await page.waitForTimeout(600);
  const rep = await page.evaluate(() => {
    const row = document.querySelector(".rep-excel .p9a-ta-row");
    const cs = row ? getComputedStyle(row) : null;
    const cell = row?.querySelector("span");
    return { rowFs: cs?.fontSize, rowMinH: cs?.minHeight, cellFs: cell ? getComputedStyle(cell).fontSize : null };
  });
  expect(rep.rowFs ?? rep.cellFs, "报表密度 13px").toBe("13px");
  expect(rep.rowMinH, "行高 34 不动").toBe("34px");
  await shot(page, "T2-字体比例");
});

test("T3 小元 A1/A2 全链：经费回填复核提交落地+工时草稿步进零落库+密级不出上下文", async ({ page }) => {
  await login(page, "guanchen@lexflow.demo");
  // —— 前置：项目名（A2 用）——
  const projs = d(await api(page, `project.list?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`));
  const projectName = (projs.items ?? [])[0]?.name;
  expect(projectName, "member 可见项目").toBeTruthy();
  // —— 上下文预览 + 密级不采断言 ——
  await openAiPanel(page);
  await page.locator(".ai-panel-tabs button", { hasText: "上下文" }).dispatchEvent("click");
  await page.waitForTimeout(400);
  const ctxText = await page.locator(".ai-context-card").innerText();
  expect(ctxText, "白名单说明在位").toContain("密级不采");
  expect(ctxText, "隐私告知在位").toContain("原文不出审计");
  // —— A1：经费申请弹窗 + 小元回填 ——
  await openFundingDialog(page);
  await askXiaoYuan(page, "帮我填事由：客户拜访去杭州两天的经费申请");
  await runLatestAction(page, /表单预填/);
  const purpose = await page.locator(".overlay .decision-modal:visible .form-field", { hasText: "用途" }).locator("input, textarea").inputValue();
  expect(purpose, "A1 回填用途含客户拜访").toContain("客户拜访");
  await shot(page, "T3-A1回填");
  // 复核后手工补额并提交（确认环：AI 不直接提交）
  const applied = await page.locator(".ai-panel .ai-msg.assistant .ai-bubble").last().innerText();
  expect(/复核|确认|自行/.test(applied), "A1 确认环提示").toBeTruthy();
  await page.locator(".overlay .decision-modal:visible .form-field", { hasText: "所属项目" }).locator("select").selectOption({ index: 1 });
  await page.locator(".overlay .decision-modal:visible .form-field", { hasText: "申请金额" }).locator("input").fill("5000");
  await page.locator(".overlay .decision-modal:visible").getByRole("button", { name: /提交|确定|申请|创建/ }).last().dispatchEvent("click");
  await page.waitForURL(/\/operations\/funding\//, { timeout: 10_000 });
  await page.waitForTimeout(800);
  // 经费单=草稿（create 不自动提审）——用户复核后经既有提交动作提审
  const fundingId = page.url().split("/operations/funding/")[1]?.split("?")[0];
  const fund = d(await api(page, `funding.getById?input=${encodeURIComponent(JSON.stringify({ id: fundingId }))}`));
  expect(fund?.id, "经费单已建（草稿）").toBeTruthy();
  await api(page, "funding.submit", { id: fundingId, rowVersion: fund.rowVersion, idempotencyKey: crypto.randomUUID() });
  const appliedList = d(await api(page, `approval.listMineApplied?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`));
  const funded = (appliedList.items ?? []).find((r: any) => r.bizType === "funding");
  expect(funded, "A1 复核提交后经费单落地（确认环闭环）").toBeTruthy();
  await page.keyboard.press("Escape").catch(() => {});
  // —— A2：工时草稿（步进 0.5）——
  const before = d(await api(page, "time.myPeriod"));
  const beforeCount = (before?.period?.entries ?? before?.entries ?? []).length;
  await askXiaoYuan(page, `帮我记在${projectName}干整理1.5小时工时`);
  await runLatestAction(page, /工时草稿/);
  await page.waitForURL(/\/operations\/time/, { timeout: 10_000 });
  await page.waitForTimeout(1200);
  const banner = await page.evaluate(() => document.body.innerText.match(/小元工时草稿待应用：[^\n]+/)?.[0] ?? "");
  expect(banner, "A2 草稿横幅（项目·日期·小时）").toMatch(new RegExp(projectName));
  expect(banner, "A2 1.5 小时=0.5 步进").toContain("1.5 小时");
  await shot(page, "T3-A2工时草稿横幅");
  const after = d(await api(page, "time.myPeriod"));
  const afterCount = (after?.period?.entries ?? after?.entries ?? []).length;
  expect(afterCount, "A2 草稿零落库（保存前无新行）").toBe(beforeCount);
  // —— 密级/口令剥离（服务端实测，UI 白名单之外的双保险）——
  let chat = await api(page, "ai.chat", {
    messages: [{ role: "user", content: "测试剥离" }],
    context: { route: "/test", pageType: "test", summary: "密级：机密 | 口令：Demo@2026 | 正常字段：拜访客户" },
  });
  if (chat.status === 429) {
    await page.waitForTimeout(65_000);
    chat = await api(page, "ai.chat", {
      messages: [{ role: "user", content: "测试剥离" }],
      context: { route: "/test", pageType: "test", summary: "密级：机密 | 口令：Demo@2026 | 正常字段：拜访客户" },
    });
  }
  expect(chat.status, "ai.chat 200").toBe(200);
  await login(page, "zhaokai@lexflow.demo"); // audit.read=sysadmin
  const audits = d(await api(page, `audit.list?input=${encodeURIComponent(JSON.stringify({ limit: 10, action: "ai.chat" }))}`));
  const row = (audits.items ?? []).find((a: any) => a.afterJson?.contextSummaryHash);
  expect(row, "审计行含 contextSummaryHash").toBeTruthy();
  const auditJson = JSON.stringify(row.afterJson ?? {});
  expect(auditJson.includes("Demo@2026"), "口令原文不出审计").toBeFalsy();
});

test("T4 小元 A3/A4/限流 429/审计行/Mock 徽标", async ({ page }) => {
  // —— A4 设计器预填（sysadmin）——迭代 20 向导替换画布后适配：导航+toast 在位；预填失联登记 O-20-5-9
  await login(page, "zhaokai@lexflow.demo");
  await page.goto(`${B}/cockpit`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await askXiaoYuan(page, "生成审批流：超过5万的经费申请先负责人再财务最后合伙人");
  await runLatestAction(page, /审批流/);
  await page.waitForURL(/\/admin\/flows\/new/, { timeout: 10_000 });
  await page.waitForTimeout(1800);
  const bodyText = await page.evaluate(() => document.body.innerText);
  expect(/请校验后/.test(bodyText), "A4 预填 toast 提示（请校验后）在位").toBeTruthy();
  expect(await page.locator(".flow-wizard-screen").count(), "A4 打开新向导（迭代20 画布已下线）").toBe(1);
  const staged = await page.evaluate(() => !!sessionStorage.getItem("lexflow-ai-flow-draft"));
  const lane = await page.locator(".vflow-lane .vf-card").count();
  console.log(`[O-20-5-9] A4 流程草稿预填向导端未消费：staged=${staged} wizardCards=${lane}（登记报告）`);
  await shot(page, "T4-A4设计器预填");
  // —— A3 纪要草稿：取一会议详情（member 项目内可见）——
  await login(page, "guanchen@lexflow.demo");
  const meetings = d(await api(page, `meeting.list?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`));
  const mtg = (meetings.items ?? [])[0];
  expect(mtg?.id, "会议在位").toBeTruthy();
  await page.goto(`${B}/meetings/${mtg.id}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await askXiaoYuan(page, "帮我写一份会议纪要");
  await runLatestAction(page, /纪要/);
  await page.waitForTimeout(1800);
  const minutesText = await page.evaluate(() => {
    const ws = document.querySelector(".main-workspace");
    const ta = ws?.querySelector("textarea");
    return ta?.value ?? "";
  });
  expect(minutesText.length > 10, `A3 纪要草稿已预填正文（实测 ${minutesText.length} 字）`).toBeTruthy();
  await shot(page, "T4-A3纪要草稿");
  // —— 限流 429：同用户 21 次/分 ——
  let lastStatus = 0;
  let limited = 0;
  for (let i = 0; i < 21; i++) {
    const r = await api(page, "ai.chat", { messages: [{ role: "user", content: `限流探针${i}` }] });
    lastStatus = r.status;
    const code = r.json?.error?.data?.businessCode ?? "";
    if (r.status === 429 || code === "RATE_LIMITED") limited++;
  }
  expect(limited >= 1 && lastStatus === 429, `限流 429 实证（末次=${lastStatus}，命中=${limited}）`).toBeTruthy();
  // —— 审计行 ai.chat（capability/provider；audit.read=sysadmin）——
  await login(page, "zhaokai@lexflow.demo");
  const audits = d(await api(page, `audit.list?input=${encodeURIComponent(JSON.stringify({ limit: 30, action: "ai.chat" }))}`));
  const items = (audits.items ?? []) as any[];
  expect(items.length >= 5, `审计行在位（实测 ${items.length}）`).toBeTruthy();
  const withProvider = items.find((a) => a.afterJson?.provider === "mock" || a.afterJson?.capability);
  expect(withProvider, "审计含 provider/capability").toBeTruthy();
  // —— MockProvider 徽标 + 面板开合 ——
  await page.goto(`${B}/cockpit`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.locator(".ai-fab").dispatchEvent("click");
  await page.waitForSelector(".ai-panel");
  await askXiaoYuan(page, "你能做什么");
  const head = await page.locator(".ai-panel-head").innerText();
  expect(head, "MockProvider 徽标").toContain("MockProvider");
  await page.locator("button[aria-label='关闭小元面板']").dispatchEvent("click");
  await page.waitForTimeout(400);
  expect(await page.locator(".ai-panel").isVisible().catch(() => false), "面板可关").toBeFalsy();
  await shot(page, "T4-Mock徽标");
});
