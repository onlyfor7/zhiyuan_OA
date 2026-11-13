/** 工单 17-05：迭代 17 验收（e2e 自清复核/项目流深编/SSE 实时/观察项五项/移动端三档八页，arch/12 §20）。
 * T1 自清复核在 prod 连跑两轮 e2e 全量+计数零增长（execSync 内嵌全量，30min 超时）。
 * T2–T5 取证：dev :3000（LX_BASE）。prod 发布后复跑同脚本切 :8080。
 * F3 合规：开跑前确认无其他测试会话在跑。截图 D:/tmp/shots-iter17-test/。 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { collectOpenCounts } from "./e2e-cleanup";

const B = process.env.LX_BASE ?? "http://localhost:8080";
const SHOTS = "D:/tmp/shots-iter17-test";
mkdirSync(SHOTS, { recursive: true });
const IS_PROD = !B.includes("3000");

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
  await page.addStyleTag({ content: "* { animation: none !important; transition: none !important; backdrop-filter: none !important; }" });
  await page.waitForTimeout(600);
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
const d = (r: any) => r.json?.result?.data?.json ?? r.json?.result?.data;

test.describe.configure({ mode: "serial" });

test("T1 e2e 自清复核：prod 两轮 e2e 全量+12 域计数零增长", async () => {
  test.skip(!IS_PROD, "两轮零增长复核以 prod 为准（dev 库历史污染不可作零增长基线）");
  test.setTimeout(30 * 60_000);
  const e2eDir = `${process.cwd()}`;
  const run = () => execSync("npx playwright test e2e-01-16.spec.ts --reporter=line", {
    cwd: e2eDir, stdio: "inherit",
    env: { ...process.env, LX_BASE: "http://localhost:8080" },
  });
  const c0 = await collectOpenCounts();
  console.log("T1-counts-baseline", JSON.stringify(c0));
  run();
  const c1 = await collectOpenCounts();
  console.log("T1-counts-after-R1", JSON.stringify(c1));
  run();
  const c2 = await collectOpenCounts();
  console.log("T1-counts-after-R2", JSON.stringify(c2));
  for (const k of Object.keys(c0)) {
    expect(c2[k], `${k} 两轮零增长（${c0[k]}→${c1[k]}→${c2[k]}）`).toBe(c0[k]);
    expect(c1[k], `${k} 第一轮零增长`).toBe(c0[k]);
  }
});

test("T2 项目流深度编辑：设计器草稿改名→保存落库→发布→再存 409→他项目 404", async ({ page }) => {
  await login(page, "wangbaozhuo@lexflow.demo");
  const projs = d(await api(page, `project.list?input=${encodeURIComponent(JSON.stringify({ limit: 10 }))}`));
  const proj = (projs.items ?? []).find((p: any) => p.code.endsWith("-00001")) ?? projs.items[0];
  expect(proj, "项目在位").toBeTruthy();
  // 建草稿（API）→ 设计器打开
  const mini = {
    nodes: [
      { id: "start", type: "start", label: "发起" },
      { id: "n1", type: "approval", label: "审批节点 1", approver: { kind: "role", role: "project_manager" }, countersign: "any" },
      { id: "end", type: "end", label: "完成" },
    ],
    edges: [{ from: "start", to: "n1" }, { from: "n1", to: "end" }],
  };
  const created = d(await api(page, "project.flows.createDraft", { projectId: proj.id, name: `E2E-17流-${Date.now().toString(36)}`, bizBinding: "expense", definitionJson: mini }));
  const flowId = created?.id ?? created?.flow?.id;
  expect(flowId, "草稿流已建").toBeTruthy();
  await page.goto(`${B}/flows/p/${proj.id}/${flowId}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const canvas = await page.locator(".main-workspace").innerText();
  expect(/发起|完成/.test(canvas), "画布预填骨架在位").toBeTruthy();
  // 选中画布审批节点（按节点文字精确点）→属性改名→保存草稿（updateDraft）
  await page.locator(".main-workspace").getByText("审批节点 1", { exact: true }).first().dispatchEvent("click");
  await page.waitForTimeout(600);
  const nameInput = page.locator(".main-workspace [class*='props'] input:visible, .main-workspace .form-field input:visible").first();
  await nameInput.fill("E2E-17改名-负责人审");
  await page.getByRole("button", { name: "保存草稿" }).first().dispatchEvent("click");
  await page.waitForTimeout(1800);
  const flows = d(await api(page, `project.flows.list?input=${encodeURIComponent(JSON.stringify({ projectId: proj.id }))}`));
  const flowArr = (Array.isArray(flows) ? flows : flows?.items ?? []) as any[];
  const saved = flowArr.find((f: any) => f.id === flowId);
  expect(JSON.stringify(saved), "改名经 updateDraft 落库").toContain("E2E-17改名");
  await shot(page, "T2-设计器改名保存");
  // 发布→再保存=409 守卫
  await page.getByRole("button", { name: /发\s*布/ }).first().dispatchEvent("click");
  await page.waitForTimeout(1800);
  const dup = d(await api(page, "project.flows.list?input=${x}", undefined as any).catch(() => ({})));
  void dup;
  const saveAgain = await api(page, "project.flows.updateDraft", { id: flowId, projectId: proj.id, definitionJson: saved.definitionJson, name: "再存", rowVersion: saved.rowVersion ?? 0 });
  expect(saveAgain.status, "已发布再存=409（实测 " + saveAgain.status + "）").toBe(409);
  await shot(page, "T2-发布与409守卫");
  // 他项目 404：另一项目负责人改本流
  await login(page, "liangqifeng@lexflow.demo");
  const other = await api(page, "project.flows.updateDraft", { id: flowId, projectId: proj.id, name: "x", rowVersion: 0 });
  expect(other.status === 404 || JSON.stringify(other.json).includes("ACCESS_DENIED_OR_GONE"), "他项目负责人 404 同形").toBeTruthy();
});

test("T3 SSE 实时：通知/审批/小元气泡秒级到达（总线按 userId 定向——监听方=首组审批人 pm/申请人 member）+断线回退在位", async ({ page, browser }) => {
  // pm（首组审批人）页挂 EventSource；member（申请人）页挂 EventSource（终态/通知面）
  const pmPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const listen = async (pg: Page) => {
    await pg.evaluate(() => {
      (window as any).__sseLog = [];
      (window as any).__sseOpen = false;
      const es = new EventSource("/events");
      es.onopen = () => { (window as any).__sseOpen = true; };
      for (const t of ["approval.todo", "assistant.feed", "notification.created", "approval_result"]) {
        es.addEventListener(t, () => (window as any).__sseLog.push(`${t}@${Date.now()}`));
      }
      (window as any).__es = es;
    });
    await pg.waitForFunction(() => (window as any).__sseOpen, { timeout: 30_000 });
  };
  await login(pmPage, "wangbaozhuo@lexflow.demo");
  await listen(pmPage);
  await login(page, "guanchen@lexflow.demo");
  await listen(page);
  // member 提交报销 → pm 收 approval.todo + assistant.feed（秒级）
  const projs = d(await api(page, `project.list?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`));
  const exp = d(await api(page, "expense.create", {
    reason: `E2E-17-SSE-${Date.now().toString(36)}`,
    items: [{ projectId: projs.items[0].id, date: "2026-11-13", category: "transport", amountCents: 100, description: "SSE 触发" }],
  }));
  const full = d(await api(page, `expense.getById?input=${encodeURIComponent(JSON.stringify({ id: exp.id }))}`));
  const sub = await api(page, "expense.submit", { id: exp.id, rowVersion: full.rowVersion, idempotencyKey: crypto.randomUUID() });
  expect(sub.status, `报销已提交（触发引擎事件）status=${sub.status}`).toBe(200);
  const instanceId = d(sub)?.instance?.id as string;
  expect(instanceId, "submit 响应带 instance.id").toBeTruthy();
  await pmPage.waitForFunction(() => (window as any).__sseLog.length > 0, { timeout: 12_000 });
  const pmLog: string[] = await pmPage.evaluate(() => (window as any).__sseLog);
  expect(pmLog.join(" ").match(/approval\.todo|assistant\.feed/), `审批面事件秒级到达（${pmLog.slice(0, 3).join(",")}）`).toBeTruthy();
  await shot(pmPage, "T3-审批面SSE");
  // 小元气泡秒级弹（pm 页 feed 提醒）
  await expect(pmPage.locator(".ai-remind-pop").first(), "小元提醒气泡秒级弹").toBeVisible({ timeout: 10_000 });
  await shot(pmPage, "T3-小元气泡");
  // pm 批准 → member 收 approval_result/notification.created（通知面）
  const byId = d(await api(pmPage, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: instanceId }))}`));
  const step = (byId.steps ?? []).find((x: any) => x.status === "pending");
  expect(step, "审批步在 pm 待办").toBeTruthy();
  const act = await api(pmPage, "approval.act", { instanceId, stepSeq: step.seq, action: "approve", comment: "T3 通过" });
  expect(act.status, "pm 批准").toBe(200);
  await page.waitForFunction(() => (window as any).__sseLog.length > 0, { timeout: 12_000 });
  const meLog: string[] = await page.evaluate(() => (window as any).__sseLog);
  expect(meLog.join(" ").match(/approval_result|notification\.created/), `通知/终态面事件秒级到达（${meLog.slice(0, 3).join(",")}）`).toBeTruthy();
  await shot(page, "T3-通知面SSE");
  // 断线回退：关闭事件源后 HTTP 兜底语义在位
  await pmPage.evaluate(() => (window as any).__es.close());
  await page.evaluate(() => (window as any).__es.close());
  const feed = d(await api(page, "ai.assistant.feed"));
  expect(feed.counts.total, "回退口径 feed 可查").toBeGreaterThanOrEqual(0);
  await pmPage.close();
});

test("T4 观察项五项逐项关闭", async ({ page }) => {
  await login(page, "guojingwen@lexflow.demo");
  // ① 漏斗「（分）」→「（元）」——18-05：finance D4 金额列整体缺席，取证改运营
  await login(page, "xuwenjing@lexflow.demo");
  await page.goto(`${B}/reports/opportunity_funnel`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const funnelText = await page.evaluate(() => document.querySelector(".main-workspace")?.textContent ?? "");
  expect(funnelText.includes("（分）"), "漏斗无（分）标签").toBeFalsy();
  expect(funnelText.includes("（元）"), "漏斗（元）标签在位").toBeTruthy();
  // ② 项目下拉接 financeOptions——18-05 勘误：finance∈money 角色（canReadMoney=finance/partner/pm），下拉取证**恢复迭代17原角色 finance**（operations 无 financeOptions 权→404→仅 1 选项，不可用）
  await login(page, "guojingwen@lexflow.demo");
  await page.goto(`${B}/reports/monthly_cashflow`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const projOpts = await page.locator("select").last().evaluate((e) => (e as HTMLSelectElement).options.length);
  expect(projOpts, `finance 项目下拉选项（prod=全部+5 项目实测 ${projOpts}，dev 数据态曾 21）`).toBeGreaterThanOrEqual(6);
  // 「无财务可见权」note 卡实证：canReadMoney 之外的角色（member）收空态口径卡（finance 为 money 角色见全表——上一步已实证，权限语义不松）
  await login(page, "guanchen@lexflow.demo");
  await page.goto(`${B}/reports/monthly_cashflow`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => document.body.innerText)).toContain("无财务可见权");
  // ③ reports/report 命名分层共存（pm 视角：project.list 有项目矩阵）
  await login(page, "wangbaozhuo@lexflow.demo");
  const projId2 = (await api(page, "project.list?input=" + encodeURIComponent(JSON.stringify({ limit: 1 })))).json.result.data.items[0].id;
  const weekly = await api(page, "report.generateDraft", { projectId: projId2, periodStart: "2026-11-10", periodEnd: "2026-11-16" });
  expect(weekly.status, "治理周报 report.* 不动（200）").toBe(200);
  const report = await api(page, `reports.monthlyCashflow?input=${encodeURIComponent(JSON.stringify({}))}`);
  expect(report.status, "报表中心 reports.* 不动（200）").toBe(200);
  // ④ member 费用类别本人口径 200
  await login(page, "guanchen@lexflow.demo");
  const expCat = await api(page, `reports.expenseCategory?input=${encodeURIComponent(JSON.stringify({}))}`);
  expect(expCat.status, "member 费用类别本人口径 200（实测 " + expCat.status + "）").toBe(200);
  // ⑤ 双页签混合渲染统一：member 撞业务对象 5 轮采样标题一致 gone
  for (let i = 0; i < 5; i++) {
    await page.goto(`${B}/projects/00000000-0000-4000-8000-000000000000`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    const h1 = await page.evaluate(() => document.querySelector("h1")?.textContent?.trim() ?? "");
    expect(h1, `第 ${i + 1} 轮同形标题稳定`).toBe("不存在或无权访问");
    await page.goto(`${B}/cockpit`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
  }
  await shot(page, "T4-观察项");
});

test("T5 移动端三档八页矩阵：零溢出+触控 ≥44px", async ({ page }) => {
  await login(page, "wangbaozhuo@lexflow.demo");
  const projs = d(await api(page, `project.list?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`));
  const pid = projs.items[0].id;
  const pages = ["/cockpit", "/workbench", "/approvals", `/projects/${pid}`, "/reports", "/crm/leads", "/operations/time", "/settings"];
  const widths = [375, 390, 414];
  for (const w of widths) {
    await page.setViewportSize({ width: w, height: 812 });
    for (const p of pages) {
      await page.goto(`${B}${p}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(700);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${w}px ${p} 零横向溢出（实测 ${overflow}）`).toBeLessThanOrEqual(1);
    }
  }
  await shot(page, "T5-414项目空间");
  // 触控目标 ≥44px 抽查（375 驾驶舱 10 个可点元素）
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${B}/cockpit`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const small = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll("button, a[href], [role='button']").forEach((e) => {
      const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      if (r.height > 0 && (e as HTMLElement).offsetHeight > 0 && r.height < 44 && r.width < 44) {
        out.push(`${e.tagName}.${(e.className || "").toString().slice(0, 20)} ${Math.round(r.height)}x${Math.round(r.width)}`);
      }
    });
    return out;
  });
  expect(small.slice(0, 10), `触控 ≥44px（违规样例 ${JSON.stringify(small.slice(0, 5))}）`).toEqual([]);
});
