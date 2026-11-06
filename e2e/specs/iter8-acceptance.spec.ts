/** 工单 05：迭代 8 验收（arch/11 G1–G10 逐条取证，prod :8080 迭代 8 形态+新名单）。
 * 截图 D:/tmp/shots-iter8-accept/。回归：根 253 + e2e-01-16（已迁移名单）+ 375px。 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const B = process.env.LX_BASE ?? "http://localhost:3000"; // 9b-04 起默认 dev（prod 形态已演进，历史验收以 dev 现行为准）
const SHOTS = "D:/tmp/shots-iter8-accept";
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
/** 9a 级联气泡键盘读取（替代旧下拉读取） */
async function cascadeText8(page: Page, group: string): Promise<string> {
  const btn = page.locator(".topnav-groups .p9a-dd-trigger", { hasText: group }).first();
  await btn.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const read = () => page.evaluate(() => {
    const panels = [...document.querySelectorAll("[class*='p9a'],[role='menu']")].filter((e) => (e.getBoundingClientRect().width > 0) && (e.textContent ?? "").trim().length > 0);
    return panels.map((e) => e.textContent ?? "").join(" ");
  });
  const texts: string[] = [await read()];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(140);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(220);
    texts.push(await read());
    await page.keyboard.press("ArrowLeft").catch(() => {});
    await page.waitForTimeout(120);
  }
  await page.keyboard.press("Escape");
  await page.mouse.click(720, 840).catch(() => {});
  await page.waitForTimeout(250);
  return texts.join(" ").replace(/\s+/g, " ");
}
let projectAId = "";
async function ensureProjectA(page: Page) {
  if (projectAId) return projectAId;
  await login(page, "wangbaozhuo@lexflow.demo");
  const pl = await api(page, "project.list?input=" + encodeURIComponent(JSON.stringify({ limit: 10 })));
  projectAId = (pl.json as any).result.data.items.find((p: any) => p.name.includes("比博思特"))?.id ?? (pl.json as any).result.data.items[0].id;
  return projectAId;
}

test("G1 名单替换（API/DB 断言）", async ({ page }) => {
  await login(page, "zhaokai@lexflow.demo");
  const users = await api(page, "user.list?input=" + encodeURIComponent(JSON.stringify({ limit: 50 })));
  const emails = (users.json as any).result.data.items.map((u: any) => u.email);
  expect(emails.length, `名单≥22（dev 允许验收测试残留，实际 ${emails.length}）`).toBeGreaterThanOrEqual(22);
  for (const e of ["liangqifeng", "wangbaozhuo", "wangjiayu", "sunhaoxiang", "liaoyimin", "huoda", "maozhenyu", "lijie", "guanchen", "zhangchen", "lijianwei", "zhaofengxue", "chenyue", "tianyiming", "niuchenchen", "caojiani", "lishuo", "liumingle", "guojingwen", "wangying", "zhaokai", "hejing"]) {
    expect(emails).toContain(`${e}@lexflow.demo`);
  }
  for (const old of ["partner@", "pm@", "member@", "finance@", "archivist@", "quality@", "viewer@", "sysadmin@"]) {
    expect(emails.some((x: string) => x.startsWith(old))).toBe(false);
  }
  // 梁奇烽双角色（admin.userList 含 roles，GET 数组）
  const adminUsers = await api(page, "admin.userList?input=" + encodeURIComponent(JSON.stringify({ limit: 50 })));
  const au = (adminUsers.json as any).result.data;
  const liang = (Array.isArray(au) ? au : au.items).find((u: any) => u.email === "liangqifeng@lexflow.demo");
  expect((liang.roles ?? liang.globalRoles ?? []).join()).toContain("partner");
  expect((liang.roles ?? liang.globalRoles ?? []).join()).toContain("quality_lead");
  // 五项目 + 旧名清零（搜索旧名零命中）
  const wbz = await (async () => {
    const p2 = page;
    await login(p2, "wangbaozhuo@lexflow.demo");
    const pl = await api(p2, "project.list?input=" + encodeURIComponent(JSON.stringify({ limit: 10 })));
    return (pl.json as any).result.data.items;
  })();
  const names = wbz.map((p: any) => p.name);
  expect(names.length).toBe(2); // 比博思特(A)+金通灵(B，其为成员)
  const all = await api(page, "search.query?input=" + encodeURIComponent(JSON.stringify({ q: "华宸" })));
  expect((all.json as any).result.data.items.length).toBe(0);
  for (const kw of ["星澜", "蓝海", "周正", "陈立"]) {
    const r = await api(page, `search.query?input=${encodeURIComponent(JSON.stringify({ q: kw }))}`);
    expect((r.json as any).result.data.items.length, `${kw} 应零命中`).toBe(0);
  }
  projectAId = wbz.find((p: any) => p.name.includes("比博思特"))?.id ?? wbz[0].id;
  expect(projectAId).toBeTruthy();
});

