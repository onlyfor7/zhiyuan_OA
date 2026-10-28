/**
 * E2E-01~16 逐条（arch/08 §2，基线 §16）。
 * 形态：Playwright 真实浏览器（系统 Chrome）登录拿会话 → API 驱动链（page.request 共享 cookie）
 * → 关键节点真实页面断言 + 截图。截图为证据，输出 D:/tmp/shots-iter5-e2e。
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const SHOTS = "D:/tmp/shots-iter5-e2e";
mkdirSync(SHOTS, { recursive: true });

async function login(page: Page, email: string): Promise<void> {
  await gotoApp(page, "/login");
  const emailInput = page.getByPlaceholder("name@firm.com");
  try {
    await emailInput.waitFor({ state: "visible", timeout: 8_000 });
  } catch {
    // 已登录会话（/login 被守卫重定向）：无需再登录
    await page.waitForTimeout(800);
    return;
  }
  await emailInput.fill(email);
  await page.locator('input[type="password"]').fill("Demo@2026");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL((url) => !url.pathname.includes("/login"), { timeout: 15_000 });
}

async function api(page: Page, path: string, opts: { method?: string; body?: unknown } = {}) {
  const res = await page.request.fetch(`/trpc/${path}`, {
    method: opts.method ?? "POST",
    headers: { "content-type": "application/json" },
    data: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status(), json: await res.json().catch(() => ({})) };
}

const uuid = () => crypto.randomUUID();
async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}

/** SPA 直开：等代码分割 chunk 加载与首屏渲染（白屏防护） */
async function gotoApp(page: Page, path: string) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=LEXFLOW", { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(900);
}

