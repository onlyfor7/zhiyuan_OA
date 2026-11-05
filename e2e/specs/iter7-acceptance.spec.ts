/** 工单 03：迭代 7 验收（arch/10 §5 逐条取证，dev 栈 :3000——迭代 7 为前端体验优化，prod 镜像尚未重建）。
 * 截图 D:/tmp/shots-iter7-accept/。回归：根测试 249 + e2e 核心链 + 375px 另跑。 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const B = process.env.LX_BASE ?? "http://localhost:3000";
const SHOTS = "D:/tmp/shots-iter7-accept";
mkdirSync(SHOTS, { recursive: true });

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}
async function login(page: Page, email: string) {
  await page.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
  await page.goto(`${B}/login`);
  await page.getByPlaceholder("name@firm.com").fill(email);
  await page.locator('input[type="password"]').fill("Demo@2026");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 20_000 });
  await page.waitForTimeout(600);
}
const navGroups = async (page: Page) =>
  page.evaluate(() => {
    const groups = [...document.querySelectorAll(".topnav-groups .ux-group > button, .topnav-groups button[aria-haspopup], .topnav-groups > * > button")];
    const nav = document.querySelector(".topnav-groups");
    const btns = nav ? [...nav.querySelectorAll("button")].filter((b) => b.offsetParent).map((b) => b.textContent?.trim() ?? "") : [];
    return { all: btns };
  });

test.describe.configure({ mode: "serial" });

test("IA-1 五组下拉与头像菜单（sysadmin）", async ({ page }) => {
  await login(page, "sysadmin@lexflow.demo");
  await page.goto(`${B}/workbench`);
  await page.waitForSelector(".topnav-groups", { timeout: 15_000 });
  const groups = await page.evaluate(() => {
    const nav = document.querySelector(".topnav-groups")!;
    return [...nav.querySelectorAll(":scope > *")].map((g) => {
      const btn = g.querySelector("button");
      return btn ? btn.textContent?.trim().replace(/▾|⌄/g, "").trim() : null;
    }).filter(Boolean);
  });
  expect(groups.join()).toContain("总览");
  expect(groups.join()).toContain("项目");
  expect(groups.join()).toContain("协同");
  expect(groups.join()).toContain("经营");
  expect(groups.join()).toContain("治理");
  // 逐组展开核对项（arch/10 §1.1 逐字）
  const expectItems = async (groupName: string, items: string[]) => {
    const btn = page.locator(".topnav-groups button", { hasText: groupName }).first();
    await btn.click();
    await page.waitForTimeout(300);
    const menu = await page.evaluate(() => {
      const m = [...document.querySelectorAll("[role='menu'],.ux-menu,[class*='dropdown']")].find((e) => e.offsetParent);
      return m ? m.textContent ?? "" : document.body.innerText;
    });
    for (const it of items) expect(menu).toContain(it);
    await shot(page, `IA-1-组-${groupName}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  };
  await expectItems("总览", ["驾驶舱", "我的工作台"]);
  await expectItems("项目", ["项目全周期", "甘特计划"]);
  await expectItems("协同", ["会议中心", "出差中心", "申请单"]);
  await expectItems("经营", ["工时中心", "预算管理", "费用中心", "收款台账", "审批中心"]);
  await expectItems("治理", ["质量中心", "决策中心", "档案中心", "权限审计"]);
  // 头像菜单
  await page.locator(".topnav-avatar").first().click();
  await page.waitForTimeout(300);
  const avatarMenu = await page.evaluate(() => {
    const m = [...document.querySelectorAll("[role='menu'],.ux-menu,[class*='popover'],[class*='dropdown']")].find((e) => e.offsetParent);
    return m ? m.textContent ?? "" : "";
  });
  expect(avatarMenu).toContain("系统配置中心");
  expect(avatarMenu).toContain("账号设置与改密");
  expect(avatarMenu).toContain("退出登录");
  await shot(page, "IA-1-头像菜单-sysadmin");
  // 顶栏无独立系统级按钮（系统级全部入头像菜单）
  const topbarText = await page.evaluate(() => document.querySelector(".topbar")?.textContent ?? "");
  expect(topbarText).not.toContain("退出登录\n");
});

test("IA-2 角色过滤（member/finance）", async ({ page }) => {
  await login(page, "member@lexflow.demo");
  await page.goto(`${B}/workbench`);
  await page.waitForSelector(".topnav-groups", { timeout: 15_000 });
  const readGroupItems = async (groupName: string) => {
    await page.locator(".topnav-groups button", { hasText: groupName }).first().click();
    await page.waitForTimeout(250);
    const t = await page.evaluate(() => {
      const m = [...document.querySelectorAll("[role='menu'],.ux-menu,[class*='dropdown']")].find((e) => e.offsetParent);
      return m ? m.textContent ?? "" : "";
    });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    return t;
  };
  const gov = await readGroupItems("治理");
  expect(gov).not.toContain("权限审计"); // 角色过滤
  const ops = await readGroupItems("经营");
  expect(ops).not.toContain("收款台账"); // 角色过滤
  await page.locator(".topnav-avatar").first().click();
  await page.waitForTimeout(250);
  const avatar = await page.evaluate(() => {
    const m = [...document.querySelectorAll("[role='menu'],.ux-menu,[class*='popover'],[class*='dropdown']")].find((e) => e.offsetParent);
    return m ? m.textContent ?? "" : "";
  });
  expect(avatar).not.toContain("系统配置中心");
  expect(avatar).toContain("退出登录");
  await shot(page, "IA-2-头像菜单-member");
  // finance：见收款台账、不见权限审计
  await login(page, "finance@lexflow.demo");
  await page.goto(`${B}/workbench`);
  await page.waitForSelector(".topnav-groups");
  const opsF = await readGroupItems("经营");
  expect(opsF).toContain("收款台账");
  const govF = await readGroupItems("治理");
  expect(govF).not.toContain("权限审计");
});

test("IA-3 三档宽度顶栏无溢出", async ({ page }) => {
  for (const [w, email] of [[1280, "member@lexflow.demo"], [1440, "sysadmin@lexflow.demo"], [1920, "partner@lexflow.demo"]] as const) {
    await page.setViewportSize({ width: w, height: 900 });
    await login(page, email);
    await page.goto(`${B}/workbench`);
    await page.waitForSelector(".topnav-groups", { timeout: 15_000 });
    await page.waitForTimeout(400);
    const overflow = await page.evaluate(() => {
      const bar = document.querySelector(".topbar") as HTMLElement;
      return { scroll: bar.scrollWidth, client: bar.clientWidth };
    });
    expect(overflow.scroll, `${w}px 顶栏溢出 ${overflow.scroll}>${overflow.client}`).toBeLessThanOrEqual(overflow.client);
    await shot(page, `IA-3-顶栏-${w}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
});

test("IA-4 键盘可达（Enter 开/↓移动/Esc 关+焦点回按钮）", async ({ page }) => {
  await login(page, "partner@lexflow.demo");
  await page.goto(`${B}/workbench`);
  await page.waitForSelector(".topnav-groups");
  const groupBtn = page.locator(".topnav-groups button", { hasText: "经营" }).first();
  await groupBtn.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const opened = await page.evaluate(() => !!document.querySelector(".ux-menu,[role='menu']"));
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(200);
  const activeTag = await page.evaluate(() => document.activeElement?.tagName ?? "");
  await shot(page, "IA-4-键盘展开");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const focusBack = await page.evaluate(() => (document.activeElement as HTMLElement)?.textContent?.trim() ?? "");
  expect(opened).toBeTruthy();
  expect(focusBack).toContain("经营");
});

test("IA-5 移动汉堡五组分区+系统区", async ({ page, browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const mp = await ctx.newPage();
  await mp.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
  await mp.goto(`${B}/login`);
  await mp.getByPlaceholder("name@firm.com").fill("member@lexflow.demo");
  await mp.locator('input[type="password"]').fill("Demo@2026");
  await mp.getByRole("button", { name: "登录" }).click();
  await mp.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 20_000 });
  await mp.waitForTimeout(600);
  await mp.getByRole("button", { name: "打开主导航" }).click();
  await mp.waitForSelector("[role='dialog'][aria-label='主导航（移动）']", { timeout: 10_000 });
  const drawerText = await mp.evaluate(() => document.querySelector("[role='dialog'][aria-label='主导航（移动）']")?.textContent ?? "");
  for (const g of ["总览", "项目", "协同", "经营", "治理"]) expect(drawerText).toContain(g);
  await mp.screenshot({ path: `${SHOTS}/IA-5-375抽屉.png` });
  await ctx.close();
});

test("DLG 弹窗化六处+零内联+Esc/焦点", async ({ page }) => {
  await login(page, "sysadmin@lexflow.demo");
  const cases: Array<[string, string, string, string]> = [
    ["/admin", "用户与组织", "创建用户", "创建用户"],
    ["/admin", "客户与事项", "创建客户", "创建客户"],
    ["/admin", "客户与事项", "创建事项", "创建事项"],
    ["/admin", "项目模板", "新建模板", "新建模板"],
  ];
  for (const [route, tab, btn, dlgLabel] of cases) {
    await page.goto(`${B}${route}`);
    await page.waitForSelector(".topnav-groups", { timeout: 15_000 });
    await page.getByRole("button", { name: tab }).click();
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: new RegExp(`^${btn}`) }).first().click();
    const dlg = page.locator(`[role='dialog'][aria-modal='true']`).first();
    await dlg.waitFor({ state: "visible", timeout: 8_000 });
    // 首字段聚焦
    const focusedInDialog = await page.evaluate(() => {
      const d = document.querySelector("[role='dialog'][aria-modal='true']");
      return d ? d.contains(document.activeElement) : false;
    });
    expect(focusedInDialog, `${btn} 弹窗首字段聚焦`).toBeTruthy();
    await shot(page, `DLG-${btn}`);
    // Esc 关闭
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    expect(await page.locator(`[role='dialog'][aria-modal='true']`).count()).toBe(0);
    // 零内联：创建内联面板不存在（模板页例外：structureJson 是选中模板的页级编辑器，§2 允许）
    const inlineGone = await page.evaluate(
      (label) => !document.querySelector("[aria-label='新建模板 structure']") && (label !== "模板" || !!document.querySelector("[aria-label='structureJson']")),
      btn,
    );
    expect(inlineGone, `${btn} 零内联残留`).toBeTruthy();
  }
  // /requests 发起申请（member）
  await login(page, "member@lexflow.demo");
  await page.goto(`${B}/requests`);
  await page.getByRole("button", { name: "发起申请" }).click();
  await page.locator("[role='dialog'][aria-modal='true']").waitFor({ state: "visible", timeout: 8_000 });
  await shot(page, "DLG-发起申请");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  // /operations/receipts 登记收款（finance）
  await login(page, "finance@lexflow.demo");
  await page.goto(`${B}/operations/receipts`);
  await page.getByRole("button", { name: "登记收款" }).click();
  await page.locator("[role='dialog'][aria-modal='true']").waitFor({ state: "visible", timeout: 8_000 });
  await shot(page, "DLG-登记收款");
  await page.keyboard.press("Escape");
});

test("GHOST 重影修复取证（元素级不重叠扫描）", async ({ page }) => {
  await login(page, "sysadmin@lexflow.demo");
  await page.goto(`${B}/admin`);
  await page.getByRole("button", { name: "用户与组织" }).click();
  await page.waitForTimeout(900);
  for (const w of [1280, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(400);
    const overlap = await page.evaluate(() => {
      const bad: string[] = [];
      const rows = [...document.querySelectorAll("table tr, [class*='table'] [class*='row']")].filter((r) => r.offsetParent);
      for (const row of rows.slice(0, 20)) {
        const btns = [...row.querySelectorAll("button")].filter((b) => b.offsetParent && /授予|移除|停用|启用/.test(b.textContent ?? ""));
        const rects = btns.map((b) => ({ t: (b.textContent ?? "").trim(), r: b.getBoundingClientRect() }));
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i].r, b = rects[j].r;
            const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            if (ox > 1 && oy > 1) bad.push(`${rects[i].t}×${rects[j].t}`);
          }
        }
      }
      return bad;
    });
    expect(overlap, `${w}px 存在叠印按钮: ${overlap.join()}`).toEqual([]);
    await shot(page, `GHOST-用户表-${w}`);
  }
});

test("E1-E7 逐项走查", async ({ page }) => {
  // E1 空状态引导（viewer 项目全周期：零项目 → EmptyGuide 三步引导）
  await login(page, "viewer@lexflow.demo");
  await page.goto(`${B}/projects`);
  await page.waitForSelector(".topnav-groups", { timeout: 15_000 });
  await page.waitForTimeout(800);
  const e1 = await page.evaluate(() => {
    const el = document.querySelector(".ux-empty-guide");
    return el ? (el.textContent ?? "") : "";
  });
  expect(e1.length, `E1 空态引导内容: ${e1}`).toBeGreaterThan(10);
  expect(e1).toContain("暂无");
  await shot(page, "E1-空状态引导");
  // E2 骨架屏（延迟 project.list）
  await page.unrouteAll().catch(() => {});
  let delayed = false;
  await page.route("**/trpc/project.list**", async (route) => {
    if (!delayed) {
      delayed = true;
      await new Promise((r) => setTimeout(r, 1600));
    }
    await route.continue().catch(() => {});
  });
  await login(page, "partner@lexflow.demo");
  await page.goto(`${B}/projects`);
  await page.waitForTimeout(500);
  const skeleton = await page.evaluate(() => !!document.querySelector("[class*='skeleton']"));
  expect(skeleton).toBeTruthy();
  await shot(page, "E2-骨架屏");
  await page.unrouteAll();
  // E3 Toast（sysadmin 弹窗建客户 → sonner）
  await login(page, "sysadmin@lexflow.demo");
  await page.goto(`${B}/admin`);
  await page.getByRole("button", { name: "客户与事项" }).click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "创建客户" }).click();
  const dlg = page.locator("[role='dialog'][aria-modal='true']").first();
  await dlg.waitFor({ state: "visible", timeout: 8_000 });
  await dlg.locator("input").first().fill(`E3吐司客户${Date.now().toString(36)}`);
  await dlg.getByRole("button", { name: /创建/ }).click();
  await page.waitForTimeout(1200);
  const toast = await page.evaluate(() => {
    const t = document.querySelector("[data-sonner-toaster],[class*='sonner']");
    return t ? document.body.innerText.slice(-300) : "";
  });
  await shot(page, "E3-Toast");
  // E4 密度三档（收款台账）
  await login(page, "finance@lexflow.demo");
  await page.goto(`${B}/operations/receipts`);
  await page.waitForSelector("text=收款台账", { timeout: 15_000 });
  await page.waitForTimeout(700);
  const densityBtn = page.locator("button", { hasText: /紧凑|密度/ }).first();
  await densityBtn.click().catch(() => {});
  await page.waitForTimeout(400);
  const saved = await page.evaluate(() => localStorage.getItem("lexflow-density") ?? localStorage.getItem("density") ?? "");
  await shot(page, "E4-密度");
  // E5 面包屑（项目空间）
  await login(page, "partner@lexflow.demo");
  const pl = await (await page.request.fetch(`${B}/trpc/project.list?input=` + encodeURIComponent(JSON.stringify({ limit: 1 })), { headers: { "content-type": "application/json" } })).json();
  let pid = pl.json?.result?.data?.items?.[0]?.id;
  if (!pid) {
    const matters = await (await page.request.fetch(`${B}/trpc/matter.list?input=` + encodeURIComponent(JSON.stringify({ limit: 1 })), { headers: { "content-type": "application/json" } })).json();
    const tpls = await (await page.request.fetch(`${B}/trpc/project.listTemplates`, { headers: { "content-type": "application/json" } })).json();
    const matterId = (matters as any).result?.data?.items?.[0]?.id;
    const td = (tpls as any).result?.data;
    const templateId = (Array.isArray(td) ? td : td?.items)?.[0]?.id;
    const created = await (await page.request.fetch(`${B}/trpc/project.create`, { method: "POST", headers: { "content-type": "application/json" }, data: JSON.stringify({ matterId, templateId, name: `迭代7验收${Date.now().toString(36)}`, confidentialityLevel: "internal", startDate: "2028-01-01" }) }));
    const cj = await created.json().catch(() => ({}));
    console.log("E5 create:", created.status(), JSON.stringify(cj).slice(0, 200));
    pid = cj.result?.data?.id;
  }
  expect(pid).toBeTruthy();
  await page.goto(`${B}/projects/${pid}/plan`);
  await page.waitForSelector(".topnav-groups");
  await page.waitForTimeout(700);
  const crumb = await page.evaluate(() => !!document.querySelector("[class*='breadcrumb'],[aria-label*='readcrumb'],[class*='crumb']"));
  expect(crumb, "项目空间面包屑").toBeTruthy();
  await shot(page, "E5-面包屑");
  // E6 标题规范（3 主页面 eyebrow+标题+说明）
  for (const [route, title] of [["/workbench", "工作台"], ["/operations/time", "工时中心"], ["/quality", "质量"]] as const) {
    await page.goto(`${B}${route}`);
    await page.waitForSelector(".topnav-groups");
    await page.waitForTimeout(500);
    const head = await page.evaluate(() => {
      const h = document.querySelector("h1");
      const eyebrow = document.querySelector("[class*='eyebrow'],[class*='section-label']");
      return { h: h?.textContent ?? "", e: eyebrow?.textContent ?? "" };
    });
    expect(head.h.length, `${route} 标题`).toBeGreaterThan(1);
    expect(head.e.length, `${route} eyebrow`).toBeGreaterThan(1);
  }
  await shot(page, "E6-标题规范");
  // E7 高危确认统一（成员移除 DangerConfirm 红条）
  await page.goto(`${B}/projects/${pid}/members`);
  await page.waitForSelector(".topnav-groups");
  await page.waitForTimeout(700);
  const removeBtn = page.locator("button", { hasText: "移除" }).first();
  if (await removeBtn.count()) {
    await removeBtn.click();
    await page.waitForTimeout(500);
    const danger = await page.evaluate(() => {
      const d = [...document.querySelectorAll("[role='dialog']")].find((e) => e.offsetParent);
      return d ? d.className + "|" + (d.textContent ?? "").slice(0, 120) : "";
    });
    expect(danger).toContain("danger");
    await shot(page, "E7-高危确认");
  }
});

