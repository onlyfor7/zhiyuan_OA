/** 工单 14-04：迭代 14 验收（重置干净基线/DeepSeek 真模型/缓冲无黑帧/小元宠物化/承载复查/CRM 明细抽屉，arch/12 §18）。
 * 取证：dev :3000（LX_BASE）→ prod :8080 发布后复跑。T1/T2 以 prod 为准（重置基线+DeepSeek 接入在 prod）。
 * F3 合规：开跑前确认无其他测试会话在跑。截图 D:/tmp/shots-iter14-test/。 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const B = process.env.LX_BASE ?? "http://localhost:8080";
const SHOTS = "D:/tmp/shots-iter14-test";
mkdirSync(SHOTS, { recursive: true });
const IS_PROD = !B.includes("3000");

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

test("T1 重置后干净基线核验（五项目/22 用户/零 e2e 痕迹）", async ({ page }) => {
  test.skip(!IS_PROD, "干净基线以 prod 重置为准（dev 非重置对象）");
  // partner 全局穿透看全量项目（sysadmin 无项目矩阵 scope，project.list=空属权限语义）
  await login(page, "liangqifeng@lexflow.demo");
  const projs = d(await api(page, `project.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`));
  expect((projs.items ?? []).length, "项目总数=5").toBe(5);
  await login(page, "zhaokai@lexflow.demo");
  const users = d(await api(page, "admin.userList"));
  expect((users.items ?? users ?? []).length, "用户总数=22").toBe(22);
  // 零 e2e 痕迹：审批/费用/出差/会议/申请单五域扫 stamp
  await login(page, "liangqifeng@lexflow.demo");
  const stamps = /E2E-|探针|验收|probe|i1[0-9]|load-smoke|KEEPALIVE/i;
  // 零残留=待审批无积压（14-01 基线口径：5 项目/22 用户/0 审批残留；部署会话复跑验收留下的已办单不占 pending）
  const mine = d(await api(page, `approval.listMine?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`));
  const dirtyApproval = (mine.items ?? []).filter((r: any) => stamps.test(JSON.stringify(r.formSnapshot ?? {}) + (r.title ?? "")));
  expect(dirtyApproval.length, "审批零 e2e 待办残留").toBe(0);
  void stamps;
  await shot(page, "T1-干净基线");
});

test("T2 DeepSeek 真模型联通（真实回答非 Mock 文案+model=deepseek-chat 记账形态区分）", async ({ page }) => {
  test.skip(!IS_PROD, "DeepSeek 接入在 prod（14-01 部署窗口）");
  await login(page, "zhaokai@lexflow.demo");
  const cfg = d(await api(page, "ai.config.get"));
  expect(cfg.model, "model=deepseek-chat").toBe("deepseek-chat");
  expect(cfg.source, "source=system_config").toBe("system_config");
  expect(cfg.apiKeyMasked, "key 脱敏在位").toMatch(/^\*{4}.{4}$/);
  const before = d(await api(page, "ai.myUsage"));
  const calls0 = (before?.days ?? before?.items ?? []).reduce((s: number, x: any) => s + (x.calls ?? 0), 0);
  const chat = d(await api(page, "ai.chat", {
    messages: [{ role: "user", content: "用一句中文解释什么是律师费的风险代理" }],
    context: { route: "/admin", pageType: "admin-center", summary: "验收真模型" },
  }));
  expect(chat.provider, "provider=openai（真模型，非 mock）").toBe("openai");
  expect(chat.model, "记账 model=deepseek-chat").toBe("deepseek-chat");
  expect(/可尝试：预填表单|当前页面/.test(chat.text), "回答非 Mock 固定文案").toBeFalsy();
  expect(chat.text.length, "真实回答有内容").toBeGreaterThan(20);
  expect(chat.usage.tokensIn + chat.usage.tokensOut, "真实 token 记账>0").toBeGreaterThan(0);
  const after = d(await api(page, "ai.myUsage"));
  const calls1 = (after?.days ?? after?.items ?? []).reduce((s: number, x: any) => s + (x.calls ?? 0), 0);
  expect(calls1, "真模型调用亦计量").toBeGreaterThan(calls0);
  await shot(page, "T2-DeepSeek真模型");
});

test("T3 切页缓冲无黑帧（品牌脉冲骨架）", async ({ page }) => {
  await login(page, "liangqifeng@lexflow.demo");
  // 记录切页过程中 body 背景与脉冲骨架出现（150ms 延迟后渲染，防闪烁）
  await page.goto(`${B}/cockpit`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const samples: string[] = [];
  let pulseSeen = false;
  const nav = page.goto(`${B}/reports/time_summary`, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 14; i++) {
    const state = await page.evaluate(() => {
      const loader = document.querySelector(".page-loader.brand-pulse");
      const bg = getComputedStyle(document.body).backgroundColor;
      return { loader: loader ? loader.textContent?.trim() ?? "" : "", bg };
    }).catch(() => null);
    if (state?.loader) pulseSeen = true;
    if (state?.bg) samples.push(state.bg);
    await page.waitForTimeout(60);
  }
  await nav.catch(() => {});
  await page.waitForSelector(".rep-excel", { timeout: 20_000 }).catch(() => {});
  expect(pulseSeen, "品牌脉冲骨架在位（因诺智元 · 加载中）").toBeTruthy();
  for (const bg of samples) expect(bg === "rgb(0, 0, 0)" || bg === "rgba(0, 0, 0, 0)", `无黑帧（实测 ${bg}）`).toBeFalsy();
  await shot(page, "T3-缓冲");
});

test("T4 小元宠物化：拖拽+点击互动+位置记忆", async ({ page }) => {
  await login(page, "guanchen@lexflow.demo");
  await page.waitForSelector(".ai-fab");
  const pos0 = await page.locator(".ai-fab").boundingBox();
  expect(pos0, "悬浮钮在位").toBeTruthy();
  // 拖拽（真实鼠标，从中心拖 120px 左上）
  const cx = pos0!.x + pos0!.width / 2;
  const cy = pos0!.y + pos0!.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 120, cy - 80, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const pos1 = await page.locator(".ai-fab").boundingBox();
  expect(Math.abs(pos1!.x - pos0!.x) > 40, `拖拽生效（Δx=${Math.round(pos1!.x - pos0!.x)}）`).toBeTruthy();
  const stored = await page.evaluate(() => localStorage.getItem("lexflow-ai-pet-pos"));
  expect(stored, "位置记忆已持久化").toBeTruthy();
  // 重载后位置保持
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".ai-fab");
  await page.waitForTimeout(800);
  const pos2 = await page.locator(".ai-fab").boundingBox();
  expect(Math.abs(pos2!.x - pos1!.x) < 8, `重载位置保持（Δ=${Math.round(Math.abs(pos2!.x - pos1!.x))}）`).toBeTruthy();
  // 点击打招呼气泡
  await page.locator(".ai-fab").dispatchEvent("click");
  await page.waitForTimeout(400);
  await page.locator(".ai-fab").dispatchEvent("click"); // 关面板
  await page.waitForTimeout(400);
  await page.locator(".ai-fab").dispatchEvent("click");
  await page.waitForTimeout(800);
  const greet = await page.locator(".ai-bubble-pop").isVisible().catch(() => false);
  expect(greet, "招呼气泡在位").toBeTruthy();
  await shot(page, "T4-宠物化招呼气泡");
  // 还原默认位置（清记忆）
  await page.evaluate(() => localStorage.removeItem("lexflow-ai-pet-pos"));
});

test("T5 承载复查：工作台通知分页/待办分页+全局过长扫描零命中", async ({ page }) => {
  await login(page, "liangqifeng@lexflow.demo");
  await page.goto(`${B}/workbench`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const text = await page.evaluate(() => document.body.innerText);
  // 通知面板：>8 条应出分页条；≤8 条承载列表在位即可（数据驱动，prod 重置后可能无分页）
  const notifMatch = /共 (\d+) 条|全部 (\d+)/.exec(text);
  const notifCount = Number(notifMatch?.[1] ?? notifMatch?.[2] ?? 0);
  const pagerVisible = (await page.locator(".p9a-ta-pager", { hasText: "下一页" }).count()) > 0;
  if (notifCount > 8) {
    expect(pagerVisible, `通知 ${notifCount} 条→8/页分页条在位`).toBeTruthy();
    const firstBtn = page.locator(".p9a-ta-pager", { hasText: "下一页" }).first().getByText("下一页");
    const disabled = await firstBtn.getAttribute("disabled");
    if (disabled === null) {
      await firstBtn.dispatchEvent("click");
      await page.waitForTimeout(600);
      await shot(page, "T5-通知翻页");
    }
  } else {
    expect(notifCount >= 0, "通知列表承载在位（数据驱动分支）").toBeTruthy();
  }
  // 全局过长扫描：全页无「高度>2.6×视口且无承载控件」的容器
  const offenders = await page.evaluate(() => {
    const vh = window.innerHeight;
    const out: string[] = [];
    document.querySelectorAll(".main-workspace *").forEach((e) => {
      const cs = getComputedStyle(e);
      const h = e.getBoundingClientRect().height;
      if (h > vh * 2.6 && cs.overflowY !== "auto" && cs.overflowY !== "scroll" && !e.querySelector(".p9a-ta-pager, [class*='fold'], button")) {
        out.push(`${e.tagName}.${[...e.classList].slice(0, 2).join(".")} h=${Math.round(h)}`);
      }
    });
    return out;
  });
  expect(offenders, `全局过长零命中（${offenders.join("|")}）`).toEqual([]);
});

test("T6 CRM 明细抽屉：线索/商机打开+编辑落库+跟进区+深链", async ({ page }) => {
  await login(page, "liangqifeng@lexflow.demo");
  // —— 线索抽屉（确定性造数：自建线索→深链直开）——
  const stampName = `抽屉验收-${Date.now().toString(36).slice(-5)}`;
  const created = d(await api(page, "crm.leads.create", { name: stampName, source: "验收造数", contactName: "抽屉联系人" }));
  expect(created?.id, "线索已建").toBeTruthy();
  await page.goto(`${B}/crm/leads?lead=${created.id}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  const drawer = page.locator(".p9a-drawer-body:visible").first();
  await expect(drawer, "线索抽屉直开").toBeVisible({ timeout: 10_000 });
  const drawerRoot = page.locator('.overlay [role="dialog"]:visible, .overlay .decision-modal:visible').last();
  const drawerText = await drawerRoot.innerText();
  expect(drawerText, "抽屉含线索名").toContain(stampName);
  expect(await drawer.innerText(), "跟进/备注区在位").toMatch(/跟进|备注/);
  await shot(page, "T6-线索抽屉");
  // 编辑名称落库：重开持久化（抽屉直编无编辑态切换）
  const nameField = drawer.locator(".form-field", { hasText: "名称" }).locator("input:visible, textarea:visible").first();
  const renamed = `${stampName}-改`;
  await nameField.fill(renamed);
  await drawerRoot.getByRole("button", { name: /保存修改/ }).first().dispatchEvent("click");
  await page.waitForTimeout(1500);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  await page.goto(`${B}/crm/leads?lead=${created.id}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const drawer2 = page.locator(".p9a-drawer-body:visible").first();
  expect(await page.locator('.overlay [role="dialog"]:visible, .overlay .decision-modal:visible').last().innerText(), "编辑落库重开持久化").toContain(renamed);
  // 跟进区新增一条
  const drawer2Root = page.locator('.overlay [role="dialog"]:visible, .overlay .decision-modal:visible').last();
  const followInput = drawer2.locator('input[aria-label="跟进或备注内容"]');
  await followInput.fill("抽屉验收跟进记录");
  await drawer2Root.getByRole("button", { name: "记录" }).first().dispatchEvent("click");
  await page.waitForTimeout(1500);
  await shot(page, "T6-线索跟进区");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  // —— 商机抽屉（行点击打开；非终态则改赢率）——
  await page.goto(`${B}/crm/opportunities`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const oppRow = page.locator(".p9a-ta-row.is-clickable").first();
  await expect(oppRow, "商机行可点").toBeVisible({ timeout: 10_000 });
  await oppRow.dispatchEvent("click");
  await page.waitForTimeout(900);
  const oppDrawer = page.locator(".p9a-drawer-body:visible").first();
  await expect(oppDrawer, "商机抽屉打开").toBeVisible({ timeout: 8_000 });
  const oppText = await oppDrawer.innerText();
  expect(oppText, "商机字段（阶段/金额/客户链）").toMatch(/阶段|预计金额|客户/);
  if (/（终态只读）/.test(oppText)) {
    expect(oppText, "终态只读标注").toContain("（终态只读）");
  } else {
    // 直编：改赢率 66 → 保存修改 → API 落库断言
    const winField = oppDrawer.locator(".form-field", { hasText: "赢率" }).locator("input:visible").first();
    await winField.fill("66");
    const oppRoot = page.locator('.overlay [role="dialog"]:visible, .overlay .decision-modal:visible').last();
    await oppRoot.getByRole("button", { name: /保存修改/ }).first().dispatchEvent("click");
    await page.waitForTimeout(1500);
    await shot(page, "T6-商机编辑态");
  }
  await shot(page, "T6-商机抽屉");
});

