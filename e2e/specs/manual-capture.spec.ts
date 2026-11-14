/** 专项工单《系统功能手册全量版》截图采集脚本。
 * 默认只读：全部截图在外测 prod（LX_BASE，默认 http://182.92.206.62:8080）执行；
 * 弹窗/向导类演示仅「打开→截图→取消/离开」，不产生写操作；唯一例外=报表导出 CSV（读路径+审计行，正常业务行为）。
 * 产出：docs/manual-assets/2026-11-14/*.png（+1 个 CSV 导出样例）与 manifest.json。
 * 可重复执行；文件名固定覆盖。F3：跑本脚本时确认无其他 playwright 套件在跑。
 * 健壮性：Playwright 动作默认超时=0（不限）——一切可选交互统一走 tap()/tryNav() 显式 6s 超时，
 * 且绝不依赖 networkidle（SSE 长连接不满足）；测试非 serial，单章失败不阻断其余章节。
 */
import { expect, test, request, type Page, type Locator } from "@playwright/test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

const B = process.env.LX_BASE ?? "http://182.92.206.62:8080";
const ASSETS = path.resolve(process.cwd(), "../docs/manual-assets/2026-11-14");
mkdirSync(ASSETS, { recursive: true });

type Shot = { id: string; file: string; chapter: string; page: string; role: string; viewport: string };
const manifest: Shot[] = (() => {
  try {
    const prev = JSON.parse(readFileSync(path.join(ASSETS, "manifest.json"), "utf8"));
    return Array.isArray(prev.shots) ? prev.shots : [];
  } catch {
    return [];
  }
})();
const stamp = new Date().toISOString();

/** 可选点击：显式 6s 超时，失败静默（Playwright 动作默认超时=0 会挂死到测试超时） */
async function tap(loc: Locator) {
  await loc.click({ timeout: 6_000 }).catch(() => {});
}
/** 可选 dispatchEvent 点击（绕过 actionability，用于被浮层遮挡的导航触发器） */
async function tapDispatch(loc: Locator) {
  await loc.dispatchEvent("click").catch(() => {});
}

async function snap(page: Page, id: string, chapter: string, pageName: string, role: string, opts: { viewport?: string } = {}) {
  const file = `${id}.png`;
  await page.waitForTimeout(650);
  await page.screenshot({ path: path.join(ASSETS, file) });
  manifest.push({ id, file, chapter, page: pageName, role, viewport: opts.viewport ?? "desktop-1440x900" });
  persistManifest();
}

/** manifest 增量落盘：afterAll 对顶层 test 分组逐组执行会互相覆盖——改为每次 snap 即写（按 id 去重，最后一张为准） */
function persistManifest() {
  const seen = new Map<string, Shot>();
  for (const s of manifest) seen.set(s.id, s);
  const shots = [...seen.values()];
  writeFileSync(path.join(ASSETS, "manifest.json"), JSON.stringify({ capturedAt: stamp, base: B, shots }, null, 2));
}

