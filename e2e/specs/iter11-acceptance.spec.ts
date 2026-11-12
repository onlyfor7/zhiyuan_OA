/** 工单 11-03：迭代 11 验收（arch/12 §16 三裁定：表格列对齐/审批卡业务详情+uuid 清剿/表单精细化 + uuid 零残留扫描）。
 * 取证：dev :3000（LX_BASE）。发布后 prod 复跑核心链同脚本切 :8080。
 * F3 合规：开跑前确认无其他测试会话在跑。截图 D:/tmp/shots-iter11-test/。 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { installE2eSelfClean } from "./e2e-cleanup";
installE2eSelfClean();

const B = process.env.LX_BASE ?? "http://localhost:8080";
const SHOTS = "D:/tmp/shots-iter11-test";
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
  if (!res.ok || (json as any).result === undefined) console.log("API-ERR", path.split("?")[0], res.status, JSON.stringify(json).slice(0, 160));
  return { status: res.status, json };
}
const d = (r: any) => r.json?.result?.data?.json ?? r.json?.result?.data;

/** 表格列对齐扫描：每列取表头+全部可见行同列单元格左/右缘，报告最大偏差（px） */
async function columnDeviation(page: Page, tableSel: string): Promise<{ max: number; cols: number; rows: number }> {
  return page.evaluate((sel) => {
    const table = document.querySelector(sel) as HTMLElement;
    if (!table) return { max: -1, cols: 0, rows: 0 };
    const head = table.querySelector(":scope > .p9a-ta-head");
    const bodyRows = [...table.querySelectorAll(":scope .p9a-ta-body > .p9a-ta-row, :scope > .p9a-ta-row")].filter(
      (e) => e !== head && (e as HTMLElement).offsetParent !== null,
    );
    const rowEls = [...(head ? [head] : []), ...bodyRows].filter(
      (e) => !(e as HTMLElement).classList.contains("is-fold") && (e as HTMLElement).offsetParent !== null,
    );
    if (rowEls.length < 2) return { max: -1, cols: 0, rows: rowEls.length };
    const perRow = rowEls.map((r) => [...r.children].filter((c) => c instanceof HTMLElement).map((c) => {
      const rect = c.getBoundingClientRect();
      const js = getComputedStyle(c).justifySelf;
      return { left: rect.left, right: rect.right, center: (rect.left + rect.right) / 2, centered: js === "center" || js === "start" || js === "end" };
    }));
    const cols = Math.min(...perRow.map((r) => r.length));
    let max = 0;
    for (let i = 0; i < cols; i++) {
      const stretched = perRow.filter((r) => !r[i].centered);
      const centered = perRow.filter((r) => r[i].centered);
      if (stretched.length >= 2) {
        const lefts = stretched.map((r) => r[i].left);
        const rights = stretched.map((r) => r[i].right);
        max = Math.max(max, Math.max(...lefts) - Math.min(...lefts), Math.max(...rights) - Math.min(...rights));
      }
      if (centered.length >= 2) {
        const centers = centered.map((r) => r[i].center);
        max = Math.max(max, Math.max(...centers) - Math.min(...centers));
      }
    }
    return { max: Math.round(max * 10) / 10, cols, rows: rowEls.length };
  }, tableSel);
}

test.describe.configure({ mode: "serial" });
const shared: { expenseInstanceId?: string; travelInstanceId?: string; requestInstanceId?: string } = {};

