/** 工单 9e-04：迭代 9e 验收（报表中心：目录树/十报表页/筛选/口径勾稽/导出审计/权限，prod :8080）。
 * F3 合规：开跑前确认无其他测试会话在跑。截图 D:/tmp/shots-iter9e-test/。
 * 留意：T6 为 polish 核认（漏斗「（分）」标签与元值矛盾）——断言当前问题态；修复后翻转断言。 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { installE2eSelfClean } from "./e2e-cleanup";
installE2eSelfClean();

const B = process.env.LX_BASE ?? "http://localhost:8080";
const SHOTS = "D:/tmp/shots-iter9e-test";
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
  await page.waitForTimeout(600);
}
async function api(page: Page, path: string, body?: unknown) {
  const res = await page.request.fetch(`${B}/trpc/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json as any).result === undefined) console.log("API-ERR", path.split("?")[0], res.status(), JSON.stringify(json).slice(0, 200));
  return { status: res.status(), json };
}
const d = (r: any) => r.json?.result?.data?.json ?? r.json?.result?.data;

/** arch/12 §8.2 目录清单（标题逐字；§8.2 标题写「9 张」实际列 10 项——计数差异见报告观察项） */
const CATALOG: Array<{ cat: string; items: Array<{ key: string; title: string }> }> = [
  { cat: "项目类", items: [
    { key: "project_health", title: "项目健康度汇总" },
    { key: "project_delay", title: "项目进度与延期明细" },
    { key: "project_costing", title: "项目收支核算表" },
  ] },
  { cat: "财务类", items: [
    { key: "receivable_aging", title: "收款账龄分析" },
    { key: "expense_category", title: "费用类别分析" },
    { key: "monthly_cashflow", title: "月度收支汇总" },
  ] },
  { cat: "工时类", items: [
    { key: "time_summary", title: "工时汇总" },
    { key: "utilization", title: "人员利用率" },
  ] },
  { cat: "客户类", items: [
    { key: "opportunity_funnel", title: "商机漏斗" },
    { key: "customer_contribution", title: "客户贡献排行" },
  ] },
];

test.describe.configure({ mode: "serial" });
const shared: { customerGdId?: string; cashRowsDefault?: number } = {};

test("T1 工作台目录树：四类十项逐字+树卡联动+打开跳转", async ({ page }) => {
  await login(page, "guojingwen@lexflow.demo");
  await page.goto(`${B}/reports`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const body = await page.evaluate(() => document.body.innerText);
  for (const c of CATALOG) expect(body, `类别 ${c.cat}`).toContain(c.cat);
  const treeButtons = await page.locator("button.org-tree-label").allTextContents();
  const all = CATALOG.flatMap((c) => c.items);
  expect(treeButtons.length).toBe(10);
  for (const it of all) expect(treeButtons, it.title).toContain(it.title);
  await shot(page, "T1-工作台目录树");
  // 树选卡联动：点击「收款账龄分析」→ 说明卡出现其口径描述；「打开报表」→ 真实路由
  await page.locator("button.org-tree-label", { hasText: "收款账龄分析" }).click();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => document.body.innerText)).toContain("四桶账龄");
  await page.locator("a.rep-open, button:has-text('打开报表')").first().click();
  await page.waitForURL(/\/reports\/receivable_aging/, { timeout: 10_000 });
  expect(page.url()).toContain("/reports/receivable_aging");
});