async function login(page: Page, email: string) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
  await page.goto(`${B}/login`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.getByPlaceholder("name@firm.com").fill(email, { timeout: 8_000 });
  await page.locator('input[type="password"]').fill("Demo@2026", { timeout: 8_000 });
  await page.getByRole("button", { name: "登录" }).click({ timeout: 10_000 });
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 25_000 });
  await page.waitForSelector(".topnav-groups", { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(400);
}

async function nav(page: Page, url: string, readySelector: string) {
  // domcontentloaded + 就绪选择器：避免 SSE 长连接导致 networkidle 永不满足（prod 外网放大该风险）
  await page.goto(`${B}${url}`, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
  await page.waitForSelector(readySelector, { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(600);
}

async function api(page: Page, pathName: string, body?: unknown) {
  const res = await page.request.fetch(`${B}/trpc/${pathName}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status(), json: await res.json().catch(() => ({})) };
}

/** 取当前角色可见的项目 id：关键词直搜比博思特（旗舰演示项目），回落首个可见 */
async function firstProjectId(page: Page): Promise<string> {
  const kw = await api(page, `project.list?input=${encodeURIComponent(JSON.stringify({ filters: { keyword: "比博思特" }, limit: 5 }))}`);
  const kwItems = ((kw.json as any).result?.data?.items ?? []) as any[];
  if (kwItems.length) return kwItems[0].id;
  const r = await api(page, `project.list?input=${encodeURIComponent(JSON.stringify({ limit: 20 }))}`);
  const items = ((r.json as any).result?.data?.items ?? []) as any[];
  return items[0]?.id ?? "";
}

test.describe.configure({ timeout: 600_000 });
// 全局动作/导航超时兜底：Playwright 默认 actionTimeout=0（不限），locator 等待可挂到测试超时——统一 cap 8s/20s
test.use({ actionTimeout: 8_000, navigationTimeout: 20_000 });

test("基础 7 张（ch1）", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // 01 登录页（未登录）
  await page.goto(`${B}/login`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForSelector('input[type="password"]', { timeout: 10_000 }).catch(() => {});
  await snap(page, "01-01-login", "1 账号与通用操作", "登录页", "未登录");
  // 02 驾驶舱 partner
  await login(page, "liangqifeng@lexflow.demo");
  await nav(page, "/cockpit", ".main-workspace");
  await snap(page, "01-02-cockpit", "1 账号与通用操作", "管理驾驶舱", "partner");
  // 03 工作台 pm
  await login(page, "wangbaozhuo@lexflow.demo");
  await nav(page, "/workbench", ".main-workspace");
  await snap(page, "01-03-workbench", "1 账号与通用操作", "项目工作台", "project_manager");
  // 04 级联导航 operations（展开经营组→截图→关闭面板）
  await login(page, "xuwenjing@lexflow.demo");
  await nav(page, "/workbench", ".topnav-groups");
  await tapDispatch(page.locator(".topnav-groups .p9a-dd-trigger", { hasText: "经营" }).first());
  await page.waitForTimeout(700);
  await snap(page, "01-04-cascade-nav", "1 账号与通用操作", "八组级联导航（经营组展开）", "operations");
  await page.keyboard.press("Escape").catch(() => {});
  await page.mouse.click(720, 840).catch(() => {});
  await page.waitForTimeout(300);
  // 05 多页签：/projects 开一页签，再经导航开驾驶舱第二页签
  await nav(page, "/projects", ".topnav-groups");
  await tapDispatch(page.locator(".topnav-groups .p9a-dd-trigger", { hasText: "总览" }).first());
  await page.waitForTimeout(500);
  await tapDispatch(page.locator(".p9a-menu-item", { hasText: "驾驶舱" }).first());
  await page.waitForSelector(".p9a-tabs", { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(600);
  await snap(page, "01-05-tabs", "1 账号与通用操作", "多页签工作区（两页签并存）", "operations");
  // 06 通知中心 member
  await login(page, "guanchen@lexflow.demo");
  await nav(page, "/notifications", ".main-workspace");
  await snap(page, "01-06-notifications", "1 账号与通用操作", "通知中心", "member");
  // 07 全局搜索 operations
  await login(page, "xuwenjing@lexflow.demo");
  await nav(page, "/search", ".main-workspace");
  const input = page.locator("input").first();
  await input.fill("项目", { timeout: 5_000 }).catch(() => {});
  await input.press("Enter").catch(() => {});
  await page.waitForTimeout(1200);
  await snap(page, "01-07-search", "1 账号与通用操作", "全局搜索（关键词=项目）", "operations");
});

test("CRM 10 张（ch3）", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "sumingxuan@lexflow.demo");
  await nav(page, "/crm/leads", ".main-workspace");
  await snap(page, "03-01-leads", "3 CRM 全链", "线索池列表", "sales");
  // 02 线索抽屉
  await tapDispatch(page.locator(".report-row, .p9a-ta-row").first());
  await page.waitForSelector('.overlay [role="dialog"]', { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(800);
  await snap(page, "03-02-lead-drawer", "3 CRM 全链", "线索详情抽屉（含跟进区）", "sales");
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);
  // 03 转化弹窗（打开→截图→取消，只读）
  const convBtn = page.getByRole("button", { name: /转化/ }).first();
  if (await convBtn.count()) {
    await tap(convBtn);
    await page.waitForSelector("[role='dialog']", { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(900);
    await snap(page, "03-03-lead-convert", "3 CRM 全链", "线索转化 Stepper（打开未提交）", "sales");
    await tap(page.getByRole("button", { name: /取消|关闭/ }).first());
    await page.keyboard.press("Escape").catch(() => {});
  }
  // 04 商机列表 06 抽屉（表格态开） 05 看板
  await nav(page, "/crm/opportunities", ".main-workspace");
  await snap(page, "03-04-opps-table", "3 CRM 全链", "商机列表（表格视图）", "sales");
  await tapDispatch(page.locator(".p9a-ta-row.is-clickable").first());
  await page.waitForSelector('.overlay [role="dialog"]', { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(800);
  await snap(page, "03-06-opp-drawer", "3 CRM 全链", "商机详情抽屉（含项目入口）", "sales");
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(400);
  const boardTab = page.getByRole("tab", { name: /看板/ }).first();
  if (await boardTab.count()) {
    await tap(boardTab);
    await page.waitForTimeout(1000);
    await snap(page, "03-05-opps-board", "3 CRM 全链", "商机看板（拖拽改阶段）", "sales");
  }
  // 07 客户列表 08 客户详情·合同页签
  await login(page, "liangqifeng@lexflow.demo");
  await nav(page, "/crm/customers", ".main-workspace");
  await snap(page, "03-07-customers", "3 CRM 全链", "客户列表", "partner");
  await tapDispatch(page.locator(".report-row, .p9a-ta-row").first());
  await page.waitForSelector(".main-workspace", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await tap(page.getByText("合同", { exact: true }).first());
  await page.waitForTimeout(800);
  await snap(page, "03-08-customer-contracts", "3 CRM 全链", "客户详情·合同页签", "partner");
  // 09 合同台账 10 跟进
  await nav(page, "/crm/contracts", ".main-workspace");
  await snap(page, "03-09-contracts", "3 CRM 全链", "合同台账", "partner");
  await nav(page, "/crm/followups", ".main-workspace");
  await snap(page, "03-10-followups", "3 CRM 全链", "跟进记录列表", "partner");
});

test("项目 17 张（ch4）", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "wangbaozhuo@lexflow.demo");
  await nav(page, "/projects", ".topnav-groups");
  await snap(page, "04-01-projects", "4 项目全周期", "项目全周期列表", "project_manager");
  // 02 新建项目向导（partner 打开→截图→离开，不提交）
  await login(page, "liangqifeng@lexflow.demo");
  await nav(page, "/projects/new", ".main-workspace");
  await snap(page, "04-02-project-new", "4 项目全周期", "新建项目向导（F4 整页，未提交）", "partner");
  // 03-16 项目空间 14 页签
  await login(page, "wangbaozhuo@lexflow.demo");
  const pid = await firstProjectId(page);
  expect(pid, "可见项目锚定").toBeTruthy();
  const tabs: Array<[string, string, string]> = [
    ["04-03-overview", "overview", "项目空间·总览"],
    ["04-04-plan-gantt", "plan", "计划与节点甘特"],
    ["04-05-tasks", "tasks", "任务"],
    ["04-06-meetings", "meetings", "会议"],
    ["04-07-travel", "travel", "出差"],
    ["04-08-budget", "budget", "预算"],
    ["04-09-expenses", "expenses", "费用"],
    ["04-10-timesheet", "timesheet", "工时"],
    ["04-11-quality", "quality", "质量"],
    ["04-12-decisions", "decisions", "决策"],
    ["04-13-weekly-report", "reports", "周报"],
    ["04-14-archive", "archive", "档案"],
    ["04-15-members", "members", "成员与权限"],
    ["04-16-project-flows", "flows", "项目内审批流"],
  ];
  for (const [id, tab, name] of tabs) {
    await nav(page, `/projects/${pid}/${tab}`, ".main-workspace");
    await snap(page, id, "4 项目全周期", name, "project_manager");
  }
  // 17 经费申请单（member 打开→截图→离开）
  await login(page, "guanchen@lexflow.demo");
  await nav(page, "/operations/funding/new", ".main-workspace");
  await snap(page, "04-17-funding-new", "4 项目全周期", "经费申请单（新建表单，未提交）", "member");
});

test("审批 5 张（ch5）", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "liangqifeng@lexflow.demo");
  await nav(page, "/approvals", ".main-workspace");
  await snap(page, "05-01-approval-center", "5 协同与审批", "审批中心", "partner");
  // 02 审批详情快照：业务快照默认内联展开——滚动首张审批卡入视口截图
  const firstCard = page.locator(".approval-card").first();
  await firstCard.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(900);
  await snap(page, "05-02-approval-detail", "5 协同与审批", "审批详情（业务快照内联展开）", "partner");
  // 03 设计器 sysadmin
  await login(page, "zhaokai@lexflow.demo");
  await nav(page, "/admin", ".audit-tabs");
  await tap(page.getByRole("button", { name: "审批流" }).first());
  await page.waitForTimeout(900);
  const designBtn = page.getByText("打开设计器").first();
  if (await designBtn.count()) {
    await tap(designBtn);
    await page.waitForURL(/\/admin\/flows\//, { timeout: 10_000 }).catch(() => {});
    await page.waitForSelector(".main-workspace", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await snap(page, "05-03-flow-designer", "5 协同与审批", "审批流设计器（画布）", "sysadmin");
  }
  // 04 项目流页签 pm
  await login(page, "wangbaozhuo@lexflow.demo");
  const pid = await firstProjectId(page);
  await nav(page, `/projects/${pid}/flows`, ".main-workspace");
  await snap(page, "05-04-project-flows", "5 协同与审批", "项目内审批流页签", "project_manager");
  // 05 通用申请单 member
  await login(page, "guanchen@lexflow.demo");
  await nav(page, "/requests", ".main-workspace");
  await tap(page.getByRole("button", { name: "发起申请" }).first());
  await page.waitForSelector("[role='dialog']", { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(900);
  await snap(page, "05-05-generic-request", "5 协同与审批", "通用申请单（发起弹窗，未提交）", "member");
  await page.keyboard.press("Escape").catch(() => {});
});

test("财务 6 张（ch6）", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "guojingwen@lexflow.demo");
  await nav(page, "/operations/receipts", ".main-workspace");
  await snap(page, "06-01-receipts", "6 经营与财务", "收款台账", "finance");
  await nav(page, "/fin/receivables", ".main-workspace");
  await snap(page, "06-02-receivables", "6 经营与财务", "应收管理（账龄分桶）", "finance");
  await nav(page, "/fin/invoices", ".main-workspace");
  await snap(page, "06-03-invoices", "6 经营与财务", "发票中心", "finance");
  await nav(page, "/fin/project-costing", ".main-workspace");
  await snap(page, "06-04-project-costing", "6 经营与财务", "项目核算（成本三段）", "finance");
  await login(page, "zhaokai@lexflow.demo");
  await nav(page, "/admin", ".audit-tabs");
  await tap(page.getByRole("button", { name: "系统参数" }).first());
  await page.waitForTimeout(900);
  await snap(page, "06-05-system-params", "6 经营与财务", "系统参数（成本率等白名单键）", "sysadmin");
  await login(page, "guojingwen@lexflow.demo");
  await nav(page, "/operations/expenses", ".main-workspace");
  await snap(page, "06-06-expense-check", "6 经营与财务", "费用报销检查（财务视角）", "finance");
});

test("报表 5 张（ch7）", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "xuwenjing@lexflow.demo");
  await nav(page, "/reports", ".main-workspace");
  await snap(page, "07-01-reports-home", "7 报表中心", "报表工作台目录树", "operations");
  await nav(page, "/reports/project_costing", ".main-workspace");
  await snap(page, "07-02-report-costing", "7 报表中心", "项目收支核算表", "operations");
  await nav(page, "/reports/time_summary", ".main-workspace");
  await snap(page, "07-03-report-time", "7 报表中心", "工时汇总（三视角）", "operations");
  await nav(page, "/reports/opportunity_funnel", ".main-workspace");
  await snap(page, "07-04-report-funnel", "7 报表中心", "商机漏斗", "operations");
  await nav(page, "/reports/monthly_cashflow", ".main-workspace");
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 15_000 }).catch(() => null),
    tap(page.getByRole("button", { name: "导出 CSV" }).first()),
  ]);
  if (download) {
    await download.saveAs(path.join(ASSETS, "07-05-export-monthly_cashflow.csv"));
    manifest.push({ id: "07-05-export", file: "07-05-export-monthly_cashflow.csv", chapter: "7 报表中心", page: "月度收支导出 CSV 样例", role: "operations", viewport: "file" });
  }
  await page.waitForTimeout(600);
  await snap(page, "07-05-report-export", "7 报表中心", "报表导出（下载样例另存）", "operations");
});

test("治理 6 张（ch8）", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "zhaokai@lexflow.demo");
  await nav(page, "/admin/org/company", ".main-workspace");
  await snap(page, "08-01-org-company", "8 组织与系统治理", "公司信息", "sysadmin");
  await nav(page, "/admin/org/units", ".main-workspace");
  await snap(page, "08-02-org-units", "8 组织与系统治理", "部门树（拖拽调级）", "sysadmin");
  await nav(page, "/admin/org/members", ".main-workspace");
  await snap(page, "08-03-org-members", "8 组织与系统治理", "员工与主管链", "sysadmin");
  await nav(page, "/admin", ".audit-tabs");
  await tap(page.getByRole("button", { name: "审批流" }).first());
  await page.waitForTimeout(900);
  await snap(page, "08-04-admin-flows", "8 组织与系统治理", "审批流中心（系统级）", "sysadmin");
  await tap(page.getByRole("button", { name: "AI 配置" }).first());
  await page.waitForTimeout(900);
  await snap(page, "08-05-ai-config", "8 组织与系统治理", "AI 配置与全局用量（密钥脱敏）", "sysadmin");
  await tap(page.getByRole("button", { name: "数据纠正" }).first());
  await page.waitForTimeout(900);
  await snap(page, "08-06-data-correct", "8 组织与系统治理", "数据纠正（白名单字段）", "sysadmin");
});

test("AI/移动/权限对照/异常 9 张（ch9/10/11/13）", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // 09-01/02 小元桌面（member）
  await login(page, "guanchen@lexflow.demo");
  await nav(page, "/workbench", ".main-workspace");
  await page.waitForTimeout(1500);
  await snap(page, "09-01-ai-pet", "9 AI 助手小元", "小元宠物与提醒气泡（桌面）", "member");
  const pet = page.locator("img[alt*='元'], [class*='pet'], [class*='mascot']").first();
  await tapDispatch(pet);
  await page.waitForSelector('.overlay [role="dialog"], [class*="ai-panel"]', { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await snap(page, "09-02-ai-panel", "9 AI 助手小元", "小元对话面板（上下文预览）", "member");
  await page.keyboard.press("Escape").catch(() => {});
  // 10-01/02 移动 375×812
  const m = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await login(m, "guanchen@lexflow.demo");
  await nav(m, "/projects", ".topnav-groups");
  await snap(m, "10-01-mobile-projects", "10 移动端", "移动端项目卡片列表（375px）", "member", { viewport: "mobile-375x812" });
  await tap(m.getByRole("button", { name: "发起申请" }).first());
  await m.waitForSelector("[role='dialog']", { timeout: 6_000 }).catch(() => {});
  await m.waitForTimeout(800);
  await snap(m, "10-02-mobile-dialog", "10 移动端", "移动端全屏弹窗（375px）", "member", { viewport: "mobile-375x812" });
  await m.close();
  // 11-01 member 同形 404
  await login(page, "guanchen@lexflow.demo");
  await nav(page, "/crm/leads", ".main-workspace");
  await snap(page, "11-01-member-404", "11 角色权限矩阵", "member 直链 CRM 同形 404", "member");
  // 11-02 member 无财务可见权 note 卡
  await nav(page, "/reports/monthly_cashflow", ".main-workspace");
  await snap(page, "11-02-member-no-money", "11 角色权限矩阵", "member 月度收支=无财务可见权口径卡", "member");
  // 11-03 finance 无 CRM 可见权 note 卡
  await login(page, "guojingwen@lexflow.demo");
  await nav(page, "/reports/opportunity_funnel", ".main-workspace");
  await snap(page, "11-03-finance-no-crm", "11 角色权限矩阵", "finance 商机漏斗=无 CRM 可见权口径卡", "finance");
  // 13-01 真 404 页面不存在（业务对象同形）
  await login(page, "xuwenjing@lexflow.demo");
  await nav(page, "/projects/00000000-0000-4000-8000-000000000000", ".main-workspace");
  await snap(page, "13-01-not-found", "13 异常与常见问题", "业务对象同形 404（不存在或无权访问）", "operations");
  // 13-02 系统页无权限（member 撞 /admin）
  await login(page, "guanchen@lexflow.demo");
  await nav(page, "/admin", ".main-workspace");
  await snap(page, "13-02-no-permission", "13 异常与常见问题", "系统页无权限（角色徽标）", "member");
});

test.afterEach(async ({ }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) console.log(`[manual-capture] 章节失败（不阻断后续）：${testInfo.title}`);
});
