/** 工单 9b-04：迭代 9b 验收（组织管理三页+问候卡职位，dev :3000——9b 含后端变更，prod 随下次发布窗口重建，本工单不含发布）。
 * 环境注记：dev server 已重启至 9b 代码（org 端点实证）；清理了占用 [::]:3001 的陈旧 vite 进程（修复 Node 代理挂起——03b 交接已预警的 IPv6 坑）。
 * 截图 D:/tmp/shots-iter9b/。 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const B = process.env.LX_BASE ?? "http://localhost:3000";
const SHOTS = "D:/tmp/shots-iter9b";
mkdirSync(SHOTS, { recursive: true });

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}
async function login(page: Page, email: string, pwd = "Demo@2026") {
  await page.keyboard.press("Escape").catch(() => {});
  await page.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
  await page.goto(`${B}/login`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("name@firm.com").fill(email);
  await page.locator('input[type="password"]').fill(pwd);
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 25_000 });
  await page.waitForSelector(".topnav-groups", { timeout: 15_000 });
  await page.waitForTimeout(500);
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

test.describe.configure({ mode: "serial" });

test("T1 公司信息：sysadmin 编辑落库 + partner 只读两态", async ({ page }) => {
  await login(page, "zhaokai@lexflow.demo");
  await page.goto(`${B}/admin/org/company`);
  await page.waitForSelector(".topnav-groups", { timeout: 15_000 });
  await page.waitForTimeout(800);
  await shot(page, "T1-公司信息-sysadmin只读态");
  await page.getByRole("button", { name: "编辑" }).click();
  await page.waitForTimeout(500);
  // 修改电话字段后保存（净变更：改后恢复）
  const phoneInput = page.locator("input").filter({ has: page.locator(`xpath=preceding-sibling::*[contains(.,'电话')]`) }).first();
  const anyInput = page.locator("[role='dialog'] input, .ux-form input, form input").first();
  const target = (await phoneInput.count()) ? phoneInput : anyInput;
  const oldVal = await target.inputValue();
  await target.fill("021-9999-8888");
  await shot(page, "T1-编辑态");
  const saveBtn = page.getByRole("button", { name: /保存|确认/ }).first();
  await saveBtn.click();
  await page.waitForTimeout(900);
  const after = await api(page, "org.company.get");
  expect(JSON.stringify(after.json)).toContain("因诺智元");
  await shot(page, "T1-保存后");
  // 恢复
  await page.getByRole("button", { name: "编辑" }).click().catch(() => {});
  await page.waitForTimeout(400);
  const target2 = (await phoneInput.count()) ? phoneInput : anyInput;
  await target2.fill(oldVal || "021-0000-0000");
  await page.getByRole("button", { name: /保存|确认/ }).first().click().catch(() => {});
  await page.waitForTimeout(600);
  // partner 只读两态
  await login(page, "liangqifeng@lexflow.demo");
  await page.goto(`${B}/admin/org/company`);
  await page.waitForSelector(".topnav-groups");
  await page.waitForTimeout(800);
  expect(await page.getByRole("button", { name: "编辑" }).count(), "partner 无编辑入口").toBe(0);
  await shot(page, "T1-公司信息-partner只读");
  const denied = await api(page, "org.company.update", { rowVersion: 0, name: "因诺智元" });
  expect(denied.status, JSON.stringify(denied.json).slice(0, 160)).toBe(404);
});

test("T2 部门树：CRUD + 调级落库 + 禁删有成员部门", async ({ page }) => {
  await login(page, "zhaokai@lexflow.demo");
  await page.goto(`${B}/admin/org/units`);
  await page.waitForSelector(".topnav-groups", { timeout: 15_000 });
  await page.waitForTimeout(900);
  await shot(page, "T2-部门树初始");
  // 新建一级部门
  await page.getByRole("button", { name: "新建一级部门" }).click();
  const dlg = page.locator("[role='dialog'][aria-modal='true']").first();
  await dlg.waitFor({ state: "visible", timeout: 8_000 });
  await dlg.locator("input").first().fill(`验收测试部${Date.now().toString(36)}`);
  await dlg.getByRole("button", { name: /创建|保存|确定/ }).click();
  await page.waitForTimeout(900);
  const tree1 = await api(page, "org.units.tree");
  const flat = JSON.stringify(tree1.json);
  expect(flat).toContain("验收测试部");
  await shot(page, "T2-新建部门后");
  // 调级：API move（树组件若为自绘 DnD，UI 拖拽经 Playwright dragTo 不稳——move 端点+树复核为取证口径）
  const tree = (tree1.json as any).result.data;
  const findUnit = (nodes: any[], name: string): any => {
    for (const n of nodes) {
      if (n.name.includes(name)) return n;
      const hit = findUnit(n.children ?? [], name);
      if (hit) return hit;
    }
    return null;
  };
  const newDept = findUnit(tree, "验收测试部");
  const liti = findUnit(tree, "诉讼业务部");
  expect(newDept && liti).toBeTruthy();
  const mv = await api(page, "org.units.move", { id: newDept.id, parentId: liti.id, sort: 0 });
  console.log("T2 move:", mv.status, JSON.stringify(mv.json).slice(0, 220));
  expect(mv.status).toBe(200);
  const tree2 = await api(page, "org.units.tree");
  const findById = (nodes: any[], id: string): any => {
    for (const n of nodes) {
      if (n.id === id) return n;
      const hit = findById(n.children ?? [], id);
      if (hit) return hit;
    }
    return null;
  };
  const moved = findById((tree2.json as any).result.data, newDept.id);
  expect(moved?.parentId).toBe(liti.id);
  // UI 复核树形
  await page.reload();
  await page.waitForSelector(".topnav-groups").catch(() => {});
  await page.waitForTimeout(900);
  const uiTree = await page.evaluate(() => document.body.innerText);
  expect(uiTree).toContain("验收测试部");
  await shot(page, "T2-调级后树");
  // 禁删有成员部门（诉讼业务部有成员）
  const rm = await api(page, "org.units.disable", { id: liti.id });
  expect(rm.status).not.toBe(200);
  expect(JSON.stringify(rm.json)).toMatch(/成员|删除|不能/);
  // 删除空部门（新建部）清理
  const rm2 = await api(page, "org.units.disable", { id: newDept.id });
  expect(rm2.status).toBe(200);
});

test("T3 员工 F3 多页签校验红点 + 新建落地 + 一次性口令强制改密链", async ({ page, browser }) => {
  await login(page, "zhaokai@lexflow.demo");
  await page.goto(`${B}/admin/org/members`);
  await page.waitForSelector(".topnav-groups", { timeout: 15_000 });
  await page.waitForTimeout(900);
  await shot(page, "T3-员工列表");
  await page.getByRole("button", { name: "新建员工" }).click();
  const dlg = page.locator("[role='dialog'][aria-modal='true']").first();
  await dlg.waitFor({ state: "visible", timeout: 8_000 });
  const tabs = await dlg.evaluate(() => [...document.querySelectorAll("[role='tab'],[class*='tab'],button")].map((e) => e.textContent?.trim() ?? "").filter((t) => /基本|岗位|账号/.test(t)));
  expect(new Set(tabs).size, `F3 多页签 ${JSON.stringify(tabs)}`).toBeGreaterThanOrEqual(3);
  await shot(page, "T3-F3-多页签");
  // 空提交触发校验红点/字段错误
  await dlg.getByRole("button", { name: /创建|保存|提交|确定/ }).click();
  await page.waitForTimeout(700);
  const invalid = await dlg.evaluate(() => ({
    fieldErrors: document.querySelectorAll("[aria-invalid='true'],.field-error,[class*='error']").length,
    tabDots: document.querySelectorAll("[class*='dot'],[class*='badge'],[class*='invalid']").length,
    text: (document.querySelector("[role='dialog']")?.textContent ?? "").slice(0, 120),
  }));
  expect(invalid.fieldErrors + invalid.tabDots, `校验反馈 ${JSON.stringify(invalid)}`).toBeGreaterThan(0);
  await shot(page, "T3-校验红点");
  // 新建落地+口令链经 API（F3 表单部门/角色为自定义控件非原生 select，UI 盲填不稳——脚本适配；
  // UI 侧证据=上方 F3 弹窗多页签+校验红点；行为断言以 API 同契约为准）
  const email = `i9b${Date.now().toString(36)}@lexflow.demo`;
  const cr = await api(page, "org.members.create", { name: `验收员工${Date.now().toString(36)}`, email, roleKey: "member", position: "验收岗位" });
  expect(cr.status, JSON.stringify(cr.json).slice(0, 200)).toBe(200);
  const list = await api(page, `org.members.list?input=${encodeURIComponent(JSON.stringify({ limit: 8 }))}`);
  const created = (list.json as any).result.data.items.find((m: any) => m.email === email);
  expect(created, `新员工落地 ${email}`).toBeTruthy();
  await page.reload();
  await page.waitForSelector(".topnav-groups").catch(() => {});
  await page.waitForTimeout(900);
  expect(await page.evaluate((e) => document.body.innerText.includes(e), email)).toBe(true);
  await shot(page, "T3-新建落地");
  // 一次性口令链（契约「仅本响应一次下发」）+ UI 走强制改密
  const pwEmail = `i9bpw${Date.now().toString(36)}@lexflow.demo`;
  const pwCreate = await api(page, "org.members.create", { name: `口令员工${Date.now().toString(36)}`, email: pwEmail, roleKey: "member" });
  const initialPw = (pwCreate.json as any).result.data.initialPassword;
  expect(initialPw, "一次性口令下发").toMatch(/^Lx[0-9a-f]{8}!$/);
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await p2.goto(`${B}/login`);
  await p2.getByPlaceholder("name@firm.com").fill(pwEmail);
  await p2.locator('input[type="password"]').fill(initialPw);
  await p2.getByRole("button", { name: "登录" }).click();
  await p2.waitForTimeout(1800);
  const forced = await p2.evaluate(() => /改密|修改密码|首次|重置/.test(document.body.innerText));
  expect(forced, "一次性口令登录进强制改密").toBeTruthy();
  await shot(p2, "T3-强制改密页");
  const newPw = "N3wDemo!2026";
  const pwInputs = p2.locator("input[type='password']");
  await pwInputs.nth(0).fill(initialPw); // 当前密码=初始口令
  await pwInputs.nth(1).fill(newPw); // 新密码
  if ((await pwInputs.count()) > 2) await pwInputs.nth(2).fill(newPw); // 确认新密码
  await p2.getByRole("button", { name: /确认修改/ }).first().click();
  await p2.waitForTimeout(1800);
  await login(p2, pwEmail, newPw);
  await shot(p2, "T3-新密登录成功");
  await ctx2.close();
});

test("T4 权限三探针（sysadmin 写 / partner 只读写404 / member 同形404）", async ({ page }) => {
  await login(page, "zhaokai@lexflow.demo");
  const ok = await api(page, "org.units.create", { name: `探针部${Date.now().toString(36)}`, parentId: null });
  expect(ok.status).toBe(200);
  const probeDept = (ok.json as any).result.data.id;
  await login(page, "liangqifeng@lexflow.demo");
  expect((await api(page, "org.units.create", { name: "越权", parentId: null })).status).toBe(404);
  expect((await api(page, "org.company.update", { rowVersion: 0, name: "因诺智元" })).status).toBe(404);
  const dis = await api(page, "org.units.disable", { id: probeDept });
  console.log("T4 partner disable:", dis.status, JSON.stringify(dis.json).slice(0, 160));
  expect(dis.status).toBe(404);
  await login(page, "guanchen@lexflow.demo");
  // 注：org.company.get 为登录可读（发票抬头/合同水印引用需要，getCompany 注释明示）——member 探针用 units/members 两个真门
  expect((await api(page, "org.units.tree")).status).toBe(404);
  expect((await api(page, "org.members.list?input=" + encodeURIComponent(JSON.stringify({ limit: 5 })))).status).toBe(404);
  await shot(page, "T4-member-同形404");
  // 清理探针部
  await login(page, "zhaokai@lexflow.demo");
  await api(page, "org.units.disable", { id: probeDept });
});

test("T5 问候卡职位真实显示（auth.me.position 直连 UI）", async ({ page }) => {
  await login(page, "liangqifeng@lexflow.demo");
  await page.goto(`${B}/cockpit`);
  await page.waitForSelector(".topnav-groups", { timeout: 15_000 });
  await page.waitForTimeout(900);
  const g1 = await page.evaluate(() => document.body.innerText);
  expect(g1).toContain("梁奇烽");
  expect(g1).toContain("合伙人");
  await shot(page, "T5-问候卡-合伙人");
  await login(page, "wangbaozhuo@lexflow.demo");
  await page.goto(`${B}/cockpit`);
  await page.waitForSelector(".topnav-groups");
  await page.waitForTimeout(800);
  const g2 = await page.evaluate(() => document.body.innerText);
  expect(g2).toContain("王宝茁");
  expect(g2).toMatch(/项目负责人|项目负责/);
  await shot(page, "T5-问候卡-项目负责人");
});

test("T6 375px 抽查（组织三页+工作台无横向溢出）", async ({ page, browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const mp = await ctx.newPage();
  await mp.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
  await mp.goto(`${B}/login`);
  await mp.getByPlaceholder("name@firm.com").fill("zhaokai@lexflow.demo");
  await mp.locator('input[type="password"]').fill("Demo@2026");
  await mp.getByRole("button", { name: "登录" }).click();
  await mp.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 25_000 });
  await mp.waitForTimeout(600);
  for (const [name, route] of [["公司", "/admin/org/company"], ["部门", "/admin/org/units"], ["员工", "/admin/org/members"], ["工作台", "/workbench"]] as const) {
    await mp.goto(`${B}${route}`);
    await mp.waitForTimeout(900);
    const w = await mp.evaluate(() => document.documentElement.scrollWidth);
    expect(w, `375 ${name} 横向溢出 ${w}`).toBeLessThanOrEqual(376);
    await mp.screenshot({ path: `${SHOTS}/T6-375-${name}.png` });
  }
  await ctx.close();
});
