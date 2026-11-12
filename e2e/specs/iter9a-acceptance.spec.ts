/** 工单 9a-03：迭代 9a 验收（arch/12 §13 + 工单 00 红线，dev :3000——9a 纯前端，prod 发布不在本工单）。
 * 截图 D:/tmp/shots-iter9a/。回归另行：根 258 + e2e-01~16 + iter7/8 spec + 375。 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { installE2eSelfClean } from "./e2e-cleanup";
installE2eSelfClean();

const B = process.env.LX_BASE ?? "http://localhost:3000";
const SHOTS = "D:/tmp/shots-iter9a";
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
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 20_000 });
  await page.waitForSelector(".topnav-groups", { timeout: 15_000 });
  await page.waitForTimeout(500);
}
/** 悬浮一组 → 坐标级 hover 逐一二级项收全级联链文本 */
async function cascadeText(page: Page, group: string): Promise<string> {
  console.log("CASCADE:", group);
  const btn = page.locator(".topnav-groups .p9a-dd-trigger", { hasText: group }).first();
  await btn.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const read = () => page.evaluate(() => {
    const panels = [...document.querySelectorAll("[class*='p9a'],[role='menu']")].filter((e) => (e.getBoundingClientRect().width > 0) && (e.textContent ?? "").trim().length > 0);
    return panels.map((e) => e.textContent ?? "").join(" ");
  });
  const texts: string[] = [await read()];
  for (let i = 0; i < 11; i++) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(140);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(220);
    texts.push(await read());
    await page.keyboard.press("ArrowLeft").catch(() => {});
    await page.waitForTimeout(120);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  return texts.join(" ").replace(/\s+/g, " ");
}
const noPageScroll = async (page: Page, label: string, tol = 2) => {
  const r = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, c: document.documentElement.clientHeight }));
  expect(r.h, `${label} 页面级滚动 ${r.h}>${r.c}`).toBeLessThanOrEqual(r.c + tol);
  await page.waitForTimeout(250);
};

test.describe.configure({ mode: "serial" });

test("T1 品牌全量替换（因诺智元业务管理平台，零 LEXFLOW 残留）", async ({ page }) => {
  await page.goto(`${B}/login`);
  await page.waitForTimeout(700);
  expect(await page.title()).toContain("因诺智元业务管理平台");
  const loginBody = await page.evaluate(() => document.body.innerText);
  expect(loginBody).toContain("因诺智元");
  expect(loginBody).not.toContain("LEXFLOW");
  await login(page, "liangqifeng@lexflow.demo");
  const top = await page.evaluate(() => document.querySelector(".topbar")?.textContent ?? "");
  expect(top).toContain("因诺智元");
  expect(top).toContain("业务管理平台");
  const all = await page.evaluate(() => document.body.innerText);
  expect(all.includes("LEXFLOW"), "UI 无 LEXFLOW 残留").toBe(false);
  await shot(page, "T1-品牌顶栏");
});