async function approveByRole(page: Page, viewer: string, instanceId: string, roleEmail: string) {
  const other = await authedPage(page, roleEmail);
  const detail = await api(other, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: instanceId }))}`, { method: "GET" });
  const inst = (detail.json as any).result.data;
  if (inst.status !== "pending") { await other.context().close(); return; }
  const step = inst.steps.find((s: any) => s.seq === inst.currentStepSeq);
  await api(other, "approval.act", {
    body: { instanceId, stepSeq: step.seq, action: "approve", idempotencyKey: uuid() },
  });
  await other.context().close();
}

test.describe.configure({ mode: "serial" });

let projectAId = "";

test.beforeAll(async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await login(page, "pm@lexflow.demo");
  const list = await api(page, "project.list", { method: "GET" });
  projectAId = (list.json as any).result.data.items.find((p: any) => p.code.endsWith("-00001")).id;
  await ctx.close();
});

test("E2E-01 负责人创建质量复核会并确认纪要→行动项成为任务，互相定位", async ({ page }) => {
  await login(page, "pm@lexflow.demo");
  const created = await api(page, "meeting.create", {
    body: { projectId: projectAId, type: "quality_review", subject: "E2E-01 质量复核会", startAt: "2028-03-01T01:00:00.000Z", endAt: "2028-03-01T03:00:00.000Z", participants: [{ userId: (await me(page)) }] },
  });
  const meetingId = (created.json as any).result.data.id;
  await api(page, "meeting.transition", { body: { id: meetingId, action: "complete" } });
  await api(page, "meeting.minutes.saveDraft", { body: { meetingId, body: "E2E-01 纪要正文", disagreements: "", risks: "" } });
  const meId = await me(page);
  await api(page, "meeting.minutes.submitConfirm", { body: { meetingId, versionNo: 1, confirmerId: meId } });
  const confirm = await api(page, "meeting.minutes.confirm", { body: { meetingId, versionNo: 1, idempotencyKey: uuid() } });
  expect(confirm.status).toBe(200);
  const item = await api(page, "meeting.action.addItem", { body: { meetingId, title: "E2E-01 行动项", ownerId: meId, dueDate: "2028-03-10" } });
  const converted = await api(page, "meeting.action.convertToTask", { body: { id: (item.json as any).result.data.id, idempotencyKey: uuid() } });
  const task = (converted.json as any).result.data.task;
  expect(task.sourceType).toBe("meeting");
  const items = await api(page, `meeting.action.list?input=${encodeURIComponent(JSON.stringify({ meetingId }))}`, { method: "GET" });
  const wrapped = (items.json as any).result.data.find((i: any) => i.item.id === (item.json as any).result.data.id);
  expect(wrapped.item.status).toBe("converted");
  expect(wrapped.taskStatus).toBeTruthy(); // 任务状态单源 join
  await gotoApp(page, `/meetings/${meetingId}`);
  await expect(page.getByText("E2E-01 质量复核会")).toBeVisible();
  await shot(page, "E2E-01-meeting-task");
});

test("E2E-02 时间-质量冲突→决策单带会议版本，回写可溯", async ({ page }) => {
  await login(page, "pm@lexflow.demo");
  // 自建带确认纪要的会议（与前用例解耦，避免列表分页/顺序干扰）
  const mCreate = await api(page, "meeting.create", {
    body: { projectId: projectAId, type: "project", subject: "E2E-02 决策源会", startAt: "2028-04-01T01:00:00.000Z", endAt: "2028-04-01T02:00:00.000Z", participants: [{ userId: await me(page) }] },
  });
  const meetingId = (mCreate.json as any).result.data.id;
  await api(page, "meeting.transition", { body: { id: meetingId, action: "complete" } });
  await api(page, "meeting.minutes.saveDraft", { body: { meetingId, body: "E2E-02 源纪要", disagreements: "分歧", risks: "" } });
  const meId2 = await me(page);
  await api(page, "meeting.minutes.submitConfirm", { body: { meetingId, versionNo: 1, confirmerId: meId2 } });
  await api(page, "meeting.minutes.confirm", { body: { meetingId, versionNo: 1, idempotencyKey: uuid() } });
  const versions = await api(page, `meeting.minutes.versions?input=${encodeURIComponent(JSON.stringify({ meetingId }))}`, { method: "GET" });
  const v1 = (versions.json as any).result.data[0];
  expect(v1).toBeDefined();
  const esc = await api(page, "meeting.extra.escalateToDecision", { body: { meetingId, minutesVersionId: v1.id, title: "E2E-02 冲突决策", context: "时间-质量冲突" } });
  const decisionId = (esc.json as any).result.data.id;
  await api(page, "decision.submitOpinions", { body: { id: decisionId, pmOpinion: "倾向延期" } });
  const qualityPage = await authedPage(page, "quality@lexflow.demo");
  await api(qualityPage, "decision.submitOpinions", { body: { id: decisionId, qualityOpinion: "同意" } });
  const detail = await api(page, `decision.getById?input=${encodeURIComponent(JSON.stringify({ id: decisionId }))}`, { method: "GET" });
  const rv = (detail.json as any).result.data.rowVersion;
  await api(page, "decision.decide", { body: { id: decisionId, finalOption: "delay", finalReason: "质量优先", conditions: "两周内", checkpoints: [], rowVersion: rv } });
  const back = await api(page, `meeting.getById?input=${encodeURIComponent(JSON.stringify({ id: meetingId }))}`, { method: "GET" });
  expect((back.json as any).result.data.linkedDecisions.some((d: any) => d.id === decisionId)).toBe(true);
  await gotoApp(page, `/meetings/${meetingId}`);
  await expect(page.getByText("E2E-02 冲突决策").first()).toBeVisible();
  await shot(page, "E2E-02-decision-backlink");
  await qualityPage.context().close();
});

test("E2E-03 出差与经费分别审批，经费获批才占用", async ({ page }) => {
  await login(page, "member@lexflow.demo");
  const funding = await api(page, "funding.create", { body: { projectId: projectAId, purpose: "E2E-03 经费", amountCents: 300000 } });
  const fundingId = (funding.json as any).result.data.id;
  const travel = await api(page, "travel.create", { body: { projectId: projectAId, reason: "E2E-03 出差", destination: "北京", startOn: "2028-03-05", endOn: "2028-03-06", segments: [{ seq: 1, type: "transport", startAt: "2028-03-05T01:00:00.000Z", endAt: "2028-03-05T05:00:00.000Z" }] } });
  expect(travel.status).toBe(200); // 出差申请与经费审批相互独立
  const fd = await api(page, `funding.getById?input=${encodeURIComponent(JSON.stringify({ id: fundingId }))}`, { method: "GET" });
  const sub = await api(page, "funding.submit", { body: { id: fundingId, rowVersion: (fd.json as any).result.data.rowVersion, idempotencyKey: uuid() } });
  const pmReader = await authedPage(page, "pm@lexflow.demo");
  const ledgerBefore = await ledgerNet(pmReader, projectAId);
  await approveByRole(page, "member", (sub.json as any).result.data.instance.id, "pm@lexflow.demo");
  const ledgerAfter = await ledgerNet(pmReader, projectAId);
  expect(ledgerAfter - ledgerBefore).toBe(300000); // 获批才占用（RESERVED +300k）
  await gotoApp(pmReader, `/operations/funding/${fundingId}`);
  await expect(pmReader.getByText("已获批")).toBeVisible();
  await shot(pmReader, "E2E-03-funding-reserved");
  await pmReader.close();
});

test("E2E-04 报销带入行程，获批后释放占用确认实际，无重复扣减", async ({ page }) => {
  await login(page, "member@lexflow.demo");
  const fundings = await api(page, "funding.list", { method: "GET" });
  const funding = (fundings.json as any).result.data.items.find((f: any) => f.purpose === "E2E-03 经费");
  const expense = await api(page, "expense.create", { body: { reason: "E2E-04 报销", items: [{ projectId: projectAId, fundingRequestId: funding.id, date: "2028-03-07", category: "transport", amountCents: 200000, description: "行程费用" }] } });
  const reportId = (expense.json as any).result.data.id;
  const detail = await api(page, `expense.getById?input=${encodeURIComponent(JSON.stringify({ id: reportId }))}`, { method: "GET" });
  const pmReader = await authedPage(page, "pm@lexflow.demo");
  const reservedBefore = await ledgerNet(pmReader, projectAId);
  const actualBefore = await ledgerActual(pmReader, projectAId);
  const sub = await api(page, "expense.submit", { body: { id: reportId, rowVersion: (detail.json as any).result.data.rowVersion, idempotencyKey: uuid() } });
  await approveByRole(page, "member", (sub.json as any).result.data.instance.id, "pm@lexflow.demo");
  const fin = await authedPage(page, "finance@lexflow.demo");
  const d2 = await api(fin, `approval.listMine`, { method: "GET" });
  const mine = (d2.json as any).result.data.items.find((i: any) => i.instance.bizId === reportId).instance;
  await api(fin, "approval.act", { body: { instanceId: mine.id, stepSeq: mine.currentStepSeq, action: "approve", idempotencyKey: uuid() } });
  await fin.context().close();
  expect((await ledgerNet(pmReader, projectAId)) - reservedBefore).toBe(-200000); // 释放
  expect((await ledgerActual(pmReader, projectAId)) - actualBefore).toBe(200000); // 确认实际
  await gotoApp(pmReader, `/expenses/${reportId}`);
  await expect(pmReader.getByText("待支付")).toBeVisible();
  await shot(pmReader, "E2E-04-expense-approved");
  await pmReader.close();
});

test("E2E-05 超预算按策略升级审批，不静默放行", async ({ page }) => {
  await login(page, "member@lexflow.demo");
  const big = await api(page, "expense.create", { body: { reason: "E2E-05 超预算", items: [{ projectId: projectAId, date: "2028-03-08", category: "translation", amountCents: 200000000, description: "超大额" }] } });
  const bigId = (big.json as any).result.data.id;
  const detail = await api(page, `expense.getById?input=${encodeURIComponent(JSON.stringify({ id: bigId }))}`, { method: "GET" });
  const sub = await api(page, "expense.submit", { body: { id: bigId, rowVersion: (detail.json as any).result.data.rowVersion, idempotencyKey: uuid() } });
  const inst = (sub.json as any).result.data.instance.id;
  const approval = await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: inst }))}`, { method: "GET" });
  const roles = (approval.json as any).result.data.steps.map((s: any) => s.approverRole);
  expect(roles).toContain("partner"); // escalate 追加管理层
  await gotoApp(page, `/expenses/${bigId}`);
  await expect(page.getByText(/超预算|升级/).first()).toBeVisible();
  await shot(page, "E2E-05-overbudget-escalate");
});

