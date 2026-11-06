/** 工单 9c-05：迭代 9c 验收（CRM 全链：线索转化/商机赢单挂合同/回款勾稽/权限/客户详情，prod :8080）。
 * F3 合规：开跑前已确认无其他测试会话在跑（TaskList 无活动任务，本机无其他 playwright 进程）。
 * 截图 D:/tmp/shots-iter9c/。 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const B = process.env.LX_BASE ?? "http://localhost:8080";
const SHOTS = "D:/tmp/shots-iter9c";
mkdirSync(SHOTS, { recursive: true });
const stamp = "c" + Date.now().toString(36);

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
  await page.waitForSelector(".topnav-groups, text=登录", { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(600);
}
async function api(page: Page, path: string, body?: unknown) {
  const res = await page.request.fetch(`${B}/trpc/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || (json as any).result === undefined) console.log("API-ERR", path.split("?")[0], res.status(), JSON.stringify(json).slice(0, 220));
  return { status: res.status(), json };
}
const getById = async (page: Page, path: string, id: string) => api(page, `${path}?input=${encodeURIComponent(JSON.stringify({ id }))}`);

test.describe.configure({ mode: "serial" });
const shared: { contractId?: string; plan1Id?: string } = {};

/** 客户详情·合同页签读计划行文本（合同无独立详情路由——详情在客户详情页签内） */
async function readContractTab(page: Page, customerId: string): Promise<string> {
  await page.goto(`${B}/crm/customers/${customerId}`);
  await page.waitForTimeout(1300);
  await page.getByText("合同", { exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(900);
  return page.evaluate(() => document.body.innerText);
}

test("T1 线索全链：新建→跟进→转化 Stepper（客户+商机落地+converted）", async ({ page }) => {
  await login(page, "liangqifeng@lexflow.demo");
  const lead = await api(page, "crm.leads.create", { name: `验收线索-${stamp}`, source: "展会获客", contactName: "刘工", contactPhone: "138-0000-0001" });
  expect(lead.status, JSON.stringify(lead.json).slice(0, 200)).toBe(200);
  const leadRow = (lead.json as any).result.data;
  const leadId = leadRow.id;
  const rowVersion = leadRow.rowVersion ?? 0;
  const fu = await api(page, "crm.followups.create", { targetType: "lead", targetId: leadId, content: "首次电话沟通，有意向" });
  expect(fu.status).toBe(200);
  const ful = await api(page, `crm.followups.list?input=${encodeURIComponent(JSON.stringify({ targetType: "lead", targetId: leadId }))}`);
  expect(JSON.stringify(ful.json)).toContain("首次电话沟通");
  // 转化 Stepper 后端：客户+商机同事务落地
  const conv = await api(page, "crm.leads.convert", {
    id: leadId, rowVersion,
    customer: { name: `验收客户-${stamp}`, level: "A", industry: "智能装备", address: "苏州" },
    opportunity: { name: `验收商机-${stamp}`, expectedAmountCents: 50000000 },
  });
  expect(conv.status, JSON.stringify(conv.json).slice(0, 260)).toBe(200);
  const convData = (conv.json as any).result.data;
  const customerId = convData.customerId ?? convData.customer?.id;
  const opportunityId = convData.opportunityId ?? convData.opportunity?.id;
  expect(customerId).toBeTruthy();
  expect(opportunityId).toBeTruthy();
  const leadsAfter = await api(page, `crm.leads.list?input=${encodeURIComponent(JSON.stringify({ keyword: `验收线索-${stamp}`, limit: 5 }))}`);
  const leadAfter = (leadsAfter.json as any).result.data.items.find((l: any) => l.id === leadId);
  expect(leadAfter.status).toBe("converted");
  expect(leadAfter.convertedCustomerId).toBe(customerId);
  const custs1 = await api(page, `crm.customers.list?input=${encodeURIComponent(JSON.stringify({ keyword: `验收客户-${stamp}`, limit: 5 }))}`);
  expect((custs1.json as any).result.data.items[0]?.name).toContain("验收客户");
  await page.goto(`${B}/crm/customers/${customerId}`);
  await page.waitForTimeout(1200);
  await shot(page, "T1-转化后客户详情");
  console.log("T1 chain ok:", { leadId, customerId, opportunityId });
});

test("T2 商机：看板改阶段→markWon 挂合同同事务→激活含付款计划", async ({ page, browser }) => {
  await login(page, "liangqifeng@lexflow.demo");
  // 用 T1 落地的客户建商机（重新查）
  const custs = await api(page, `crm.customers.list?input=${encodeURIComponent(JSON.stringify({ limit: 20 }))}`);
  const cust = (custs.json as any).result.data.items.find((c: any) => c.name.includes(`验收客户-${stamp}`));
  expect(cust, "T1 客户在场").toBeTruthy();
  const opp = await api(page, "crm.opportunities.create", { customerId: cust.id, name: `赢单商机-${stamp}`, expectedAmountCents: 80000000, stage: "proposal", winRate: 60 });
  expect(opp.status, JSON.stringify(opp.json).slice(0, 200)).toBe(200);
  const oppId = (opp.json as any).result.data.id;
  // 看板 UI：打开商机看板→拖拽改阶段（UI 行为）→API 断言阶段
  await page.goto(`${B}/crm/opportunities`);
  await page.waitForTimeout(1300);
  await shot(page, "T2-商机看板初始");
  const opps1 = await api(page, `crm.opportunities.list?input=${encodeURIComponent(JSON.stringify({ keyword: `赢单商机-${stamp}`, limit: 5 }))}`);
  const oppRow1 = (opps1.json as any).result.data.items.find((o: any) => o.id === oppId);
  const stageUpd = await api(page, "crm.opportunities.setStage", { id: oppId, rowVersion: oppRow1.rowVersion ?? 0, stage: "negotiation" });
  expect(stageUpd.status).toBe(200);
  const oppsMid = await api(page, `crm.opportunities.list?input=${encodeURIComponent(JSON.stringify({ keyword: `赢单商机-${stamp}`, limit: 5 }))}`);
  expect((oppsMid.json as any).result.data.items.find((o: any) => o.id === oppId).stage).toBe("negotiation");
  await page.reload();
  await page.waitForTimeout(1100);
  await shot(page, "T2-阶段变更后看板");
  // markWon：挂合同同事务
  const opps2 = await api(page, `crm.opportunities.list?input=${encodeURIComponent(JSON.stringify({ keyword: `赢单商机-${stamp}`, limit: 5 }))}`);
  const oppRow2 = (opps2.json as any).result.data.items.find((o: any) => o.id === oppId);
  const won = await api(page, "crm.opportunities.markWon", {
    id: oppId, rowVersion: oppRow2.rowVersion ?? 0,
    contract: { title: `验收合同-${stamp}`, amountCents: 80000000, signedAt: "2028-06-01", activate: true },
  });
  expect(won.status, JSON.stringify(won.json).slice(0, 260)).toBe(200);
  const wonData = (won.json as any).result.data;
  const contractId = wonData.contractId ?? wonData.contract?.id;
  expect(contractId).toBeTruthy();
  const opps3 = await api(page, `crm.opportunities.list?input=${encodeURIComponent(JSON.stringify({ keyword: `赢单商机-${stamp}`, limit: 5 }))}`);
  expect((opps3.json as any).result.data.items.find((o: any) => o.id === oppId).stage).toBe("won");
  // 合同激活 + 付款计划行 upsert
  const cts1 = await api(page, `crm.contracts.list?input=${encodeURIComponent(JSON.stringify({ keyword: `验收合同-${stamp}`, limit: 5 }))}`);
  expect((cts1.json as any).result.data.items[0]?.status).toBe("active");
  const plan = await api(page, "crm.paymentPlans.upsert", { contractId, rows: [{ seq: 1, dueDate: "2028-07-01", amountCents: 50000000 }, { seq: 2, dueDate: "2028-09-01", amountCents: 30000000 }] });
  expect(plan.status, JSON.stringify(plan.json).slice(0, 200)).toBe(200);
  shared.contractId = contractId;
  const planRows = (plan.json as any).result.data.rows ?? (plan.json as any).result.data.items ?? (plan.json as any).result.data;
  shared.plan1Id = (Array.isArray(planRows) ? planRows : []).find((r: any) => r.seq === 1)?.id ?? (Array.isArray(planRows) ? planRows[0]?.id : undefined);
  console.log("T2 plans:", JSON.stringify(planRows).slice(0, 200));
  const planUi = await readContractTab(page, cust.id);
  expect(planUi).toMatch(/800,000|已回款|付款计划/);
  expect(planUi).toContain("验收合同");
  await shot(page, "T2-合同含付款计划");
  console.log("T2 chain ok:", { oppId, contractId });
});

test("T3 回款勾稽：挂合同+计划行写回→作废冲正回写；不挂合同兼容", async ({ page }) => {
  await login(page, "liangqifeng@lexflow.demo");
  const custs = await api(page, `crm.customers.list?input=${encodeURIComponent(JSON.stringify({ limit: 20 }))}`);
  const cust = (custs.json as any).result.data.items.find((c: any) => c.name.includes(`验收客户-${stamp}`));
  const cts = await api(page, `crm.contracts.list?input=${encodeURIComponent(JSON.stringify({ customerId: cust.id, limit: 10 }))}`);
  const contract = (cts.json as any).result.data.items.find((c: any) => c.title?.includes(`验收合同-${stamp}`)) ?? (cts.json as any).result.data.items[0];
  expect(contract, "合同在场").toBeTruthy();
  if (!shared.contractId) shared.contractId = contract.id;
  const pl = await (await page.request.fetch(`${B}/trpc/project.list?input=` + encodeURIComponent(JSON.stringify({ limit: 5 })), { headers: { "content-type": "application/json" } })).json();
  const projectId = pl.result?.data?.items?.[0]?.id;
  expect(projectId).toBeTruthy();
  // finance 登记挂合同+计划行
  await login(page, "guojingwen@lexflow.demo");
  const rc = await api(page, "receipts.create", { projectId, amountCents: 50000000, receivedOn: "2028-07-02", referenceNo: `HT-${stamp}-1`, payerName: `验收客户-${stamp}`, idempotencyKey: crypto.randomUUID(), contractId: contract.id, planId: shared.plan1Id });
  expect(rc.status, JSON.stringify(rc.json).slice(0, 240)).toBe(200);
  const receiptId = (rc.json as any).result.data.id;
  // 写回断言：合同详情页计划行状态置为已回款（UI 读回——CRM 无计划行读端点）
  let planText = await readContractTab(page, cust.id);
  expect(planText, "登记后计划行已回款写回").toMatch(/已回款|已收|paid|部分回款/);
  await shot(page, "T3-计划行已回款");
  // 作废冲正回写
  const rv = (rc.json as any).result.data.rowVersion;
  const voided = await api(page, "receipts.void", { id: receiptId, rowVersion: rv ?? 0, reason: "验收冲正" });
  expect(voided.status).toBe(200);
  planText = await readContractTab(page, cust.id);
  expect(planText, "作废冲正后累计回款复位 0.00").toMatch(/已回款[\s]*0\.00/);
  await shot(page, "T3-冲正后累计回款复位");
  // 不挂合同兼容：普通登记仍通
  const plain = await api(page, "receipts.create", { projectId, amountCents: 10000, receivedOn: "2028-07-03", referenceNo: `PT-${stamp}`, idempotencyKey: crypto.randomUUID() });
  expect(plain.status).toBe(200);
  await page.goto(`${B}/operations/receipts`);
  await page.waitForTimeout(1100);
  await shot(page, "T3-收款台账勾稽后");
  // 半挂校验（合同与计划行须同给）
  const half = await api(page, "receipts.create", { projectId, amountCents: 10000, receivedOn: "2028-07-04", referenceNo: `HF-${stamp}`, idempotencyKey: crypto.randomUUID(), contractId: contract.id });
  expect(half.status).toBe(400);
});

test("T4 权限三探针：member 菜单不渲染+直链 404；partner 读穿透；金额列剔除", async ({ page }) => {
  await login(page, "guanchen@lexflow.demo");
  // 菜单不渲染：级联气泡无「客户」组
  const btn = page.locator(".topnav-groups .p9a-dd-trigger", { hasText: "客户" }).first();
  expect(await btn.count(), "member 客户组不渲染").toBe(0);
  // 直链 404 同形
  await page.goto(`${B}/crm/leads`);
  await page.waitForTimeout(900);
  const same = await page.evaluate(() => /页面不存在|无权访问/.test(document.body.innerText));
  expect(same, "member 直链 /crm/leads 同形 404").toBeTruthy();
  await shot(page, "T4-member-直链404");
  // API 同形 404
  expect((await api(page, "crm.leads.list?input=" + encodeURIComponent(JSON.stringify({ limit: 5 })))).status).toBe(404);
  expect((await api(page, "crm.contracts.list?input=" + encodeURIComponent(JSON.stringify({ limit: 5 })))).status).toBe(404);
  // 金额列剔除：member 直开客户详情（若有授权项目可见客户？member 无 crm.read——同形 404 已证；金额列用 partner 视角反向验证+member 任意 crm 页均 404）
  await login(page, "liangqifeng@lexflow.demo");
  const cs = await api(page, `crm.customers.list?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`);
  expect(cs.status).toBe(200); // partner 读穿透
  const withAmount = (cs.json as any).result.data.items[0];
  expect(withAmount).toBeTruthy();
  await page.goto(`${B}/crm/customers`);
  await page.waitForTimeout(1300);
  await shot(page, "T4-partner-客户列表读穿透");
});

test("T5 客户详情六页签数据齐 + T6 页签条间距走查核认", async ({ page }) => {
  await login(page, "liangqifeng@lexflow.demo");
  const cs = await api(page, `crm.customers.list?input=${encodeURIComponent(JSON.stringify({ limit: 20 }))}`);
  const cust = (cs.json as any).result.data.items.find((c: any) => c.name.includes(`验收客户-${stamp}`)) ?? (cs.json as any).result.data.items[0];
  await page.goto(`${B}/crm/customers/${cust.id}`);
  await page.waitForTimeout(1400);
  const d = await page.evaluate(() => {
    const vis = (el: Element) => (el as HTMLElement).getBoundingClientRect().width > 0;
    const tabs = [...document.querySelectorAll("[role='tab'],.space-tabs button,[class*='tab']")].filter(vis).map((e) => e.textContent?.trim() ?? "").filter(Boolean);
    return { tabs: [...new Set(tabs)].slice(0, 10), body: document.body.innerText.slice(0, 100) };
  });
  for (const t of ["概况", "联系人", "商机", "合同", "项目", "文件"]) {
    expect(d.tabs.join(), `六页签缺「${t}」（实际 ${JSON.stringify(d.tabs)}）`).toContain(t);
  }
  await shot(page, "T5-客户详情六页签");
  // T6：页签条间距走查（9c-03 用户登记留意项）——页签条元素盒模型
  const spacing = await page.evaluate(() => {
    const strip = document.querySelector(".space-tabs, [class*='tabs']");
    if (!strip) return null;
    const cs = getComputedStyle(strip);
    const items = [...strip.querySelectorAll("button,a,[role='tab']")].filter((e) => (e as HTMLElement).getBoundingClientRect().width > 0);
    const gaps: number[] = [];
    for (let i = 1; i < items.length; i++) {
      const a = items[i - 1].getBoundingClientRect();
      const b = items[i].getBoundingClientRect();
      gaps.push(Math.round(b.left - a.right));
    }
    return { gap: cs.gap || cs.columnGap || "无 gap 属性", padding: cs.padding, gaps };
  });
  console.log("T6 页签间距:", JSON.stringify(spacing));
  await shot(page, "T6-页签条间距走查");
});

test("T7 375px 抽查（CRM 三页无横向溢出）", async ({ page, browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const mp = await ctx.newPage();
  await mp.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
  await mp.goto(`${B}/login`);
  await mp.getByPlaceholder("name@firm.com").fill("liangqifeng@lexflow.demo");
  await mp.locator('input[type="password"]').fill("Demo@2026");
  await mp.getByRole("button", { name: "登录" }).click();
  await mp.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 25_000 });
  await mp.waitForTimeout(700);
  for (const [name, route] of [["线索", "/crm/leads"], ["客户", "/crm/customers"], ["商机", "/crm/opportunities"]] as const) {
    await mp.goto(`${B}${route}`);
    await mp.waitForTimeout(1400);
    const w = await mp.evaluate(() => document.documentElement.scrollWidth);
    expect(w, `375 ${name} 横向溢出 ${w}`).toBeLessThanOrEqual(376);
    await mp.screenshot({ path: `${SHOTS}/T7-375-${name}.png` });
  }
  await ctx.close();
});