test("T1 表格列对齐：报表 3 张+业务表 5 页同列缘偏差≤1px", async ({ page }) => {
  await login(page, "guojingwen@lexflow.demo");
  const targets: Array<[string, string, string]> = [
    ["/reports/monthly_cashflow", ".rep-excel", "月度收支"],
    ["/reports/receivable_aging", ".rep-excel", "收款账龄"],
    ["/reports/project_costing", ".rep-excel", "收支核算"],
    ["/fin/receivables", ".p9a-ta-table", "应收管理"],
    ["/fin/invoices", ".p9a-ta-table", "发票管理"],
    ["/crm/customers", ".p9a-ta-table", "客户列表"],
    ["/crm/contracts", ".p9a-ta-table", "合同列表"],
    ["/crm/leads", ".p9a-ta-table", "线索池"],
    ["/crm/opportunities", ".p9a-ta-table", "商机管理"],
  ];
  const report: string[] = [];
  for (const [path, sel, label] of targets) {
    await page.goto(`${B}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    // 多表页面取第一个可见表
    const sel2 = await page.evaluate((s) => {
      const t = [...document.querySelectorAll(s)].find((e) => (e as HTMLElement).offsetHeight > 0 && e.querySelector(":scope > .p9a-ta-row"));
      return t ? `${s}[data-scan="1"]` : "";
    }, sel);
    const firstVisible = page.locator(`${sel}:visible`).first();
    if (!(await firstVisible.count())) { report.push(`${label}: 无表（跳过）`); continue; }
    // 给目标表打标后扫描
    await page.evaluate((s) => {
      const t = [...document.querySelectorAll(s)].find((e) => {
        const el = e as HTMLElement;
        return el.offsetHeight > 0 && el.querySelector(":scope > .p9a-ta-row");
      });
      if (t) t.setAttribute("data-scan", "1");
    }, sel);
    const r = await columnDeviation(page, `${sel}[data-scan="1"]`);
    expect(r.rows, `${label} 表头+行在位`).toBeGreaterThanOrEqual(2);
    expect(r.max, `${label} 同列缘偏差≤1px（实测 ${r.max}，${r.cols} 列×${r.rows} 行）`).toBeLessThanOrEqual(1);
    report.push(`${label}: 偏差 ${r.max}px（${r.cols} 列×${r.rows} 行）`);
    await page.evaluate((s) => document.querySelectorAll(`${s}[data-scan]`).forEach((e) => e.removeAttribute("data-scan")), sel);
  }
  console.log("ALIGN-REPORT\n" + report.join("\n"));
  await shot(page, "T1-表格对齐");
});

test("T2 审批卡业务详情：三分型快照+真名映射+非审批人 404", async ({ page }) => {
  // —— 确定性造数：member 造 报销/出差/申请单 并 submit（create 不自动提审，须补 submit）——
  await login(page, "guanchen@lexflow.demo");
  const projs = d(await api(page, `project.list?input=${encodeURIComponent(JSON.stringify({ limit: 10 }))}`));
  const projectId = (projs.items ?? [])[0]?.id;
  expect(projectId, "member 可见项目").toBeTruthy();
  const types = d(await api(page, "genericRequest.types"));
  const requestType = (types.items ?? [])[0]?.key ?? "leave";
  const stamp = "i11" + Date.now().toString(36);
  const expCreate = d(await api(page, "expense.create", {
    reason: `${stamp}-报销快照验收`,
    items: [{ projectId, date: "2026-11-09", category: "transport", amountCents: 12300, description: "高铁票" }],
  }));
  expect(expCreate?.id, "报销单已建").toBeTruthy();
  const expFull = d(await api(page, `expense.getById?input=${encodeURIComponent(JSON.stringify({ id: expCreate.id }))}`));
  const expSubmit = d(await api(page, "expense.submit", { id: expCreate.id, rowVersion: expFull.rowVersion, idempotencyKey: crypto.randomUUID() }));
  expect(expSubmit?.status ?? expSubmit, "报销已提审").toBeTruthy();
  const trvCreate = d(await api(page, "travel.create", {
    projectId,
    reason: `${stamp}-出差快照验收`,
    destination: "南京",
    startOn: "2026-11-10",
    endOn: "2026-11-11",
    estimatedCostCents: 56000,
    segments: [{ seq: 1, type: "transport", startAt: "2026-11-10T08:00", endAt: "2026-11-10T11:00", fromPlace: "苏州", toPlace: "南京" }],
  }));
  expect(trvCreate?.id, "出差单已建").toBeTruthy();
  const trvFull = d(await api(page, `travel.getById?input=${encodeURIComponent(JSON.stringify({ id: trvCreate.id }))}`));
  const trvSubmit = d(await api(page, "travel.submit", { id: trvCreate.id, rowVersion: trvFull.rowVersion, idempotencyKey: crypto.randomUUID() }));
  expect(trvSubmit?.status ?? trvSubmit, "出差已提审").toBeTruthy();
  const reqCreate = d(await api(page, "genericRequest.create", {
    requestType,
    title: `${stamp}-申请单快照验收`,
    reason: "迭代 11 验收造数",
    startOn: "2026-11-10",
    endOn: "2026-11-10",
  }));
  expect(reqCreate?.id, "申请单已建").toBeTruthy();
  const reqFull = d(await api(page, `genericRequest.getById?input=${encodeURIComponent(JSON.stringify({ id: reqCreate.id }))}`));
  const users0 = d(await api(page, `user.list?input=${encodeURIComponent(JSON.stringify({ keyword: "guojingwen", limit: 5 }))}`));
  const u0 = ((users0.items ?? users0 ?? []) as any[]).find((u: any) => /guojingwen/.test(u.email)) ?? ((users0.items ?? users0 ?? []) as any[])[0];
  const reqSubmit = d(await api(page, "genericRequest.submit", { id: reqCreate.id, rowVersion: reqFull.rowVersion, idempotencyKey: crypto.randomUUID(), chosenApproverId: u0.id }));
  expect(reqSubmit?.status ?? reqSubmit, "申请单已提审").toBeTruthy();

  // —— 我申请列表：行级真名映射（非 uuid）——
  const applied = d(await api(page, `approval.listMineApplied?input=${encodeURIComponent(JSON.stringify({ limit: 10 }))}`));
  const rows = (applied.items ?? []) as any[];
  // formSnapshot 仅部分字段（expense=checks/travel=borrow+cost）——按 bizType+提交新鲜度匹配本批
  const fresh = (r: any) => Date.now() - new Date(r.submittedAt ?? r.createdAt).getTime() < 5 * 60_000;
  const expRow = rows.find((r) => r.bizType === "expense" && fresh(r));
  const trvRow = rows.find((r) => r.bizType === "travel" && fresh(r));
  const reqRow = rows.find((r) => r.bizType === "generic_request" && fresh(r));
  expect(expRow, "报销实例在列").toBeTruthy();
  expect(trvRow, "出差实例在列").toBeTruthy();
  expect(reqRow, "申请单实例在列").toBeTruthy();
  for (const r of [expRow, trvRow, reqRow]) {
    expect(r.applicantName ?? r.applicantId, "applicantName 真名映射").not.toMatch(/^[0-9a-f]{8}-/i);
    if (r.projectName) expect(r.projectName, "projectName 真名映射").not.toMatch(/^[0-9a-f]{8}-/i);
  }
  // —— 每实例 getById（申请人放行）→ 当前步审批人（逐单解析：不同单审批人可能不同）——
  await login(page, "zhaokai@lexflow.demo");
  const users = d(await api(page, "admin.userList"));
  const uList = (users.items ?? users ?? []) as any[];
  const resolveApprover = (email: string) => email;
  const perInstance: Array<{ row: any; kind: string; email: string }> = [];
  for (const [row, kind] of [[expRow, "expense"], [trvRow, "travel"], [reqRow, "generic_request"]] as const) {
    await login(page, "guanchen@lexflow.demo");
    const byId = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: row.id }))}`));
    const steps = (byId?.steps ?? []) as any[];
    const current = steps.find((s) => s.status === "pending") ?? steps[byId.currentStepSeq - 1];
    expect(current, `${kind} 当前审批步在位`).toBeTruthy();
    const approverId = current.approverId as string | null;
    expect(approverId ?? current.approverRole, `${kind} 审批人=具体人或角色`).toBeTruthy();
    const approver = approverId ? uList.find((u) => u.id === approverId) : uList.find((u) => (u.roles ?? u.globalRoles ?? []).includes(current.approverRole));
    expect(approver?.email, `${kind} 审批人邮箱可解析`).toBeTruthy();
    perInstance.push({ row, kind, email: resolveApprover(approver.email) });
  }

  // —— 当前审批人 detail：三分型快照 ——
  const patternsByKind: Record<string, RegExp[]> = {
    expense: [/事由|合计|金额|高铁/],
    travel: [/行程|南京|出发|到达|起止/],
    generic_request: [/申请|事由|标题|类型/],
  };
  for (const { row, kind, email } of perInstance) {
    await login(page, email);
    const det = d(await api(page, `approval.detail?input=${encodeURIComponent(JSON.stringify({ instanceId: row.id }))}`));
    expect(det, `${kind} detail 返回`).toBeTruthy();
    expect(det.bizType, `${kind} bizType`).toBe(kind);
    const snap = JSON.stringify(det.snapshot ?? det);
    for (const p of patternsByKind[kind]) expect(p.test(snap), `${kind} 快照匹配 ${p}`).toBeTruthy();
    expect(/[0-9a-f]{8}-[0-9a-f]{4}/i.test(snap), `${kind} 快照无 uuid 泄露`).toBeFalsy();
  }
  // —— UI 卡：审批中心默认展开业务快照+类型徽标+真名+uuid 不上屏 ——
  await page.goto(`${B}/approvals`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const cardText = await page.evaluate(() => document.querySelector(".main-workspace")?.textContent ?? "");
  expect(cardText, "卡内含本批验收事由").toContain("快照验收");
  expect(/报销|出差|申请/.test(cardText), "类型徽标在位").toBeTruthy();
  expect(/[0-9a-f]{8}-[0-9a-f]{4}/i.test(cardText), "审批卡 uuid 不上屏").toBeFalsy();
  await shot(page, "T2-审批卡业务快照");
  // —— 非审批人 404：sysadmin 非本单审批人/申请人 ——
  await login(page, "zhaokai@lexflow.demo");
  const probe = await api(page, `approval.detail?input=${encodeURIComponent(JSON.stringify({ instanceId: expRow.id }))}`);
  const bodyStr = JSON.stringify(probe.json);
  expect(
    probe.status === 404 || bodyStr.includes("ACCESS_DENIED_OR_GONE"),
    `非审批人 detail 同形 404（实测 status=${probe.status}）`,
  ).toBeTruthy();
});