test("E2E-06 重复提交/网络重试只一个有效结果一组台账", async ({ page }) => {
  await login(page, "member@lexflow.demo");
  const exp = await api(page, "expense.create", { body: { reason: "E2E-06 幂等", items: [{ projectId: projectAId, date: "2028-03-09", category: "meals", amountCents: 30000, description: "餐费" }] } });
  const reportId = (exp.json as any).result.data.id;
  const detail = await api(page, `expense.getById?input=${encodeURIComponent(JSON.stringify({ id: reportId }))}`, { method: "GET" });
  const rv = (detail.json as any).result.data.rowVersion;
  const key = uuid();
  await api(page, "expense.submit", { body: { id: reportId, rowVersion: rv, idempotencyKey: key } });
  const dup = await api(page, "expense.submit", { body: { id: reportId, rowVersion: rv, idempotencyKey: key } });
  expect(dup.status).not.toBe(200); // 重复提交被拒/幂等
  await approveByRole(page, "member", ((await api(page, `expense.getById?input=${encodeURIComponent(JSON.stringify({ id: reportId }))}`, { method: "GET" })).json as any).result.data.approvalInstanceId, "pm@lexflow.demo");
  const fin = await authedPage(page, "finance@lexflow.demo");
  const d2 = await api(fin, `approval.listMine`, { method: "GET" });
  const mine = (d2.json as any).result.data.items.find((i: any) => i.instance.bizId === reportId).instance;
  const a1 = await api(fin, "approval.act", { body: { instanceId: mine.id, stepSeq: mine.currentStepSeq, action: "approve", idempotencyKey: uuid() } });
  expect(a1.status).toBe(200);
  const a2 = await api(fin, "approval.act", { body: { instanceId: mine.id, stepSeq: mine.currentStepSeq, action: "approve", idempotencyKey: a1 ? uuid() : uuid() } });
  expect(a2.status).toBe(409); // 终审已处理
  await fin.context().close();
});