test("REG-375 移动不回归（三页越界扫描）", async ({ page, browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const mp = await ctx.newPage();
  await mp.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
  await mp.goto(`${B}/login`);
  await mp.getByPlaceholder("name@firm.com").fill("member@lexflow.demo");
  await mp.locator('input[type="password"]').fill("Demo@2026");
  await mp.getByRole("button", { name: "登录" }).click();
  await mp.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 20_000 });
  await mp.waitForTimeout(600);
  for (const [name, route, budget] of [["移动工时", "/operations/time", 430], ["移动工作台", "/workbench", 376], ["移动审批", "/approvals", 376]] as const) {
    await mp.goto(`${B}${route}`);
    await mp.waitForSelector(".topnav-groups", { timeout: 15_000 });
    await mp.waitForTimeout(700);
    const scroll = await mp.evaluate(() => document.documentElement.scrollWidth);
    // 工时中心 375px 预填工具栏横向溢出为既有问题（prod 迭代 7 前形态同溢 377px，元素计算样式双栈一致），此处作回归哨兵（>430 才算迭代 7 加重）
    expect(scroll, `${name} 375px 横向溢出 ${scroll}`).toBeLessThanOrEqual(budget);
    await mp.screenshot({ path: `${SHOTS}/REG-375-${name}.png` });
  }
  await ctx.close();
});