test("T3 表单精细化：分组/聚焦环/错误态", async ({ page }) => {
  console.log("T3-step: login");
  await login(page, "guojingwen@lexflow.demo");
  console.log("T3-step: goto invoices");
  await page.goto(`${B}/fin/invoices`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  console.log("T3-step: click 开具");
  await page.getByRole("button", { name: /开具发票|新建发票/ }).first().click();
  console.log("T3-step: drawer assertions");
  const drawer = page.locator(".overlay .decision-modal:visible, .overlay .ux-modal-wide:visible").first();
  await expect(drawer, "发票抽屉在位").toBeVisible({ timeout: 10_000 });
  // ① 分组：.form-section ≥2
  const sections = await drawer.locator(".form-section").count();
  expect(sections, "发票表单分组 ≥2").toBeGreaterThanOrEqual(2);
  // ② label 12px 弱色上置
  const labelStyle = await drawer.locator(".form-field > span").first().evaluate((e) => {
    const cs = getComputedStyle(e);
    return { size: cs.fontSize, color: cs.color };
  });
  expect(["12px", "13px"]).toContain(labelStyle.size);
  expect(labelStyle.color, "label 弱色").toBe("rgb(100, 116, 139)");
  // ③ 聚焦环：主色细环（evaluate 聚焦避免动作性等待）
  const shadow = await drawer.evaluate((e) => {
    const input = e.querySelector(".form-field input:not([type=hidden]), .form-field select") as HTMLElement;
    if (!input) return "";
    input.focus();
    return getComputedStyle(input).boxShadow;
  });
  expect(/37,\s*99,\s*235/.test(shadow), `聚焦环主色（实测 ${shadow.slice(0, 80)}）`).toBeTruthy();
  // ④ 错误态：红环+红字（活体=登录页空提交 field-error 红字；红环=样式表规则断言 .form-field.has-error）
  await page.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
  await page.goto(`${B}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(700);
  const errEm = page.locator("em.field-error:visible").first();
  await expect(errEm, "field-error 红字在位").toBeVisible({ timeout: 8_000 });
  const errColor = await errEm.evaluate((e) => getComputedStyle(e).color);
  expect(errColor, "红字 #dc2626").toBe("rgb(220, 38, 38)");
  const ringRule = await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule.cssText?.includes(".form-field.has-error")) return rule.cssText.slice(0, 120);
        }
      } catch { /* cross-origin */ }
    }
    return "";
  });
  expect(ringRule, "红环规则在位（.form-field.has-error）").toContain("rgba(220, 38, 38");
  await shot(page, "T3-表单精细化-发票抽屉");
});

test("T4 uuid 截断零残留扫描（8 页）", async ({ page }) => {
  await login(page, "liangqifeng@lexflow.demo");
  const pages = [
    ["/approvals", "审批中心"],
    ["/cockpit", "驾驶舱"],
    ["/workbench", "工作台"],
    ["/operations/receipts", "收款台账"],
    ["/operations/expenses", "费用报销"],
    ["/projects", "项目列表"],
    ["/meetings", "会议"],
    ["/crm/customers", "客户列表"],
  ] as const;
  const hits: string[] = [];
  for (const [path, label] of pages) {
    await page.goto(`${B}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    const text = await page.evaluate(() => document.querySelector(".main-workspace")?.textContent ?? document.body.innerText);
    const uuidLike = text.match(/[0-9a-f]{8}-[0-9a-f]{4}(-[0-9a-f]{4})?/gi) ?? [];
    const shortHex = text.match(/\baa6a0ee\b|\b[0-9a-f]{8}\.\.\./gi) ?? [];
    if (uuidLike.length || shortHex.length) hits.push(`${label}: ${[...uuidLike, ...shortHex].slice(0, 5).join(",")}`);
  }
  expect(hits, `uuid 残留（${hits.join(" | ")}）`).toEqual([]);
  await shot(page, "T4-uuid零残留");
});