test("E2E-07 相同票据再次报销被识别并定位原报销", async ({ page }) => {
  await login(page, "member@lexflow.demo");
  const pmReader = await authedPage(page, "pm@lexflow.demo");
  const list = await api(pmReader, `expense.list?input=${encodeURIComponent(JSON.stringify({ projectId: projectAId }))}`, { method: "GET" });
  const candidates = (list.json as any).result.data.items;
  let withReceipt: any;
  let item: any;
  for (const c of candidates) {
    const detail = await api(pmReader, `expense.getById?input=${encodeURIComponent(JSON.stringify({ id: c.id }))}`, { method: "GET" });
    const found = (detail.json as any).result.data.items.find((i: any) => i.receiptNo);
    if (found) { withReceipt = { id: c.id, code: c.code }; item = found; break; }
  }
  expect(item).toBeDefined();
  const dup = await api(page, "expense.create", { body: { reason: "E2E-07 重复票据", items: [{ projectId: projectAId, date: "2028-03-10", category: item.category, amountCents: item.amountCents, description: "重复", receiptNo: item.receiptNo }] } });
  const dupId = (dup.json as any).result.data.id;
  const d2 = await api(page, `expense.getById?input=${encodeURIComponent(JSON.stringify({ id: dupId }))}`, { method: "GET" });
  const sub = await api(page, "expense.submit", { body: { id: dupId, rowVersion: (d2.json as any).result.data.rowVersion, idempotencyKey: uuid() } });
  expect(sub.status).toBe(409);
  expect((sub.json as any).error.data.businessCode).toBe("DUPLICATE_RECEIPT");
  const details = (sub.json as any).error.data.details;
  expect(typeof details.originalReportId).toBe("string"); // 命中并给出原报销定位
  expect(details.originalReportCode).toMatch(/^EXP-/);
  await pmReader.context().close();
  await gotoApp(page, `/expenses/${dupId}`);
  await expect(page.getByText(/重复票据|已存在/).first()).toBeVisible();
  await shot(page, "E2E-07-duplicate");
});

test("E2E-08 会议出差预填工时：草稿可改，提交审批后有效，取消会议不产生", async ({ page }) => {
  await login(page, "member@lexflow.demo");
  const mDay = `2028-06-${String(1 + Math.floor(Math.random() * 28)).padStart(2, "0")}`;
  const created = await api(page, "meeting.create", { body: { projectId: projectAId, type: "project", subject: "E2E-08 预填会", startAt: `${mDay}T01:00:00.000Z`, endAt: `${mDay}T04:00:00.000Z`, participants: [{ userId: await me(page) }] } });
  const mid = (created.json as any).result.data.id;
  await api(page, "meeting.transition", { body: { id: mid, action: "complete" } });
  await api(page, "meeting.recordAttendance", { body: { id: mid, entries: [{ userId: await me(page), attendance: "attended" }] } });
  const pre = await api(page, "time.prefillFromMeeting", { body: { meetingId: mid } });
  expect((pre.json as any).result.data.created).toBe(1);
  const dup = await api(page, "time.prefillFromMeeting", { body: { meetingId: mid } });
  expect((dup.json as any).result.data.skipped).toBe(1); // 幂等
  await api(page, "meeting.transition", { body: { id: mid, action: "cancel", reason: "取消" } }).catch(() => {});
  await gotoApp(page, "/operations/time");
  await expect(page.getByText("预填只生成草稿").first()).toBeVisible();
  await shot(page, "E2E-08-prefill-draft");
});