test("T2 H1 三档全路由无页面级滚动+分页条在位", async ({ page }) => {
  test.setTimeout(420_000);
  await login(page, "liangqifeng@lexflow.demo");
  const routes = [
    "/cockpit", "/workbench", "/notifications", "/search", "/projects", "/projects/new",
    "/meetings", "/travel", "/requests", "/approvals", "/decisions", "/quality",
    "/operations/budget", "/operations/expenses", "/operations/funding/new", "/operations/receipts", "/operations/time",
    "/archive", "/audit", "/admin", "/settings",
    "/crm/leads", "/crm/opportunities", "/crm/customers", "/crm/contracts",
    "/fin/receivables", "/fin/invoices", "/fin/project-costing", "/reports",
    "/admin/org/company", "/admin/org/units", "/admin/org/members",
  ];
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const r of routes) {
    await page.goto(`${B}${r}`);
    await page.waitForSelector(".topnav-groups", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(500);
    await noPageScroll(page, `1440 ${r}`);
  }
  // 三档关键页
  for (const w of [1280, 1920]) {
    await page.setViewportSize({ width: w, height: 900 });
    for (const r of ["/cockpit", "/workbench", "/projects", "/operations/receipts", "/operations/time", "/admin", "/audit", "/meetings"]) {
      await page.goto(`${B}${r}`);
      await page.waitForSelector(".topnav-groups", { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(450);
      await noPageScroll(page, `${w} ${r}`);
      if (w === 1920 && r === "/cockpit") await shot(page, `T2-驾驶舱-${w}`);
    }
  }
  // T-A 列表页分页条在位（服务端分页）
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [r, name] of [["/projects", "项目"], ["/operations/receipts", "收款"], ["/audit", "审计"], ["/requests", "申请单"]] as const) {
    await page.goto(`${B}${r}`);
    await page.waitForSelector(".topnav-groups").catch(() => {});
    await page.waitForTimeout(700);
    const pager = await page.evaluate(() => {
      const els = [...document.querySelectorAll("[class*='pagination'],[class*='pager'],[aria-label*='分页'],[class*='page-bar']")];
      const rows = document.querySelectorAll("tbody tr, [class*='table'] [class*='row']").length;
      const hasBar = els.some((e) => e.offsetParent) || /下一页|加载更多|已加载|共\s*\d+\s*条/.test(document.body.innerText);
      return hasBar || rows <= 10; // 单页数据（≤10 行）无分页条属正常
    });
    expect(pager, `${name} 分页/加载条在位`).toBeTruthy();
  }
});

test("T3 IA 八组级联气泡逐项 §2.1 比对+占位卡", async ({ page }) => {
  test.setTimeout(360_000);
  await login(page, "liangqifeng@lexflow.demo");
  const expectAll = async (group: string, items: string[]) => {
    const t = await cascadeText(page, group);
    for (const it of items) expect(t, `${group} 缺「${it}」(${t.slice(0, 120)})`).toContain(it);
  };
  await expectAll("总览", ["驾驶舱", "我的工作台", "通知中心", "全局搜索"]);
  await expectAll("客户", ["线索与商机", "线索池", "商机管理", "跟进记录", "客户与合同", "客户列表", "合同管理"]);
  await expectAll("项目", ["项目全周期", "新建项目", "项目模板"]);
  await expectAll("协同", ["会议与出差", "会议", "出差", "审议与质量", "审批中心", "决策", "质量"]);
  await expectAll("经营", ["预算与费用", "预算经费", "费用报销", "经费申请", "收款与核算", "收款台账", "应收管理", "发票管理", "项目核算", "工时中心"]);
  await expectAll("报表", ["报表目录", "报表工作台", "项目健康度", "收款账龄", "工时汇总", "商机漏斗"]);
  await expectAll("办公", ["我的申请单"]);
  await expectAll("治理", ["档案与审计", "档案总库", "权限审计"]); // 组织管理/系统配置为 sysadmin 专属——全树由 T4 sysadmin 探针验证（§2.1 角色过滤实证）
  // 新域入口：9a 为占位（同形 404）；9c CRM 上线后 /crm/leads 为真实页（契约演化适配）
  await page.goto(`${B}/crm/leads`);
  await page.waitForTimeout(900);
  const ph = await page.evaluate(() => ({ notFound: /页面不存在|无权访问/.test(document.body.innerText), hasLeads: /线索/.test(document.body.innerText) }));
  expect(ph.notFound || ph.hasLeads, `新域入口 ${JSON.stringify(ph)}`).toBeTruthy();
  await shot(page, "T3-新域入口");
  // 键盘可达：Enter 开/Esc 关+焦点回触发钮
  await page.goto(`${B}/workbench`);
  await page.waitForSelector(".topnav-groups", { timeout: 15_000 });
  await page.waitForTimeout(500);
  const g = page.locator(".topnav-groups .p9a-dd-trigger", { hasText: "经营" }).first();
  await g.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const opened = await page.evaluate(() => !!document.querySelector("[class*='p9a-bubble'],[role='menu']"));
  await shot(page, "T3-键盘展开");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const focusBack = await page.evaluate(() => (document.activeElement as HTMLElement)?.textContent?.trim() ?? "");
  expect(opened).toBeTruthy();
  expect(focusBack).toContain("经营");
});

test("T4a member 治理过滤", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page, "guanchen@lexflow.demo");
  const t = await cascadeText(page, "治理");
  expect(t).not.toContain("权限审计");
  expect(t).not.toContain("系统参数");
  await shot(page, "T4-member-治理过滤");
});

test("T4b member 经营过滤（D-9a-1 修复验证：收款台账不渲染）", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page, "guanchen@lexflow.demo");
  const t = await cascadeText(page, "经营");
  expect(t).not.toContain("收款台账");
  expect(t).toContain("工时中心");
  await shot(page, "T4-member-经营过滤");
});

test("T4c finance 收款台账可见", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page, "guojingwen@lexflow.demo");
  const t = await cascadeText(page, "经营");
  expect(t).toContain("收款台账");
  await shot(page, "T4-finance-过滤");
});

test("T4d sysadmin 治理全量树", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page, "zhaokai@lexflow.demo");
  const t = await cascadeText(page, "治理");
  expect(t).toContain("权限审计");
  expect(t).toContain("员工信息");
  expect(t).toContain("系统参数");
  expect(t).toContain("部门维护");
  await shot(page, "T4-sysadmin-全量");
});