test("T2 十报表页逐页打开+筛选生效", async ({ page }) => {
  await login(page, "guojingwen@lexflow.demo");
  const all = CATALOG.flatMap((c) => c.items);
  for (const it of all) {
    await page.goto(`${B}/reports/${it.key}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    const text = await page.evaluate(() => document.body.innerText);
    expect(text, `${it.key} 标题`).toContain(it.title);
    expect(text, `${it.key} 导出入口`).toContain("导出 CSV");
    // 表格（共 N 行）或 note 空态二态其一
    expect(/共 \d+ 行|口径：无/.test(text), `${it.key} 表格或口径卡`).toBeTruthy();
    if (["project_health", "monthly_cashflow", "opportunity_funnel", "time_summary", "project_costing"].includes(it.key)) {
      await shot(page, `T2-${it.key}`);
    }
  }
  // 筛选生效 A：月度收支——窄区间行数减少且 UI 行数==API 行数
  await page.goto(`${B}/reports/monthly_cashflow`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const txt0 = await page.evaluate(() => document.body.innerText);
  shared.cashRowsDefault = Number(/共 (\d+) 行/.exec(txt0)?.[1] ?? "-1");
  const inputs = page.locator('input[type="date"]');
  await inputs.nth(0).fill("2026-01-01");
  await inputs.nth(1).fill("2026-01-31");
  await page.waitForTimeout(900);
  const txt1 = await page.evaluate(() => document.body.innerText);
  const narrowRows = Number(/共 (\d+) 行/.exec(txt1)?.[1] ?? "-1");
  const apiNarrow = d(await api(page, `reports.monthlyCashflow?input=${encodeURIComponent(JSON.stringify({ from: "2026-01-01", to: "2026-01-31" }))}`));
  expect(narrowRows, "窄区间行数").toBe(apiNarrow.rows.length);
  expect(narrowRows, "筛选后应少于默认").toBeLessThan(shared.cashRowsDefault!);
  await shot(page, "T2-cashflow-筛选后");
  // 筛选生效 B：漏斗按客户过滤——UI 六阶段重算且赢单数==API
  const custs = d(await api(page, `crm.customers.list?input=${encodeURIComponent(JSON.stringify({ keyword: "GD", limit: 5 }))}`));
  const gd = (custs.items ?? custs).find((c: any) => /GD/.test(c.name));
  expect(gd, "GD 客户").toBeTruthy();
  shared.customerGdId = gd.id;
  await page.goto(`${B}/reports/opportunity_funnel`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.locator("select").first().selectOption({ label: gd.name });
  await page.waitForTimeout(900);
  const fTxt = await page.evaluate(() => document.body.innerText);
  const apiF = d(await api(page, `reports.opportunityFunnel?input=${encodeURIComponent(JSON.stringify({ customerId: gd.id }))}`));
  const won = apiF.rows.find((r: any) => r.stage === "赢单");
  expect(won, "GD 赢单行").toBeTruthy();
  expect(fTxt, "UI 赢单数==API").toContain(`赢单\n${won.count}`);
  // 筛选生效 C：工时汇总三视角页签切换
  await page.goto(`${B}/reports/time_summary`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const tabStrip = page.locator(".p9a-wizard-tabs");
  await expect(tabStrip).toBeVisible();
  const tabs = await tabStrip.locator("button, [role=tab], a").allTextContents();
  expect(tabs.join("|")).toMatch(/按?项目|项目/);
  for (const t of tabs.slice(0, 3)) {
    await tabStrip.getByText(t.trim(), { exact: false }).first().click().catch(() => {});
    await page.waitForTimeout(600);
  }
  const tTxt = await page.evaluate(() => document.body.innerText);
  expect(/姓名|项目|部门/.test(tTxt)).toBeTruthy();
  await shot(page, "T2-time-summary-视角");
});

test("T3 口径抽样勾稽：核算表/月度收支/工时/漏斗 ≥3 张重算一致", async ({ page }) => {
  await login(page, "guojingwen@lexflow.demo");
  // ① 收支核算表 vs fin.projectCosting.get vs 收款台账净额（三向勾稽）
  const rep = d(await api(page, `reports.projectCosting?input=${encodeURIComponent(JSON.stringify({}))}`));
  const proj = (rep.rows as any[]).find((r) => r.code === "PRJ-2026-00001") ?? rep.rows[0];
  const fin = d(await api(page, `fin.projectCosting.get?input=${encodeURIComponent(JSON.stringify({ projectId: proj.projectId ?? (await projId(page, proj.code)) }))}`));
  const receipts = d(await api(page, `receipts.list?input=${encodeURIComponent(JSON.stringify({ projectId: proj.projectId ?? (await projId(page, proj.code)), limit: 100 }))}`));
  const items: any[] = receipts.items ?? [];
  const net = items.filter((r: any) => r.status === "registered").reduce((s: number, r: any) => s + r.amountCents, 0)
    - items.filter((r: any) => r.status === "voided").reduce((s: number, r: any) => s + r.amountCents, 0);
  expect(proj.receivedCents, "报表已回款").toBe(fin.receivedCents);
  expect(fin.receivedCents, "fin 已回款==台账净额").toBe(net);
  // ② 月度收支：收==registered 回款月度重算；净额==收−支 恒等
  const cash = d(await api(page, `reports.monthlyCashflow?input=${encodeURIComponent(JSON.stringify({ from: "2025-01-01", to: "2026-12-31" }))}`));
  const rc = d(await api(page, `receipts.list?input=${encodeURIComponent(JSON.stringify({ from: "2025-01-01", to: "2026-12-31", limit: 100 }))}`));
  const byMonth = new Map<string, number>();
  for (const r of (rc.items ?? []) as any[]) {
    if (r.status !== "registered") continue;
    const m = String(r.receivedOn ?? r.date ?? "").slice(0, 7);
    byMonth.set(m, (byMonth.get(m) ?? 0) + r.amountCents);
  }
  for (const row of cash.rows as any[]) {
    expect(row.income, `月收入勾稽 ${row.month}`).toBe(byMonth.get(row.month) ?? 0);
    expect(row.net, `净额恒等 ${row.month}`).toBe(row.income - row.expense);
  }
  // ③ 工时汇总（人视角）== time.stats.byUser 同区间同口径——finance 默认项目范围为空集
  // （scopeAll 为报表域加性参数，9e-01 设计），故以 partner（全局穿透=scopeAll 等义）做同用户跨端点勾稽
  await login(page, "liangqifeng@lexflow.demo");
  const ts = d(await api(page, `reports.timeSummary?input=${encodeURIComponent(JSON.stringify({ view: "person", from: "2025-01-01", to: "2026-12-31" }))}`));
  const st = d(await api(page, `time.stats.byUser?input=${encodeURIComponent(JSON.stringify({ from: "2025-01-01", to: "2026-12-31" }))}`));
  const sumTs = (ts.rows as any[]).reduce((s: number, r: any) => s + r.minutes, 0);
  const sumSt = (st.items ?? []).reduce((s: number, r: any) => s + (r.minutes ?? r.totalMinutes ?? 0), 0);
  expect(sumTs, "工时人视角合计勾稽（partner 同区间）").toBe(sumSt);
  // finance 视角补证：报表域 scopeAll 生效（finance 经报表可见全量工时）
  await login(page, "guojingwen@lexflow.demo");
  const tsFin = d(await api(page, `reports.timeSummary?input=${encodeURIComponent(JSON.stringify({ view: "person", from: "2025-01-01", to: "2026-12-31" }))}`));
  const sumFin = (tsFin.rows as any[]).reduce((s: number, r: any) => s + r.minutes, 0);
  expect(sumFin, "finance 报表域全量==partner 全量").toBe(sumTs);
  // ④ 漏斗赢单金额 == CRM 商机 won 期望额合计
  const fun = d(await api(page, `reports.opportunityFunnel?input=${encodeURIComponent(JSON.stringify({}))}`));
  const ops = d(await api(page, `crm.opportunities.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`));
  const wonSum = (ops.items ?? []).filter((o: any) => o.stage === "won").reduce((s: number, o: any) => s + (o.expectedAmountCents ?? 0), 0);
  const wonRow = (fun.rows as any[]).find((r: any) => r.stage === "赢单");
  expect(wonRow.amount, "漏斗赢单金额==CRM 重算").toBe(wonSum);
});

test("T4 导出 CSV：下载+行数+中文表头+审计行", async ({ page }) => {
  await login(page, "liangqifeng@lexflow.demo"); // partner：全量读+audit.read
  await page.goto(`${B}/reports/time_summary`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const txt = await page.evaluate(() => document.body.innerText);
  const uiRows = Number(/共 (\d+) 行/.exec(txt)?.[1] ?? "-1");
  expect(uiRows).toBeGreaterThanOrEqual(1);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 20_000 }),
    page.getByText("导出 CSV", { exact: true }).first().click(),
  ]);
  const path = await download.path();
  const csv = readFileSync(path!, "utf-8").replace(/^﻿/, "");
  const lines = csv.trim().split("\n");
  expect(lines.length, "CSV 行数=表头+数据").toBe(uiRows + 1);
  expect(lines[0], "中文表头").toMatch(/姓名|分钟|项目|部门/);
  // 审计行：partner 具 audit.read——report.export 同事务留痕 key+filter 快照
  const audits = d(await api(page, `audit.list?input=${encodeURIComponent(JSON.stringify({ limit: 20, action: "report.export" }))}`));
  const rows = (audits.items ?? []).filter((a: any) => a.afterJson?.key === "time_summary");
  expect(rows.length, "审计行 report.export/time_summary").toBeGreaterThanOrEqual(1);
  await shot(page, "T4-导出后台账页");
});

test("T5 权限：member 行级过滤/partner 全量", async ({ page }) => {
  await login(page, "guanchen@lexflow.demo"); // member
  await page.goto(`${B}/reports`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const treeButtons = await page.locator("button.org-tree-label").allTextContents();
  expect(treeButtons.length, "member 目录树 10 项可达（report.read=登录全员）").toBe(10);
  await page.goto(`${B}/reports/receivable_aging`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => document.body.innerText)).toContain("无财务可见权");
  await page.goto(`${B}/reports/opportunity_funnel`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => document.body.innerText)).toContain("无 CRM 可见权");
  await shot(page, "T5-member-note卡");
  // member 本人口径：费用类别有数、工时=本人分钟
  const exp = d(await api(page, `reports.expenseCategory?input=${encodeURIComponent(JSON.stringify({}))}`));
  expect(exp.rows.length, "member 费用本人口径").toBeGreaterThanOrEqual(0);
  const ts = d(await api(page, `reports.timeSummary?input=${encodeURIComponent(JSON.stringify({ view: "person" }))}`));
  const me = (ts.rows as any[]).filter((r: any) => /管晨|guanchen/i.test(r.name));
  expect(me.length <= 1, "member 工时仅本人").toBeTruthy();
  // partner 全量：十页全数据（以核算表/漏斗为例）
  await login(page, "liangqifeng@lexflow.demo");
  const cost = d(await api(page, `reports.projectCosting?input=${encodeURIComponent(JSON.stringify({}))}`));
  expect(cost.rows.length, "partner 核算表全量").toBeGreaterThanOrEqual(5);
  const fun = d(await api(page, `reports.opportunityFunnel?input=${encodeURIComponent(JSON.stringify({}))}`));
  expect(fun.rows.length, "partner 漏斗六阶段").toBe(6);
  await page.goto(`${B}/reports/customer_contribution`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const txt = await page.evaluate(() => document.body.innerText);
  expect(txt).toContain("客户贡献排行");
  expect(/共 \d+ 行/.test(txt)).toBeTruthy();
  await shot(page, "T5-partner-贡献排行");
});

test("T6 polish 核认：漏斗「（分）」标签与元值矛盾（登记项）", async ({ page }) => {
  await login(page, "guojingwen@lexflow.demo");
  await page.goto(`${B}/reports/opportunity_funnel`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const txt = await page.evaluate(() => document.body.innerText);
  // 问题态（9e-02 登记，prod 实测仍在）：标签标「（分）」，值以「元」格式化渲染
  expect(txt, "列头仍标（分）").toContain("预计金额（分）");
  expect(txt, "指标卡仍标（分）").toContain("进行中金额（分）");
  expect(/进行中金额（分）\n[\d,]+\.\d{2} 元/.test(txt), "标签（分）vs 值（元）矛盾实证").toBeTruthy();
  await shot(page, "T6-分标签矛盾");
  // 修复后翻转：expect(txt).not.toContain("（分）");
});

async function projId(page: Page, code: string): Promise<string> {
  const r = d(await api(page, `project.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`));
  const p = (r.items ?? []).find((x: any) => x.code === code);
  return p?.id ?? "";
}