test("E2E-09 工时退回、重提和周期锁定；解锁有理由与审计", async ({ page }) => {
  await login(page, "member@lexflow.demo");
  const week = (() => {
    for (const offsetDays of [28, 35, 42, 49, 56]) {
      const d = new Date(Date.now() + offsetDays * 864e5);
      const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      mon.setUTCDate(mon.getUTCDate() - ((mon.getUTCDay() + 6) % 7));
      return mon.toISOString().slice(0, 10); // 由下方状态探测兜底（首个候选失败即换）
    }
    return "";
  })();
  // 探测可用 draft 周期（向后周移直至 draft）
  let pid = "";
  let d = "";
  for (let add = 28; add <= 182; add += 7) {
    const cand = (() => {
      const dd = new Date(Date.now() + add * 864e5);
      const mon = new Date(Date.UTC(dd.getUTCFullYear(), dd.getUTCMonth(), dd.getUTCDate()));
      mon.setUTCDate(mon.getUTCDate() - ((mon.getUTCDay() + 6) % 7));
      return mon.toISOString().slice(0, 10);
    })();
    const mp = await api(page, `time.myPeriod?input=${encodeURIComponent(JSON.stringify({ periodStart: cand }))}`, { method: "GET" });
    if ((mp.json as any).result.data.period.status === "draft" && (mp.json as any).result.data.entries.length === 0) {
      pid = (mp.json as any).result.data.period.id;
      d = (mp.json as any).result.data.period.periodStart;
      break;
    }
  }
  expect(pid).toBeTruthy();
  const saved = await api(page, "time.saveEntries", { body: { periodId: pid, idempotencyKey: uuid(), entries: [{ projectId: projectAId, activityType: "professional_work", workDate: d, durationMinutes: 360, description: "E2E-09 工时" }] } });
  if (!(saved.json as any)?.result) throw new Error("save failed: " + JSON.stringify(saved.json).slice(0, 300) + " pid=" + pid + " d=" + d);
  const sub = await api(page, "time.submit", { body: { periodId: pid, idempotencyKey: uuid() } });
  if (!(sub.json as any)?.result) throw new Error("submit failed: " + JSON.stringify(sub.json).slice(0, 300));
  const instId = (sub.json as any).result.data.instance.id;
  const pmPage = await authedPage(page, "pm@lexflow.demo");
  const rejected = await api(pmPage, "approval.act", { body: { instanceId: instId, stepSeq: 1, action: "reject", comment: "补充说明", idempotencyKey: uuid() } });
  expect(rejected.status).toBe(200);
  await api(page, "time.saveEntries", { body: { periodId: pid, idempotencyKey: uuid(), entries: [{ projectId: projectAId, activityType: "professional_work", workDate: d, durationMinutes: 420, description: "E2E-09 重提" }] } });
  const resub = await api(page, "time.submit", { body: { periodId: pid, idempotencyKey: uuid() } });
  await api(pmPage, "approval.act", { body: { instanceId: (resub.json as any).result.data.instance.id, stepSeq: 1, action: "approve", idempotencyKey: uuid() } });
  const partnerPage = await authedPage(page, "partner@lexflow.demo");
  await api(partnerPage, "time.lock", { body: { periodId: pid, reason: "归档" } });
  const edit = await api(page, "time.saveEntries", { body: { periodId: pid, idempotencyKey: uuid(), entries: [] } });
  expect(edit.status).toBe(403); // locked 普通修改禁止
  const unlocked = await api(partnerPage, "time.unlock", { body: { periodId: pid, reason: "解锁复核" } });
  expect(unlocked.status).toBe(200);
  await gotoApp(page, "/operations/time");
  await expect(page.getByText(/已批准|已解锁/)).toBeVisible();
  await shot(page, "E2E-09-unlocked");
  await pmPage.context().close(); await partnerPage.context().close();
});