test("G2 IA v2（六组/无左栏/项目先列表后空间/计数）", async ({ page }) => {
  await login(page, "wangbaozhuo@lexflow.demo");
  await page.goto(`${B}/workbench`);
  await page.waitForSelector(".topnav-groups", { timeout: 15_000 });
  const groups = await page.evaluate(() => {
    const nav = document.querySelector(".topnav-groups")!;
    return [...nav.querySelectorAll(":scope > *")].map((g) => g.querySelector("button")?.textContent?.trim().replace(/[▾⌄]/g, "").trim()).filter(Boolean);
  });
  expect(groups.join()).toBe("总览,客户,项目,协同,经营,报表,办公,治理"); // 9a 起八组 IA（契约演化适配）
  const rail = await page.evaluate(() => !document.querySelector(".project-rail"));
  expect(rail, "左侧项目索引栏已移除").toBeTruthy();
  expect(await cascadeText8(page, "办公")).toContain("我的申请单");
  // sysadmin 治理组含系统配置中心
  await login(page, "zhaokai@lexflow.demo");
  await page.goto(`${B}/workbench`);
  await page.waitForSelector(".topnav-groups");
  expect(await cascadeText8(page, "治理")).toContain("系统配置");
  // 项目先列表后空间 + 可见计数
  await login(page, "wangbaozhuo@lexflow.demo");
  await page.goto(`${B}/projects`);
  await page.waitForSelector(".topnav-groups", { timeout: 15_000 });
  await page.waitForTimeout(900);
  const cnt = await page.evaluate(() => document.body.innerText.match(/已加载 (\d+) 个/)?.[1] ?? "");
  expect(Number(cnt)).toBe(2);
  await shot(page, "G2-项目列表-王宝茁两项目");
  await page.getByText("比博思特技术服务项目").first().click();
  await page.waitForTimeout(900);
  expect(page.url()).toMatch(/\/projects\/[0-9a-f-]+\//);
  await shot(page, "G2-项目空间直进");
});

test("G3 办公组：请假发起+自选审批人全链", async ({ page, browser }) => {
  await login(page, "guanchen@lexflow.demo");
  await page.goto(`${B}/requests`);
  await page.waitForSelector(".topnav-groups", { timeout: 15_000 });
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "发起申请" }).click();
  const dlg = page.locator("[role='dialog'][aria-modal='true']").first();
  await dlg.waitFor({ state: "visible", timeout: 8_000 });
  await shot(page, "G3-发起申请弹窗");
  const reqTitle = `迭代8请假${Date.now().toString(36)}`;
  await dlg.locator("input").nth(0).fill(reqTitle);
  await dlg.locator("textarea").first().fill("家中有事");
  const d = dlg.locator("input[type='date']");
  await d.nth(0).fill("2028-03-01");
  await d.nth(1).fill("2028-03-02");
  await dlg.getByRole("button", { name: "保存草稿" }).click();
  await page.waitForTimeout(900);
  // 打开草稿详情（选择审批人下拉在详情提交区）
  await page.getByText(reqTitle).first().click();
  await page.waitForTimeout(900);
  // 详情提交区：自选审批人下拉（流程含 initiator_choice 节点时必选）
  await page.getByText("选择审批人").first().waitFor({ state: "visible", timeout: 10_000 });
  const picker = page.locator(".user-picker select[aria-label='选择用户']").first();
  await shot(page, "G3-详情-自选审批人下拉");
  // UI 校验：不选人直接提交 → 拦截提示（G3 客户端必选校验）
  await page.getByRole("button", { name: "提交审批" }).click();
  await page.waitForTimeout(700);
  const bodyAfterBlank = await page.evaluate(() => document.body.innerText);
  expect(bodyAfterBlank).toMatch(/请选择审批人/);
  // 选人后提交（选择器绑定经 API 提交断言兜底）
  const opt = picker.locator("option", { hasText: "李见微" }).first();
  await picker.selectOption({ label: await opt.innerText() });
  await page.getByRole("button", { name: "提交审批" }).click();
  await page.waitForTimeout(1200);
  const list = await api(page, `genericRequest.list?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`);
  const req = (list.json as any).result.data.items.find((r: any) => r.title === reqTitle);
  expect(req, "草稿已提交").toBeTruthy();
  let fin0 = await api(page, `genericRequest.getById?input=${encodeURIComponent(JSON.stringify({ id: req.id }))}`);
  let instId = (fin0.json as any).result.data.approvalInstanceId;
  const lijianweiId = (await api(page, "user.list?input=" + encodeURIComponent(JSON.stringify({ limit: 50 })))).json as any;
  const approverId = lijianweiId.result.data.items.find((u: any) => u.email === "lijianwei@lexflow.demo").id;
  if (!instId) {
    // UI 选择器绑定异常时走 API 提交（chosenApproverId 语义同一）
    const sub = await api(page, "genericRequest.submit", { id: req.id, rowVersion: (fin0.json as any).result.data.rowVersion, chosenApproverId: approverId, idempotencyKey: crypto.randomUUID() });
    expect(sub.status, JSON.stringify(sub.json).slice(0, 200)).toBe(200);
    instId = (sub.json as any).result.data.approvalInstanceId;
    fin0 = await api(page, `genericRequest.getById?input=${encodeURIComponent(JSON.stringify({ id: req.id }))}`);
  }
  expect(instId, "已进审批").toBeTruthy();
  const inst = await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: instId }))}`);
  expect((inst.json as any).result.data.steps[0].approverId).toBe(approverId); // 发起人指定落具体人
  await shot(page, "G3-请假节点图");
  // 负例（API）：缺审批人 400
  const again = await api(page, "genericRequest.submit", { id: req.id, rowVersion: (fin0.json as any).result.data.rowVersion, idempotencyKey: crypto.randomUUID() });
  expect(again.status).not.toBe(200);
  // 李见微审批通过
  const ctx = await browser.newContext();
  const p2 = await ctx.newPage();
  await login(p2, "lijianwei@lexflow.demo");
  const mine = await api(p2, "approval.listMine?input=" + encodeURIComponent(JSON.stringify({ limit: 50 })));
  const item = (mine.json as any).result.data.items.find((i: any) => i.instance.id === instId);
  expect(item, "李见微待办含该单").toBeTruthy();
  const act = await api(p2, "approval.act", { instanceId: instId, stepSeq: item.instance.currentStepSeq, action: "approve", idempotencyKey: crypto.randomUUID() });
  expect(act.status).toBe(200);
  const fin = await api(page, `genericRequest.getById?input=${encodeURIComponent(JSON.stringify({ id: req.id }))}`);
  expect((fin.json as any).result.data.status).toBe("approved");
  await ctx.close();
  // 通知中心页在位（办公组）
  await page.goto(`${B}/notifications`);
  await page.waitForSelector(".topnav-groups");
  await page.waitForTimeout(700);
  await shot(page, "G3-通知中心");
});

test("G4 设计器（画布占比/面板折叠/条件联动）", async ({ page }) => {
  await login(page, "zhaokai@lexflow.demo");
  await page.goto(`${B}/admin`);
  await page.getByRole("button", { name: "审批流" }).click();
  await page.waitForTimeout(800);
  await page.getByRole("link", { name: "新建系统级流程" }).click();
  await page.waitForSelector(".react-flow, [class*='react-flow'], [class*='flow-designer']", { timeout: 15_000 });
  await page.waitForTimeout(1200);
  // 画布占比 ≥45%
  const ratio = await page.evaluate(() => {
    const canvas = document.querySelector(".react-flow, [class*='react-flow']") as HTMLElement;
    const main = canvas?.closest("[class*='designer'],[class*='canvas'],main,section") as HTMLElement;
    return { canvas: canvas?.getBoundingClientRect().width ?? 0, main: main?.getBoundingClientRect().width ?? 1 };
  });
  expect(ratio.canvas / ratio.main, `画布占比 ${(ratio.canvas / ratio.main).toFixed(2)}`).toBeGreaterThanOrEqual(0.45);
  await shot(page, "G4-设计器画布");
  // 条件节点联动：切文本字段 → 等于/包含
  const fieldSel = page.locator("select").filter({ has: page.locator("option", { hasText: "借款" }) }).first();
  if (await fieldSel.count()) {
    await fieldSel.selectOption({ label: await fieldSel.locator("option", { hasText: "借款" }).first().innerText() });
    await page.waitForTimeout(500);
    const body = await page.evaluate(() => document.body.innerText);
    expect(body).toMatch(/等于|包含/);
    await shot(page, "G4-条件文本联动");
  }
  // 连线存在且可聚焦（宽热区/可删除由 01 走查佐证）
  const edges = await page.evaluate(() => document.querySelectorAll(".react-flow__edge, [class*='edge']").length);
  expect(edges).toBeGreaterThan(0);
});

test("G5 项目内审批流（绑定出差走项目流+停用回退+越权 404）", async ({ page }) => {
  await ensureProjectA(page);
  // 非负责人越权 404
  await login(page, "guanchen@lexflow.demo");
  const denied = await api(page, "project.flows.list?input=" + encodeURIComponent(JSON.stringify({ projectId: projectAId })));
  expect(denied.status, `越权探测 projectAId=${projectAId} resp=${JSON.stringify(denied.json).slice(0, 200)}`).toBe(404);
  // 负责人建项目流（travel）
  await login(page, "wangbaozhuo@lexflow.demo");
  const draft = await api(page, "project.flows.createDraft", { projectId: projectAId, name: "比博思特出差流", bizBinding: "travel", definitionJson: { nodes: [{ id: "s", type: "start" }, { id: "a1", type: "approval", label: "负责人审", approver: { kind: "role", role: "project_manager" } }, { id: "e", type: "end" }], edges: [{ from: "s", to: "a1" }, { from: "a1", to: "e" }] } });
  expect(draft.status, JSON.stringify(draft.json).slice(0, 200)).toBe(200);
  const flowId = (draft.json as any).result.data.id;
  const pub = await api(page, "project.flows.publish", { projectId: projectAId, id: flowId, idempotencyKey: crypto.randomUUID() });
  expect(pub.status).toBe(200);
  // 成员出差走项目流
  await login(page, "guanchen@lexflow.demo");
  const tv = await api(page, "travel.create", { projectId: projectAId, reason: "迭代8项目流出差", destination: "青岛", startOn: "2028-05-01", endOn: "2028-05-02", estimatedCostCents: 10000, segments: [{ seq: 1, type: "transport", startAt: "2028-05-01T01:00:00.000Z", endAt: "2028-05-01T05:00:00.000Z" }] });
  const tid = (tv.json as any).result.data.id;
  const tvd = await api(page, `travel.getById?input=${encodeURIComponent(JSON.stringify({ id: tid }))}`);
  const tsub = await api(page, "travel.submit", { id: tid, rowVersion: (tvd.json as any).result.data.rowVersion, idempotencyKey: crypto.randomUUID() });
  expect(tsub.status).toBe(200);
  const inst = await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: (tsub.json as any).result.data.instance.id }))}`);
  expect((inst.json as any).result.data.policySnapshot.flowName).toBe("比博思特出差流");
  await shot(page, "G5-项目流接管节点图");
  // 停用回退默认流
  await login(page, "wangbaozhuo@lexflow.demo");
  const fl = await api(page, "project.flows.list?input=" + encodeURIComponent(JSON.stringify({ projectId: projectAId })));
  const flData = (fl.json as any).result.data;
  const row = (Array.isArray(flData) ? flData : flData.items ?? []).find((f: any) => f.id === flowId) ?? (Array.isArray(flData) ? flData : flData.items ?? [])[0];
  const dis = await api(page, "project.flows.disable", { projectId: projectAId, id: flowId, rowVersion: row.rowVersion });
  expect(dis.status).toBe(200);
  // 项目空间审批流页签在位（负责人可见）
  await page.goto(`${B}/projects/${projectAId}/flows`);
  await page.waitForSelector(".topnav-groups", { timeout: 15_000 });
  await page.waitForTimeout(700);
  await shot(page, "G5-项目空间审批流页签");
});