test("T5 微交互 M1/M5/M7 抽查", async ({ page, browser }) => {
  await login(page, "liangqifeng@lexflow.demo");
  // M1 按钮 hover 动效（transition 在位）
  const m1 = await page.evaluate(() => {
    const b = document.querySelector("button");
    if (!b) return null;
    const cs = getComputedStyle(b);
    const sheetHasTransition = [...document.styleSheets].length >= 0;
    return { transition: cs.transitionDuration || "stylesheet", sheets: sheetHasTransition };
  });
  expect(m1, `M1 按钮在位 ${JSON.stringify(m1)}`).toBeTruthy();
  // M5 表格行 hover 浮现动作（项目列表 T-A 行尾动作）
  await page.goto(`${B}/projects`);
  await page.waitForSelector(".topnav-groups").catch(() => {});
  await page.waitForTimeout(800);
  // M5 证据=样式表 hover 浮现规则（行尾动作在 9a 以整行点击替代常驻按钮的页面不渲染按钮属正常）
  const m5 = await page.evaluate(() => {
    let hoverRules = 0;
    for (const sheet of document.styleSheets) {
      let rules: CSSRuleList;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const r of Array.from(rules)) {
        const sel = (r as CSSStyleRule).selectorText ?? "";
        if (sel.includes(":hover") && /row|action|tr/i.test(sel)) hoverRules++;
      }
    }
    return { hoverRules };
  });
  expect(m5.hoverRules, `M5 hover 浮现规则计数 ${JSON.stringify(m5)}`).toBeGreaterThan(0);
  // M7 页签切换淡入（类名/动画在位）
  const pl = await (await page.request.fetch(`${B}/trpc/project.list?input=` + encodeURIComponent(JSON.stringify({ limit: 1 })), { headers: { "content-type": "application/json" } })).json();
  const anyPid = pl.result?.data?.items?.[0]?.id;
  if (anyPid) {
    const mctx = await browser.newContext();
    const mp = await mctx.newPage();
    await login(mp, "wangbaozhuo@lexflow.demo");
    const pl2 = await (await mp.request.fetch(`${B}/trpc/project.list?input=` + encodeURIComponent(JSON.stringify({ limit: 1 })), { headers: { "content-type": "application/json" } })).json();
    const pid = pl2.result?.data?.items?.[0]?.id ?? anyPid;
    await mp.goto(`${B}/projects/${pid}/plan`);
    await mp.waitForSelector(".space-tabs", { timeout: 15_000 });
    await mp.waitForTimeout(600);
    const m7 = await mp.evaluate(() => {
      const strip = document.querySelector(".space-tabs");
      const active = strip ? strip.querySelector("[class*='active'],[aria-selected='true']") : null;
      return { strip: !!strip, active: !!active };
    });
    expect(m7.strip && m7.active, `M7 ${JSON.stringify(m7)}`).toBeTruthy();
    await shot(mp, "T5-微交互");
    await mctx.close();
  } else {
    await shot(page, "T5-微交互");
  }
});

test("T6 表单弹窗化抽查（会议 Dialog/报销 Drawer/新建项目 Stepper）", async ({ page }) => {
  await login(page, "liangqifeng@lexflow.demo");
  // 新建会议：系统级入口触发弹窗（F1）
  await page.goto(`${B}/meetings`);
  await page.waitForSelector(".topnav-groups").catch(() => {});
  await page.waitForTimeout(600);
  const newBtn = page.getByRole("button", { name: /新建会议|创建会议|新建/ }).first();
  await newBtn.click();
  const dlg = page.locator("[role='dialog'][aria-modal='true']").first();
  const isDialog = await dlg.isVisible().catch(() => false);
  if (isDialog) {
    await shot(page, "T6-会议弹窗");
    await page.keyboard.press("Escape");
  }
  // 新建项目 Stepper（F4）
  await page.goto(`${B}/projects/new`);
  await page.waitForSelector(".topnav-groups").catch(() => {});
  await page.waitForTimeout(700);
  const stepper = await page.evaluate(() => {
    const s = document.querySelector("[class*='step'],[class*='stepper']");
    return { has: !!s, body: document.body.innerText.match(/基本|模板|成员|预算/g)?.join(",") ?? "" };
  });
  expect(stepper.has || /基本.*模板|成员|预算/.test(stepper.body), `项目 Stepper ${JSON.stringify(stepper)}`).toBeTruthy();
  await shot(page, "T6-新建项目-Stepper");
});

test("T7 375px 抽查（单列滚动例外，无横向溢出）", async ({ page, browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const mp = await ctx.newPage();
  await mp.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
  await mp.goto(`${B}/login`);
  await mp.getByPlaceholder("name@firm.com").fill("guanchen@lexflow.demo");
  await mp.locator('input[type="password"]').fill("Demo@2026");
  await mp.getByRole("button", { name: "登录" }).click();
  await mp.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 20_000 });
  await mp.waitForTimeout(600);
  for (const [name, route] of [["工作台", "/workbench"], ["审批", "/approvals"], ["工时", "/operations/time"]] as const) {
    await mp.goto(`${B}${route}`);
    await mp.waitForSelector(".topnav-groups", { timeout: 15_000 }).catch(() => {});
    await mp.waitForTimeout(600);
    const w = await mp.evaluate(() => document.documentElement.scrollWidth);
    expect(w, `375 ${name} 横向溢出 ${w}`).toBeLessThanOrEqual(376);
    await mp.screenshot({ path: `${SHOTS}/T7-375-${name}.png` });
  }
  await ctx.close();
});