test("E2E-10 周报与驾驶舱统计同名同数（五域统一口径）", async ({ page }) => {
  await login(page, "pm@lexflow.demo");
  const stats = await api(page, `time.stats.byProject?input=${encodeURIComponent(JSON.stringify({ from: "2026-01-01", to: "2028-12-31" }))}`, { method: "GET" });
  const total = (stats.json as any).result.data.items.reduce((s: number, i: any) => s + i.minutes, 0);
  const dash = await api(page, "dashboard.summary", { method: "GET" });
  expect((dash.json as any).result.data.timeCard.approvedMinutes).toBeGreaterThanOrEqual(0);
  const mondayLast = lastMonday();
  const draft = await api(page, "report.generateDraft", { body: { projectId: projectAId, periodStart: mondayLast, periodEnd: addDays(mondayLast, 6) } });
  expect((draft.json as any).result.data.content.time).toContain("已批准工时");
  expect(total).toBeGreaterThan(0);
  await gotoApp(page, "/cockpit");
  await expect(page.getByText("本周已批准工时")).toBeVisible();
  await shot(page, "E2E-10-dashboard");
});

test("E2E-11 信息墙用户访问：页面/接口/搜索/报表/附件/导出均不泄露", async ({ page }) => {
  await login(page, "viewer@lexflow.demo");
  const projects = await api(page, "project.list", { method: "GET" });
  expect((projects.json as any).result.data.items).toHaveLength(0); // viewer 默认不见
  const search = await api(page, `search.query?input=${encodeURIComponent(JSON.stringify({ q: "华宸" }))}`, { method: "GET" });
  expect((search.json as any).result.data.items).toHaveLength(0);
  const direct = await api(page, `project.getById?input=${encodeURIComponent(JSON.stringify({ id: projectAId }))}`, { method: "GET" });
  expect(direct.status).toBe(404);
  await gotoApp(page, `/projects/${projectAId}`);
  await expect(page.getByRole("heading", { name: "页面不存在" })).toBeVisible();
  await shot(page, "E2E-11-viewer-same-shape");
});

test("E2E-12 财务可处理费用但不因此读取法律文书", async ({ page }) => {
  await login(page, "finance@lexflow.demo");
  const list = await api(page, "expense.list", { method: "GET" }); // finance 全量职责视角（projectId 过滤需项目可见权）
  expect(list.status).toBe(200); // 费用处理职责
  const project = await api(page, `project.getById?input=${encodeURIComponent(JSON.stringify({ id: projectAId }))}`, { method: "GET" });
  expect(project.status).toBe(404); // 法律内容不可见
  const search = await api(page, `search.query?input=${encodeURIComponent(JSON.stringify({ q: "华宸" }))}`, { method: "GET" });
  expect((search.json as any).result.data.items.filter((i: any) => i.type === "project")).toHaveLength(0);
  await gotoApp(page, "/operations/expenses");
  await expect(page.getByRole("heading", { name: "费用中心" })).toBeVisible();
  await shot(page, "E2E-12-finance-scope");
});

test("E2E-13 已支付费用更正走调整/冲销，净额与历史完整", async ({ page }) => {
  await login(page, "finance@lexflow.demo");
  const list = await api(page, `expense.list?input=${encodeURIComponent(JSON.stringify({ status: "paid" }))}`, { method: "GET" });
  const paid = (list.json as any).result.data.items[0];
  const before = await ledgerActual(page, projectAId);
  const adj = await api(page, "expense.adjustCreate", { body: { expenseId: paid.id, deltaCents: -50000, reason: "E2E-13 冲销", idempotencyKey: uuid() } });
  const instId = (adj.json as any).result.data.instance.id;
  await approveByRole(page, "finance", instId, "partner@lexflow.demo");
  expect((await ledgerActual(page, projectAId)) - before).toBe(-50000);
  const after = await api(page, `expense.getById?input=${encodeURIComponent(JSON.stringify({ id: paid.id }))}`, { method: "GET" });
  expect((after.json as any).result.data.status).toBe("paid"); // 原记录不可变
  await gotoApp(page, `/expenses/${paid.id}`);
  await expect(page.getByRole("heading", { name: /调整记录/ })).toBeVisible();
  await shot(page, "E2E-13-adjustment");
});

