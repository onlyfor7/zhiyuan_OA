/** 工单 09e：四项修复复测（D2 travel_change 默认流 / D3 transferManager / D1 createTemplate / O1 搜索分组）。
 * 环境变量 LX_BASE 切换栈：dev=http://localhost:3000（默认），prod=http://localhost:8080。
 * 截图 D:/tmp/shots-09e/。既有 249 用例零回归由根 test 套件承担；本 spec 为四点行为复测。 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { installE2eSelfClean } from "./e2e-cleanup";
installE2eSelfClean();

const B = process.env.LX_BASE ?? "http://localhost:3000";
const SHOTS = "D:/tmp/shots-09e";
mkdirSync(SHOTS, { recursive: true });
const stamp = "r" + Date.now().toString(36);

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
async function api(page: Page, path: string, body?: unknown) {
  const res = await page.request.fetch(`${B}/trpc/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json as any).result === undefined) console.log("API-ERR", path.split("?")[0], res.status(), JSON.stringify(json).slice(0, 240));
  return { status: res.status(), json };
}
async function approveUI(browser: any, email: string, tag: string, instId?: string) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await login(p, email);
  await p.goto(`${B}/approvals`);
  await p.waitForSelector("text=审批中心", { timeout: 15_000 });
  await shot(p, tag + "-队列");
  const mine = await api(p, `approval.listMine?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`);
  const all = mine.json.result?.data?.items ?? [];
  const item = instId ? all.find((i: any) => i.instance.id === instId) : all.find((i: any) => i.instance.status === "pending");
  if (item) {
    const r = await api(p, "approval.act", { instanceId: item.instance.id, stepSeq: item.instance.currentStepSeq, action: "approve", idempotencyKey: crypto.randomUUID() });
    console.log("approveUI", email.split("@")[0], item.instance.code, r.status);
  }
  await ctx.close();
}

test.describe.configure({ mode: "serial" });
let projectId = "";
let projectId2 = "";
let travelId = "";
let pmId = "";
let memberId = "";
let partnerId = "";
let templateId = "";

test("RT1 D2 复测：travel_change 变更重审全链不再 412", async ({ page, browser }) => {
  await login(page, "partner@lexflow.demo");
  const users = await api(page, "user.list");
  pmId = users.json.result.data.items.find((u: any) => u.email === "pm@lexflow.demo").id;
  memberId = users.json.result.data.items.find((u: any) => u.email === "member@lexflow.demo").id;
  partnerId = (await api(page, "auth.me")).json.result.data.user.id;
  const matters = await api(page, `matter.list?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`);
  const matterId = matters.json.result.data.items[0].id;
  const tpls0 = await api(page, "project.listTemplates");
  const tplArr = Array.isArray(tpls0.json.result.data) ? tpls0.json.result.data : tpls0.json.result.data.items;
  const tpl0 = tplArr[0].id;
  const proj = await api(page, "project.create", { matterId, templateId: tpl0, name: `复测D2出差项目-${stamp}`, confidentialityLevel: "internal", startDate: "2028-04-01" });
  projectId = proj.json.result.data.id;
  await api(page, "project.addMember", { projectId, userId: memberId, projectRole: "member" });
  await login(page, "member@lexflow.demo");
  const tv = await api(page, "travel.create", { projectId, reason: "D2复测出差", destination: "青岛", startOn: "2028-04-01", endOn: "2028-04-02", estimatedCostCents: 10000, segments: [{ seq: 1, type: "transport", startAt: "2028-04-01T01:00:00.000Z", endAt: "2028-04-01T05:00:00.000Z" }] });
  travelId = tv.json.result.data.id;
  const tvd = await api(page, `travel.getById?input=${encodeURIComponent(JSON.stringify({ id: travelId }))}`);
  const tsub = await api(page, "travel.submit", { id: travelId, rowVersion: tvd.json.result.data.rowVersion, idempotencyKey: crypto.randomUUID() });
  expect(tsub.status).toBe(200);
  await approveUI(browser, "partner@lexflow.demo", "RT1-01-pm出差通过", tsub.json.result.data.instance.id);
  await approveUI(browser, "finance@lexflow.demo", "RT1-02-finance会签通过", tsub.json.result.data.instance.id);
  // D2 核心断言：干净库种子自愈后 submitChange 不再 412
  const ch = await api(page, "travel.submitChange", { id: travelId, changes: { destination: "复测改址" }, reason: "D2复测变更", idempotencyKey: crypto.randomUUID() });
  expect(ch.status, `submitChange 应 200（D2 修复），实际 ${ch.status}`).toBe(200);
  const chInst = ch.json.result.data.instance.id;
  const prog = await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: chInst }))}`);
  expect(prog.json.result.data.policySnapshot.flowName).toContain("travel_change");
  await page.goto(`${B}/approvals`);
  await page.waitForSelector("text=审批中心", { timeout: 15_000 });
  await page.waitForTimeout(700);
  await shot(page, "RT1-03-变更重审实例");
  await approveUI(browser, "partner@lexflow.demo", "RT1-04-变更审批通过", chInst);
  const after = await api(page, `travel.getById?input=${encodeURIComponent(JSON.stringify({ id: travelId }))}`);
  expect(after.json.result.data.destination).toBe("复测改址");
  await page.goto(`${B}/travel/${travelId}`);
  await page.waitForSelector("text=D2复测出差", { timeout: 15_000 });
  await shot(page, "RT1-05-变更后出差详情");
});

test("RT2 D3 复测：变更负责人（通知/审批解析切换/旧负责人降级/审计）", async ({ page, browser }) => {
  await login(page, "partner@lexflow.demo");
  const matters = await api(page, `matter.list?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`);
  const matterId = matters.json.result.data.items[0].id;
  const tpls0 = await api(page, "project.listTemplates");
  const tplArr = Array.isArray(tpls0.json.result.data) ? tpls0.json.result.data : tpls0.json.result.data.items;
  const tpl0 = tplArr[0].id;
  const proj = await api(page, "project.create", { matterId, templateId: tpl0, name: `复测D3负责项目-${stamp}`, confidentialityLevel: "internal", startDate: "2028-04-10" });
  projectId2 = proj.json.result.data.id;
  await api(page, "project.addMember", { projectId: projectId2, userId: pmId, projectRole: "member" });
  await api(page, "project.addMember", { projectId: projectId2, userId: memberId, projectRole: "member" });
  // UI 高危入口：成员页签变更负责人（partner 可见）
  await page.goto(`${B}/projects/${projectId2}/members`);
  await page.waitForSelector("text=变更负责人", { timeout: 15_000 });
  await page.locator("select[aria-label='新负责人']").selectOption({ index: 1 });
  await page.locator(".transfer-panel textarea").fill("D3复测：负责人交接");
  await page.getByRole("button", { name: "提交变更（需二次确认）" }).click();
  await page.waitForSelector("text=确认变更负责人（高危）", { timeout: 10_000 });
  await shot(page, "RT2-01-高危二次确认模态");
  await page.getByRole("button", { name: "确认变更" }).click();
  await expect(page.getByText(/负责人变更已生效/)).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(700);
  await shot(page, "RT2-02-变更后成员页");
  // 断言 1：manager_id 切换（getById 输出 managerName，join 自 manager_id；pm=陈立）
  const pj = await api(page, `project.getById?input=${encodeURIComponent(JSON.stringify({ id: projectId2 }))}`);
  expect(pj.json.result.data.managerName).toBe("陈立");
  // 断言 2：旧负责人降级为成员、新负责人为 manager 成员行
  const members = await api(page, `user.listProjectMembers?input=${encodeURIComponent(JSON.stringify({ projectId: projectId2 }))}`);
  const rows = members.json.result.data.items ?? members.json.result.data;
  const pmRow = (Array.isArray(rows) ? rows : rows.items).find((m: any) => m.userId === pmId || m.id === pmId);
  const partnerRow = (Array.isArray(rows) ? rows : rows.items).find((m: any) => (m.userId ?? m.id) === partnerId);
  expect(pmRow.projectRole).toBe("manager");
  expect(partnerRow.projectRole).toBe("member");
  // 断言 3：新负责人收到通知（旧负责人也收——双通知）
  const ctx = await browser.newContext();
  const pp = await ctx.newPage();
  await login(pp, "pm@lexflow.demo");
  const notice = await api(pp, "notification.listMine");
  expect(JSON.stringify(notice.json)).toContain(projectId2);
  await shot(pp, "RT2-03-新负责人通知");
  await ctx.close();
  // 断言 4：审计行齐备（sysadmin 视角）
  await login(page, "sysadmin@lexflow.demo");
  const aud = await api(page, `audit.list?input=${encodeURIComponent(JSON.stringify({ action: "project.transferManager", limit: 10 }))}`);
  expect(aud.status).toBe(200);
  expect(JSON.stringify(aud.json)).toContain(projectId2);
  // 断言 5：后续 travel 审批解析到新负责人（pm 首步，非 partner）
  await login(page, "member@lexflow.demo");
  const tv = await api(page, "travel.create", { projectId: projectId2, reason: "D3解析验证出差", destination: "济南", startOn: "2028-04-10", endOn: "2028-04-11", estimatedCostCents: 20000, segments: [{ seq: 1, type: "transport", startAt: "2028-04-10T01:00:00.000Z", endAt: "2028-04-10T05:00:00.000Z" }] });
  const tvd = await api(page, `travel.getById?input=${encodeURIComponent(JSON.stringify({ id: tv.json.result.data.id }))}`);
  const tsub = await api(page, "travel.submit", { id: tv.json.result.data.id, rowVersion: tvd.json.result.data.rowVersion, idempotencyKey: crypto.randomUUID() });
  expect(tsub.status).toBe(200);
  const inst = await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: tsub.json.result.data.instance.id }))}`);
  const firstApprover = inst.json.result.data.steps[0].approverId ?? inst.json.result.data.steps[0].approver_id;
  expect(firstApprover).toBe(pmId);
  // 断言 6：旧负责人不再是——partner（已降级为成员）项目内管理权被拒（transferManager 为全局角色运维门，09c 契约，不作越权断言）
  await login(page, "partner@lexflow.demo");
  const deniedAdd = await api(page, "project.addMember", { projectId: projectId2, userId: partnerId, projectRole: "member" });
  expect(deniedAdd.status).toBe(404);
  const deniedClose = await api(page, "project.close", { projectId: projectId2, rowVersion: pj.json.result.data.rowVersion });
  expect(deniedClose.status).toBe(404);
});

test("RT3 D1 复测：/admin 新建模板可用于立项", async ({ page }) => {
  await login(page, "sysadmin@lexflow.demo");
  await page.goto(`${B}/admin`);
  await page.getByRole("button", { name: "项目模板" }).click();
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "新建模板" }).click();
  await page.waitForSelector("text=NEW TEMPLATE", { timeout: 10_000 });
  await page.locator(".grant-apply-form input").first().fill(`复测开发模板-${stamp}`);
  await shot(page, "RT3-01-新建模板表单");
  await page.getByRole("button", { name: "创建模板（服务端校验）" }).click();
  await expect(page.getByText(/已创建/)).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(700);
  await shot(page, "RT3-02-模板已建");
  const tpls = await api(page, "project.listTemplates");
  const tplList = Array.isArray(tpls.json.result.data) ? tpls.json.result.data : tpls.json.result.data.items;
  const hit = tplList.find((t: any) => t.name === `复测开发模板-${stamp}`);
  expect(hit, "新模板应在 listTemplates 中").toBeTruthy();
  templateId = hit.id;
  // 用新模板立项
  await login(page, "partner@lexflow.demo");
  await page.goto(`${B}/projects/new`);
  await page.getByRole("button", { name: new RegExp(`复测开发模板-${stamp}`) }).click();
  await page.locator("input[placeholder*='某某公司']").fill(`复测D1立项项目-${stamp}`);
  const clientSel = page.locator("select[aria-label='选择客户']");
  const clientOpt = clientSel.locator("option").nth(1);
  await clientSel.selectOption({ index: 1 });
  await page.waitForTimeout(600);
  const matterSel = page.locator("select[aria-label='选择事项']");
  await matterSel.selectOption({ index: 1 });
  await shot(page, "RT3-03-新模板立项表单");
  await page.getByRole("button", { name: "创建项目" }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]+\//, { timeout: 20_000 });
  const pid = page.url().split("/projects/")[1].split("/")[0];
  await page.waitForSelector("text=治理要点", { timeout: 15_000 });
  await shot(page, "RT3-04-新模板项目空间");
  // 自动物核对：计划含阶段任务、档案 12 目录
  const plan = await api(page, `plan.current?input=${encodeURIComponent(JSON.stringify({ projectId: pid }))}`);
  expect(plan.status).toBe(200);
  expect(plan.json.result.data.tasks.length + plan.json.result.data.stages.length).toBeGreaterThan(0);
  const tree = await api(page, `archive.tree?input=${encodeURIComponent(JSON.stringify({ projectId: pid }))}`);
  expect(tree.json.result.data.length).toBeGreaterThanOrEqual(10); // 新模板骨架目录数（11 个，非种子模板的 12）
});

test("RT4 O1 复测：搜索多类型分组齐全+totalByType 精确", async ({ page }) => {
  const kw = `复测搜索${stamp}`;
  await login(page, "partner@lexflow.demo");
  for (let i = 1; i <= 6; i++) {
    await api(page, "task.create", { projectId: projectId2, title: `${kw}-任务${i}`, plannedStart: "2028-05-01", plannedEnd: "2028-05-02", assigneeId: memberId });
  }
  await api(page, "meeting.create", { projectId: projectId2, type: "project", subject: `${kw}协调会`, startAt: "2028-05-03T01:00:00.000Z", endAt: "2028-05-03T02:00:00.000Z", participants: [{ userId: memberId }] });
  const r = await api(page, `search.query?input=${encodeURIComponent(JSON.stringify({ q: kw }))}`);
  const data = r.json.result.data;
  expect(data.groups, "应返回分组结构").toBeTruthy();
  const taskGroup = data.groups.find((g: any) => g.type === "task");
  expect(taskGroup.total).toBe(6);
  expect(taskGroup.items.length).toBe(5); // 组内 ≤5
  expect(data.totalByType.task).toBe(6); // 精确计数
  const meetGroup = data.groups.find((g: any) => g.type === "meeting");
  expect(meetGroup.total).toBe(1);
  expect(data.items.length).toBe(6); // 拍平不再全局截断（5 任务+1 会议）
  await page.goto(`${B}/search?q=${encodeURIComponent(kw)}`);
  await page.waitForSelector("text=LEXFLOW", { timeout: 15_000 });
  await page.waitForTimeout(800);
  await shot(page, "RT4-01-搜索分组展示");
});