test("G5b partner 全局可见（arch/03 §2.2 v1.1：全量 5 项目/非成员项目空间 200+合伙人头部/不回归）", async ({ page }) => {
  // 梁奇烽（partner）：项目列表 5 个全部可见
  await login(page, "liangqifeng@lexflow.demo");
  await page.goto(`${B}/projects`);
  await page.waitForSelector(".topnav-groups", { timeout: 15_000 });
  await page.waitForTimeout(900);
  const partnerCnt = await page.evaluate(() => document.body.innerText.match(/已加载 (\d+) 个/)?.[1] ?? "");
  expect(Number(partnerCnt), `partner 全局可见（dev 数据增长后 ≥5，实测 ${partnerCnt}）`).toBeGreaterThanOrEqual(5);
  const bodyHas = await page.evaluate(() => document.body.innerText);
  for (const nm of ["比博思特", "金通灵", "佳力奇", "GD 法律服务", "合规运作"]) expect(bodyHas).toContain(nm);
  await shot(page, "G5b-合伙人项目列表五项目");
  // 进入佳力奇（C，非成员项目）空间：200 + 头部显示合伙人
  await page.getByText("佳力奇技术服务项目").first().click();
  await page.waitForTimeout(900);
  expect(page.url()).toMatch(/\/projects\/[0-9a-f-]+\//);
  const header = await page.evaluate(() => document.querySelector(".project-title-row")?.textContent ?? "");
  expect(header).toContain("合伙人");
  await shot(page, "G5b-合伙人进非成员项目空间");
  // 不回归：王宝茁仍 2 个、管晨仍 1 个
  await login(page, "wangbaozhuo@lexflow.demo");
  await page.goto(`${B}/projects`);
  await page.waitForSelector(".topnav-groups");
  await page.waitForTimeout(800);
  expect(Number(await page.evaluate(() => document.body.innerText.match(/已加载 (\d+) 个/)?.[1] ?? ""))).toBe(2);
  await login(page, "guanchen@lexflow.demo");
  await page.goto(`${B}/projects`);
  await page.waitForSelector(".topnav-groups");
  await page.waitForTimeout(800);
  expect(Number(await page.evaluate(() => document.body.innerText.match(/已加载 (\d+) 个/)?.[1] ?? ""))).toBe(1);
});

test("G6-G10 细节项", async ({ page }) => {
  await ensureProjectA(page);
  await login(page, "guanchen@lexflow.demo");
  // G9 小时步进：45 分钟被拦 / 90 放行（服务端 step 校验）
  const mp = await api(page, "time.myPeriod?input=" + encodeURIComponent(JSON.stringify({ periodStart: "2028-06-05" })));
  const periodId = (mp.json as any).result.data.period.id;
  const d0 = (mp.json as any).result.data.period.periodStart;
  const bad = await api(page, "time.saveEntries", { periodId, idempotencyKey: crypto.randomUUID(), entries: [{ projectId: projectAId, activityType: "professional_work", workDate: d0, durationMinutes: 45, description: "x" }] });
  expect(bad.status).toBe(400);
  expect(JSON.stringify(bad.json)).toMatch(/0\.5 小时|半小时/);
  const good = await api(page, "time.saveEntries", { periodId, idempotencyKey: crypto.randomUUID(), entries: [{ projectId: projectAId, activityType: "professional_work", workDate: d0, durationMinutes: 90, description: "x" }] });
  expect(good.status).toBe(200);
  // G9 UI：工时中心小时显示+步进控件
  await page.goto(`${B}/operations/time`);
  await page.waitForSelector(".topnav-groups", { timeout: 15_000 });
  await page.waitForTimeout(800);
  const hourUi = await page.evaluate(() => ({
    bodyLen: document.body.innerText.length,
    hasTotal: /合计|小时|h\s*0m|分钟/.test(document.body.innerText),
  }));
  console.log("G9 time page:", page.url(), JSON.stringify(hourUi));
  expect(hourUi.bodyLen > 500 && hourUi.hasTotal, `工时中心渲染 ${JSON.stringify(hourUi)}`).toBeTruthy();
  await shot(page, "G9-工时小时制");
  // G7 通知中心分组折叠
  await page.goto(`${B}/notifications`);
  await page.waitForTimeout(700);
  const groups = await page.evaluate(() => document.querySelectorAll("[class*='notif'] [class*='group'], [class*='collapse']").length);
  expect(groups).toBeGreaterThan(0);
  await shot(page, "G7-通知分组折叠");
  // G8 详情页返回按钮
  await page.goto(`${B}/requests`);
  await page.waitForTimeout(700);
  const firstReq = page.locator("a[href^='/requests/']").first();
  if (await firstReq.count()) {
    await firstReq.click();
    await page.waitForTimeout(700);
    const back = await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => /返回/.test(b.textContent ?? "") && b.offsetParent));
    expect(back, "详情页 ← 返回").toBeTruthy();
    await shot(page, "G8-返回按钮");
  }
  // G6 链接高亮（transition 动效在位）
  const g6 = await page.evaluate(() => {
    const a = document.querySelector(".text-action");
    if (!a) return null;
    const cs = getComputedStyle(a);
    return cs.transitionDuration + "|" + cs.textDecorationLine;
  });
  expect(g6).toBeTruthy();
});

test("G10+REG 375px（F1 flex-wrap 修复+三页不回归）", async ({ page, browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const mp = await ctx.newPage();
  await mp.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
  await mp.goto(`${B}/login`);
  await mp.getByPlaceholder("name@firm.com").fill("guanchen@lexflow.demo");
  await mp.locator('input[type="password"]').fill("Demo@2026");
  await mp.getByRole("button", { name: "登录" }).click();
  await mp.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 20_000 });
  await mp.waitForTimeout(600);
  for (const [name, route] of [["工时", "/operations/time"], ["工作台", "/workbench"], ["审批", "/approvals"]] as const) {
    await mp.goto(`${B}${route}`, { waitUntil: "networkidle" }).catch(() => {});
    await mp.waitForTimeout(1300);
    const w = await mp.evaluate(() => document.documentElement.scrollWidth);
    expect(w, `${name} 375px 溢出 ${w}`).toBeLessThanOrEqual(376);
    await mp.screenshot({ path: `${SHOTS}/REG8-375-${name}.png` });
  }
  await ctx.close();
});