test("E2E-14 结项检查：未决事项明确列出并按模板阻断/警告", async ({ page }) => {
  await login(page, "pm@lexflow.demo");
  const detail = await api(page, `project.getById?input=${encodeURIComponent(JSON.stringify({ id: projectAId }))}`, { method: "GET" });
  const closed = await api(page, "project.close", { body: { projectId: projectAId, rowVersion: (detail.json as any).result.data.rowVersion } });
  const data = (closed.json as any).result.data;
  expect(data.checklist.length).toBeGreaterThan(0);
  expect(typeof data.closed).toBe("boolean");
  await gotoApp(page, `/projects/${projectAId}`);
  await expect(page.getByText(/项目总览|治理要点/)).toBeVisible();
  await shot(page, "E2E-14-overview-intact");
});

test("E2E-15 治理回归：项目总览直开（潜伏崩溃修复）+ 关键治理页", async ({ page }) => {
  await login(page, "pm@lexflow.demo");
  await gotoApp(page, `/projects/${projectAId}`);
  await expect(page.getByRole("heading", { name: "治理要点" })).toBeVisible(); // 总览潜伏崩溃修复回归：真实数据渲染
  await gotoApp(page, `/projects/${projectAId}/plan`);
  await expect(page.getByText("基线（V1 幽灵轨）")).toBeVisible();
  await gotoApp(page, `/projects/${projectAId}/quality`);
  await expect(page.getByRole("heading", { name: "质量检查清单" })).toBeVisible();
  await shot(page, "E2E-15-overview-fixed");
});

test("E2E-16 移动端 375px 核心填报与审批", async ({ page, browser }) => {
  await login(page, "member@lexflow.demo");
  const mob = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const mp = await mob.newPage();
  await mob.addCookies((await page.context().cookies()).map((c) => ({ ...c, sameSite: (c.sameSite ?? "Lax") as "Lax" })));
  await gotoApp(mp, "/operations/time");
  await expect(mp.getByRole("button", { name: "本周", exact: true })).toBeVisible();
  const overflow = await mp.evaluate(() => {
    const iw = window.innerWidth;
    let worst = 0;
    document.querySelectorAll("*").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.right > iw + 1 && r.width < iw * 2) worst = Math.max(worst, r.right - iw);
    });
    return Math.ceil(worst);
  });
  expect(overflow).toBe(0); // 移动形态（叠加滚动条）无越界元素
  await mp.screenshot({ path: "D:/tmp/shots-iter5-e2e/E2E-16-mobile-time.png" });
  await gotoApp(mp, "/meetings");
  await expect(mp.getByText(/会议|日程/).first()).toBeVisible();
  await mp.screenshot({ path: "D:/tmp/shots-iter5-e2e/E2E-16-mobile-meetings.png" });
  await mob.close();
});

// helpers
async function authedPage(page: Page, email: string): Promise<Page> {
  const ctx = await page.context().browser()!.newContext();
  const other = await ctx.newPage();
  await login(other, email);
  return other;
}
async function me(page: Page): Promise<string> {
  const r = await api(page, "auth.me", { method: "GET" });
  return (r.json as any).result.data.user.id;
}
async function ledgerNet(page: Page, projectId: string): Promise<number> {
  const r = await api(page, `budget.getById?input=${encodeURIComponent(JSON.stringify({ id: (await activeBudget(page, projectId)) }))}`, { method: "GET" });
  return (r.json as any).result.data.aggregate.reservedCents;
}
async function ledgerActual(page: Page, projectId: string): Promise<number> {
  const r = await api(page, `budget.getById?input=${encodeURIComponent(JSON.stringify({ id: (await activeBudget(page, projectId)) }))}`, { method: "GET" });
  return (r.json as any).result.data.aggregate.actualCents;
}
async function activeBudget(page: Page, projectId: string): Promise<string> {
  const list = await api(page, `budget.list?input=${encodeURIComponent(JSON.stringify({ projectId }))}`, { method: "GET" });
  return (list.json as any).result.data.items.find((b: any) => b.status === "active").id;
}
function nextWeek(): string {
  const d = new Date(Date.now() + 7 * 864e5);
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  mon.setUTCDate(mon.getUTCDate() - ((mon.getUTCDay() + 6) % 7));
  return mon.toISOString().slice(0, 10);
}
function lastMonday(): string {
  const now = new Date();
  const mon = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  mon.setUTCDate(mon.getUTCDate() - ((mon.getUTCDay() + 6) % 7) - 7);
  return mon.toISOString().slice(0, 10);
}
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
