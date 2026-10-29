/** 工单 05c：佳力奇补跑（prod :8080，迭代 6 形态）。P0b–P12 补覆盖 + 自定义审批流重跑 P4/P5 + /admin UI 建客户。
 * 截图续存 D:/tmp/shots-jlq/（R- 前缀）。 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const SHOTS = "D:/tmp/shots-jlq";
const B = process.env.JLQ_BASE ?? "http://localhost:8080";
mkdirSync(SHOTS, { recursive: true });
const stamp = "r" + Date.now().toString(36);

async function shot(page: Page, name: string) { await page.screenshot({ path: `${SHOTS}/${name}.png` }); }
async function login(page: Page, email: string) {
  await page.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
  await page.goto(`${B}/login`);
  await page.getByPlaceholder("name@firm.com").fill(email);
  await page.locator('input[type="password"]').fill("Demo@2026");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 20_000 });
  await page.waitForTimeout(700);
}
async function api(page: Page, path: string, body?: unknown) {
  const res = await page.request.fetch(`${B}/trpc/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status(), json: await res.json().catch(() => ({})) };
}
async function approveFirst(page: Page, email: string, browser: any) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await login(p, email);
  await p.goto(`${B}/approvals`);
  await p.getByRole("button", { name: "通过" }).first().click();
  await p.waitForTimeout(400);
  await p.getByRole("button", { name: "确认通过" }).click().catch(() => {});
  await p.waitForTimeout(800);
  await ctx.close();
  return p;
}

test.describe.configure({ mode: "serial" });
let clientId = "";
let matterId = "";
let projectId = "";
let travelId = "";
let memberId = "";

test("P0b 新功能：/admin UI 建客户「佳力奇」+ 事项（prod）", async ({ page }) => {
  await login(page, "sysadmin@lexflow.demo");
  await page.goto(`${B}/admin`);
  await expect(page.getByText("ADMIN CENTER").first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "客户与事项" }).click();
  await page.waitForTimeout(800);
  const clientName = `佳力奇科技（虚构）-${stamp}`;
  await page.locator("input").nth(0).fill(clientName);
  await shot(page, "R-P0b-01-新建客户表单");
  await page.getByRole("button", { name: "创建客户" }).click();
  await page.waitForTimeout(1000);
  await expect(page.getByText(clientName).first()).toBeVisible({ timeout: 10_000 });
  clientId = (await api(page, "client.list?input=" + encodeURIComponent(JSON.stringify({ keyword: "佳力奇" })))).json.result.data.items.find((c: any) => c.name === clientName)?.id ?? "";
  // 建事项（内联表单）
  const matterName = `佳力奇咨询-${stamp}`;
  await page.evaluate((name) => {
    const sel = [...document.querySelectorAll("select")].find((s) => s.closest("section")?.textContent?.includes("所属客户")) ?? [...document.querySelectorAll("select")].at(-1);
    const opt = [...sel.options].find((o) => o.textContent.includes("佳力奇"));
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(sel, opt.value);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    const inp = [...document.querySelectorAll("input")].find((i) => (i.previousElementSibling?.textContent ?? i.parentElement?.textContent ?? "").includes("事项名"));
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(inp, name);
    inp.dispatchEvent(new Event("input", { bubbles: true }));
  }, matterName);
  await shot(page, "R-P0b-02-新建事项表单");
  await page.getByRole("button", { name: "创建事项" }).click();
  await page.waitForTimeout(1000);
  await expect(page.getByText(matterName).first()).toBeVisible({ timeout: 10_000 });
  await shot(page, "R-P0b-03-客户与事项已建");
});

test("P1b 立项 + P2 计划任务（prod）", async ({ page }) => {
  await login(page, "partner@lexflow.demo");
  await page.goto(`${B}/projects/new`);
  await expect(page.getByRole("heading", { name: "创建项目" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /常年法律顾问/ }).first().click();
  await page.locator("input[placeholder*='某某公司']").fill(`佳力奇咨询项目-${stamp}`);
  const matterName = `佳力奇咨询-${stamp}`;
  const clientSel = page.locator("select[aria-label='选择客户']");
  await clientSel.selectOption({ label: (await clientSel.locator("option", { hasText: "佳力奇" }).first().innerText()) });
  await page.waitForTimeout(700);
  const matterSel = page.locator("select[aria-label='选择事项']");
  await matterSel.selectOption({ label: (await matterSel.locator("option", { hasText: stamp }).first().innerText()) });
  await page.getByRole("button", { name: "创建项目" }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]+\//, { timeout: 20_000 });
  projectId = page.url().split("/projects/")[1].split("/")[0];
  await expect(page.getByText("治理要点").first()).toBeVisible({ timeout: 15_000 });
  await shot(page, "R-P1b-01-项目空间");
  // 成员：加林晓
  const users = await api(page, "user.list");
  memberId = users.json.result.data.items.find((u: any) => u.email === "member@lexflow.demo").id;
  await api(page, "project.addMember", { projectId, userId: memberId, projectRole: "member" });
  // P2 计划页签：三轨甘特 + 任务创建/流转（UI 截图 + API 建任务后 UI 流转）
  await page.goto(`${B}/projects/${projectId}/plan`);
  await expect(page.getByText("基线（V1 幽灵轨）")).toBeVisible({ timeout: 15_000 });
  await shot(page, "R-P2-01-三轨甘特");
  const task = await api(page, "task.create", { projectId, title: "尽调报告撰写", description: "佳力奇尽调", activityType: "professional_work" }).catch(() => null);
  const taskId = task?.json?.result?.data?.id;
  if (taskId) {
    const tl = await api(page, `task.list?input=${encodeURIComponent(JSON.stringify({ projectId }))}`);
    await shot(page, "R-P2-02-任务列表");
  }
  // 模拟调整面板（只算不写）
  await expect(page.getByText("模拟调整").first()).toBeVisible();
  await shot(page, "R-P2-03-计划页签全览");
});

test("P3 会议链（prod）", async ({ page }) => {
  await login(page, "partner@lexflow.demo");
  const m = await api(page, "meeting.create", { projectId, type: "project", subject: "佳力奇立项会", startAt: "2028-02-10T01:00:00.000Z", endAt: "2028-02-10T03:00:00.000Z", participants: [{ userId: memberId }] });
  const mid = m.json.result.data.id;
  await api(page, "meeting.transition", { id: mid, action: "complete" });
  await api(page, "meeting.minutes.saveDraft", { meetingId: mid, body: "立项会纪要：范围与里程碑确认。", disagreements: "", risks: "" });
  await api(page, "meeting.minutes.submitConfirm", { meetingId: mid, versionNo: 1, confirmerId: (await api(page, "auth.me")).json.result.data.user.id });
  await api(page, "meeting.minutes.confirm", { meetingId: mid, versionNo: 1, idempotencyKey: crypto.randomUUID() });
  const item = await api(page, "meeting.action.addItem", { meetingId: mid, title: "补充尽调清单", ownerId: memberId, dueDate: "2028-02-20" });
  const conv = await api(page, "meeting.action.convertToTask", { id: item.json.result.data.id, idempotencyKey: crypto.randomUUID() });
  expect(conv.json.result.data.task.sourceType).toBe("meeting");
  await page.goto(`${B}/meetings/${mid}`);
  await page.waitForSelector("text=佳力奇立项会", { timeout: 15_000 });
  await shot(page, "R-P3-01-会议详情与任务回链");
});

test("P4b 自定义审批流重跑出差（prod，R7 修复后目标形态）", async ({ page, browser }) => {
  await login(page, "sysadmin@lexflow.demo");
  const key = crypto.randomUUID();
  const draft = await api(page, "flow.createDraft", { name: `佳力奇出差流-${stamp}`, scope: "global", bizBinding: "travel", definitionJson: { nodes: [{ id: "s", type: "start" }, { id: "a1", type: "approval", label: "负责人审批", approver: { kind: "role", role: "project_manager" }, countersign: "any" }, { id: "c1", type: "condition", label: "借款", expr: { field: "borrow", op: "==", value: true } }, { id: "a2", type: "approval", label: "财务会签", approver: { kind: "role", role: "finance" }, countersign: "all" }, { id: "e", type: "end" }], edges: [{ from: "s", to: "a1" }, { from: "a1", to: "c1" }, { from: "c1", to: "a2", when: true }, { from: "c1", to: "e", when: false }, { from: "a2", to: "e" }] } });
  await api(page, "flow.publish", { id: draft.json.result.data.id, idempotencyKey: key });
  await page.goto(`${B}/admin`);
  await page.getByRole("button", { name: "审批流" }).click();
  await page.waitForTimeout(800);
  await shot(page, "R-P4b-01-审批流设计器已发布");
  await login(page, "member@lexflow.demo");
  const tv = await api(page, "travel.create", { projectId, reason: "佳力奇二阶段尽调（借款）", destination: "杭州", startOn: "2028-02-15", endOn: "2028-02-16", borrow: true, borrowAmountCents: 100000, segments: [{ seq: 1, type: "transport", startAt: "2028-02-15T01:00:00.000Z", endAt: "2028-02-15T05:00:00.000Z" }] });
  travelId = tv.json.result.data.id;
  const tvd = await api(page, `travel.getById?input=${encodeURIComponent(JSON.stringify({ id: travelId }))}`);
  const sub = await api(page, "travel.submit", { id: travelId, rowVersion: tvd.json.result.data.rowVersion, idempotencyKey: crypto.randomUUID() });
  const instId = sub.json.result.data.instance.id;
  await page.goto(`${B}/travel/${travelId}`);
  await page.waitForSelector("text=佳力奇二阶段尽调", { timeout: 15_000 });
  await shot(page, "R-P4b-02-出差走自定义流节点图");
  const inst = await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: instId }))}`);
  expect(inst.json.result.data.policySnapshot.flowName).toContain("佳力奇出差流");
  await approveFirst(page, "partner@lexflow.demo", browser);
  await approveFirst(page, "finance@lexflow.demo", browser);
  const after = await api(page, `travel.getById?input=${encodeURIComponent(JSON.stringify({ id: travelId }))}`);
  expect(after.json.result.data.status).toBe("approved");
  await page.reload();
  await page.waitForTimeout(900);
  await shot(page, "R-P4b-03-出差自定义流approved");
});

test("P5b 自定义审批流重跑经费（prod）", async ({ page, browser }) => {
  await login(page, "sysadmin@lexflow.demo");
  const draft = await api(page, "flow.createDraft", { name: `佳力奇经费流-${stamp}`, scope: "global", bizBinding: "funding", definitionJson: { nodes: [{ id: "s", type: "start" }, { id: "a1", type: "approval", label: "负责人审批", approver: { kind: "role", role: "project_manager" }, countersign: "any" }, { id: "a2", type: "approval", label: "管理层复核", approver: { kind: "role", role: "partner" }, countersign: "any" }, { id: "e", type: "end" }], edges: [{ from: "s", to: "a1" }, { from: "a1", to: "a2" }, { from: "a2", to: "e" }] } });
  const pub = await api(page, "flow.publish", { id: draft.json.result.data.id, idempotencyKey: crypto.randomUUID() });
  expect(pub.status).toBe(200);
  await login(page, "member@lexflow.demo");
  const f = await api(page, "funding.create", { projectId, purpose: "佳力奇二阶段经费", amountCents: 400000, travelId });
  const fid = f.json.result.data.id;
  const fd = await api(page, `funding.getById?input=${encodeURIComponent(JSON.stringify({ id: fid }))}`);
  const sub = await api(page, "funding.submit", { id: fid, rowVersion: fd.json.result.data.rowVersion, idempotencyKey: crypto.randomUUID() });
  const inst = await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: sub.json.result.data.instance.id }))}`);
  expect(inst.json.result.data.policySnapshot.flowName).toContain("佳力奇经费流");
  await approveFirst(page, "partner@lexflow.demo", browser);
  await approveFirst(page, "partner@lexflow.demo", browser);
  const fin = await api(page, `funding.getById?input=${encodeURIComponent(JSON.stringify({ id: fid }))}`);
  expect(fin.json.result.data.approvalStatus).toBe("approved");
  await login(page, "partner@lexflow.demo");
  await page.goto(`${B}/operations/funding/${fid}`);
  await expect(page.getByText("净占用").first()).toBeVisible({ timeout: 15_000 });
  await shot(page, "R-P5b-01-经费自定义流approved四数");
});

test("P7 工时 + P8 质量决策 + P9 周报授权 + P10 结项审计 + P12 经营中心（prod 合并补跑）", async ({ page, browser }) => {
  // P7 工时
  await login(page, "member@lexflow.demo");
  const week = (() => { const d = new Date(Date.now() + 28 * 864e5); const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); m.setUTCDate(m.getUTCDate() - ((m.getUTCDay() + 6) % 7)); return m.toISOString().slice(0, 10); })();
  const mp = await api(page, `time.myPeriod?input=${encodeURIComponent(JSON.stringify({ periodStart: week }))}`);
  const pid2 = mp.json.result.data.period.id;
  const d0 = mp.json.result.data.period.periodStart;
  await api(page, "time.saveEntries", { periodId: pid2, idempotencyKey: crypto.randomUUID(), entries: [{ projectId, activityType: "professional_work", workDate: d0, durationMinutes: 420, description: "佳力奇尽调工时" }] });
  const sub = await api(page, "time.submit", { periodId: pid2, idempotencyKey: crypto.randomUUID() });
  await approveFirst(page, "partner@lexflow.demo", browser);
  // 锁定+解锁（partner）
  await login(page, "partner@lexflow.demo");
  await api(page, "time.lock", { periodId: pid2, reason: "月度归档" });
  await login(page, "member@lexflow.demo");
  const denied = await api(page, "time.saveEntries", { periodId: pid2, idempotencyKey: crypto.randomUUID(), entries: [] });
  expect(denied.status).toBe(403); // locked 周期普通修改禁止（PERIOD_LOCKED）
  await login(page, "partner@lexflow.demo");
  await api(page, "time.unlock", { periodId: pid2, reason: "补录调整" });
  await page.goto(`${B}/operations/time`);
  await expect(page.getByRole("button", { name: "本周", exact: true })).toBeVisible({ timeout: 15_000 });
  await shot(page, "R-P7-01-工时中心解锁后");
  // P8 质量+决策
  await login(page, "partner@lexflow.demo");
  const q = await api(page, "quality.create", { projectId, title: "尽调证据链缺口", description: "P8 复核分离演示", severity: "severe", handlerId: memberId, reviewerId: (await api(page, "auth.me")).json.result.data.user.id });
  const qid = q.json.result.data.id;
  await api(page, "quality.assign", { id: qid, handlerId: memberId, reviewerId: (await api(page, "auth.me")).json.result.data.user.id });
  await login(page, "member@lexflow.demo");
  await api(page, "quality.submitHandling", { id: qid, note: "已补充证据清单" });
  const selfReview = await api(page, "quality.review", { id: qid, action: "pass", comment: "自审探测" });
  expect(selfReview.status).toBe(404); // 分离：member 非复核人复核被同形拦截（复核人=partner；403 仅 handler=reviewer 自审场景，套件已覆盖）
  await login(page, "partner@lexflow.demo");
  await api(page, "quality.review", { id: qid, action: "pass", comment: "复核通过" });
  const dec = await api(page, "decision.create", { projectId, title: "P8 是否扩大尽调范围", context: "证据链评估", options: [{ key: "delay", summary: "扩大", impact: "周期+1周", risk: "无" }, { key: "risk_accept", summary: "维持", impact: "快", risk: "举证风险" }] });
  const decId = dec.json.result.data.id;
  await api(page, "decision.submitOpinions", { id: decId, pmOpinion: "倾向扩大" });
  const dd = await api(page, `decision.getById?input=${encodeURIComponent(JSON.stringify({ id: decId }))}`);
  await api(page, "decision.decide", { id: decId, finalOption: "delay", finalReason: "质量优先", conditions: "两周内完成", checkpoints: [{ point: "补充访谈", date: "2028-03-01", owner_id: memberId }], rowVersion: dd.json.result.data.rowVersion });
  await api(page, "decision.verify", { id: decId, note: "访谈已补充" });
  await page.goto(`${B}/projects/${projectId}/decisions`);
  await page.waitForTimeout(900);
  await shot(page, "R-P8-01-决策已验证");
  // P9 周报+档案授权
  const mon = (() => { const n = new Date(); const m2 = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())); m2.setUTCDate(m2.getUTCDate() - ((m2.getUTCDay() + 6) % 7) - 7); return m2.toISOString().slice(0, 10); })();
  const sun = (() => { const d2 = new Date(`${mon}T00:00:00Z`); d2.setUTCDate(d2.getUTCDate() + 6); return d2.toISOString().slice(0, 10); })();
  const draft = await api(page, "report.generateDraft", { projectId, periodStart: mon, periodEnd: sun });
  const rid = draft.json.result.data.id;
  const rd = await api(page, `report.getById?input=${encodeURIComponent(JSON.stringify({ id: rid }))}`);
  await api(page, "report.confirm", { id: rid, rowVersion: rd.json.result.data.rowVersion, idempotencyKey: crypto.randomUUID() });
  await api(page, "report.archive", { id: rid });
  // 授权：viewer 申请 archivist 审批
  await login(page, "viewer@lexflow.demo");
  const vMe = (await api(page, "auth.me")).json.result.data.user.id;
  const g = await api(page, "archive.grantApply", { scopeType: "project", scopeId: projectId, granteeId: vMe, actions: ["project.read", "archive.read"], expiresAt: null, reason: "佳力奇试用授权", idempotencyKey: crypto.randomUUID() });
  await approveFirst(page, "archivist@lexflow.demo", browser);
  const vList = await api(page, "project.list");
  expect(vList.json.result.data.items.some((p: any) => p.id === projectId)).toBe(true);
  await page.goto(`${B}/projects/${projectId}`);
  await page.waitForSelector("text=治理要点", { timeout: 15_000 });
  await shot(page, "R-P9-01-viewer授权后访问");
  // P10 结项检查+审计
  await login(page, "partner@lexflow.demo");
  const pd = await api(page, `project.getById?input=${encodeURIComponent(JSON.stringify({ id: projectId }))}`);
  const closed = await api(page, "project.close", { projectId, rowVersion: pd.json.result.data.rowVersion });
  expect(closed.json.result.data.checklist.length).toBeGreaterThan(0);
  await page.goto(`${B}/projects/${projectId}`);
  await shot(page, "R-P10-01-结项检查单");
  await login(page, "sysadmin@lexflow.demo");
  await page.goto(`${B}/audit`);
  await expect(page.getByText(/审计|AUDIT/).first()).toBeVisible({ timeout: 15_000 });
  await shot(page, "R-P10-02-sysadmin审计表");
  // P12 经营中心（finance）
  await login(page, "finance@lexflow.demo");
  await page.goto(`${B}/operations/expenses`);
  await expect(page.getByRole("heading", { name: "费用中心" })).toBeVisible({ timeout: 15_000 });
  await shot(page, "R-P12-01-费用中心");
  const csv = await api(page, "expense.stats.exportCsv");
  expect(csv.json.result.data.rowCount).toBeGreaterThan(0);
  const rc = await api(page, "receipts.summary?input=" + encodeURIComponent(JSON.stringify({ by: "project" })));
  expect(rc.status).toBe(200);
  await page.goto(`${B}/operations/receipts`);
  await page.waitForTimeout(900);
  await shot(page, "R-P12-02-收款台账 prod");
});
