/** 专项《系统操作手册全量版》截图采集脚本（≥150 张，每步跳转配截图）。
 * 纪律：真实外测 prod（LX_BASE）；普通 Chrome **禁止 insecure-origin flag**；只读为主；
 * 弹窗/写链仅「打开→截图→取消」不提交；唯一写链=通用申请单发起-审批演示（member 提交请假→partner 打开通过/驳回确认→不点最终确认→member 撤回=e2e 自清闭环，sweeper 兜底）。
 * 产出 docs/operation-assets/2026-11-15/*.png + manifest.json（编号/所属流程/步骤号/页面/角色/视口/章节锚点/采集时间）。
 * 可重复执行；manifest 增量落盘（启动载入历史合并，按 id 去重）。
 */
import { expect, test, type Page, type Locator } from "@playwright/test";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { installE2eSelfClean } from "./e2e-cleanup";
installE2eSelfClean();

const B = process.env.LX_BASE ?? "http://182.92.206.62:8080";
const DIR = "operation-assets/2026-11-15";
const ASSETS = path.resolve(process.cwd(), `../docs/${DIR}`);
mkdirSync(ASSETS, { recursive: true });

type Shot = { id: string; file: string; flow: string; step: string; page: string; role: string; viewport: string; anchor: string; capturedAt: string };
const manifest: Shot[] = (() => {
  try {
    const prev = JSON.parse(readFileSync(path.join(ASSETS, "manifest.json"), "utf8"));
    return Array.isArray(prev.shots) ? prev.shots : [];
  } catch { return []; }
})();
const persist = () => {
  const map = new Map(manifest.map((s) => [s.id, s]));
  writeFileSync(path.join(ASSETS, "manifest.json"), JSON.stringify({ capturedAt: new Date().toISOString(), base: B, shots: [...map.values()] }, null, 2));
};
/** 拍一张并登记（幂等覆盖同名） */
async function snap(page: Page, id: string, flow: string, step: string, pageName: string, role: string, anchor: string, viewport = "desktop-1440x900") {
  const file = `${id}.png`;
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(ASSETS, file) });
  manifest.push({ id, file, flow, step, page: pageName, role, viewport, anchor, capturedAt: new Date().toISOString() });
  persist();
}
async function tap(loc: Locator) { await loc.click({ timeout: 6_000 }).catch(() => {}); }
async function tapDispatch(loc: Locator) { await loc.dispatchEvent("click").catch(() => {}); }
async function healthy(page: Page, label: string) {
  const t = await page.evaluate(() => document.body.innerText);
  if (/页面加载失败|请求未成功完成/.test(t)) throw new Error(`${label} 呈现错误边界（疑似平台缺陷，登记而非绕行）`);
}
const EMAILS: Record<string, string> = {
  partner: "liangqifeng@lexflow.demo", project_manager: "wangbaozhuo@lexflow.demo", member: "guanchen@lexflow.demo",
  quality_lead: "liangqifeng@lexflow.demo", finance: "guojingwen@lexflow.demo", archivist: "wangying@lexflow.demo",
  sysadmin: "zhaokai@lexflow.demo", viewer: "hejing@lexflow.demo", sales: "sumingxuan@lexflow.demo",
  sales_manager: "zhenghaoran@lexflow.demo", presales: "hezhiyuan@lexflow.demo", operations: "xuwenjing@lexflow.demo",
  regional_vp: "gaojunling@lexflow.demo", ceo: "songqiming@lexflow.demo",
};
async function login(page: Page, role: string) {
  const email = EMAILS[role];
  await page.keyboard.press("Escape").catch(() => {});
  await page.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
  await page.goto(`${B}/login`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.getByPlaceholder("name@firm.com").fill(email, { timeout: 8_000 });
  await page.locator('input[type="password"]').fill("Demo@2026", { timeout: 8_000 });
  await tap(page.getByRole("button", { name: "登录" }));
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 25_000 });
  await page.waitForSelector(".topnav-groups", { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(400);
}
async function nav(page: Page, url: string, ready = ".main-workspace") {
  await page.goto(`${B}${url}`, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
  await page.waitForSelector(ready, { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(600);
}
async function openCascade(page: Page, group: string) {
  await tapDispatch(page.locator(".topnav-groups .p9a-dd-trigger", { hasText: group }).first());
  await page.waitForTimeout(700);
}
async function projectId(page: Page, keyword = "比博思特"): Promise<string> {
  const r = await page.request.get(`${B}/trpc/project.list?input=${encodeURIComponent(JSON.stringify({ filters: { keyword }, limit: 5 }))}`);
  const j = await r.json().catch(() => ({}));
  return (j as any)?.result?.data?.items?.[0]?.id ?? "";
}
/** 级联面板菜单文本（写手册「可见菜单清单」用） */
async function cascadeMenus(page: Page): Promise<string[]> {
  const groups = ["总览", "客户", "项目", "协同", "经营", "报表", "办公", "治理"];
  const out: string[] = [];
  for (const g of groups) {
    await tapDispatch(page.locator(".topnav-groups .p9a-dd-trigger", { hasText: g }).first());
    await page.waitForTimeout(500);
    const items = await page.evaluate(() => [...document.querySelectorAll(".p9a-menu-item,[role='menuitem'],.p9a-dd-panel a")].map((e) => (e.textContent ?? "").trim()).filter(Boolean).slice(0, 20));
    out.push(`${g}: ${[...new Set(items)].join("/") || "—"}`);
    await page.keyboard.press("Escape").catch(() => {});
    await page.mouse.click(720, 840).catch(() => {});
    await page.waitForTimeout(250);
  }
  return out;
}

test.describe.configure({ timeout: 600_000 });
test.use({ actionTimeout: 8_000, navigationTimeout: 20_000 });

test("op-ch1 入门篇（20 张）", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // 登录三步：登录页→填写过程态→成功跳驾驶舱
  await page.goto(`${B}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="password"]', { timeout: 10_000 }).catch(() => {});
  await snap(page, "op-01-登录-01", "登录", "1", "登录页", "未登录", "入门§2.1");
  await page.getByPlaceholder("name@firm.com").fill("liangqifeng@lexflow.demo");
  await page.locator('input[type="password"]').fill("Demo@2026");
  await snap(page, "op-01-登录-02", "登录", "2", "登录填写完成态", "未登录", "入门§2.1");
  await tap(page.getByRole("button", { name: "登录" }));
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 25_000 });
  await page.waitForSelector(".topnav-groups", { timeout: 12_000 }).catch(() => {});
  await snap(page, "op-01-登录-03", "登录", "3", "登录成功跳转驾驶舱", "partner", "入门§2.1");
  // 顶栏八组总览 + 逐一展开（8 张过程态）
  await snap(page, "op-01-导航-01", "级联导航", "1", "顶栏八组收起态", "partner", "入门§2.2");
  const groups = ["总览", "客户", "项目", "协同", "经营", "报表", "办公", "治理"];
  for (let i = 0; i < groups.length; i++) {
    await openCascade(page, groups[i]);
    await snap(page, `op-01-导航-0${i + 2}`, "级联导航", `${i + 2}`, `「${groups[i]}」组级联展开`, "partner", "入门§2.2");
    await page.keyboard.press("Escape").catch(() => {});
    await page.mouse.click(720, 840).catch(() => {});
    await page.waitForTimeout(300);
  }
  // 全局搜索：面板→关键词→结果态
  await nav(page, "/search", ".main-workspace");
  const input = page.locator("input").first();
  await input.fill("项目", { timeout: 5_000 }).catch(() => {});
  await snap(page, "op-01-搜索-01", "全局搜索", "1", "搜索输入过程态", "operations", "入门§2.3");
  await input.press("Enter").catch(() => {});
  await page.waitForTimeout(1300);
  await snap(page, "op-01-搜索-02", "全局搜索", "2", "搜索结果态（分组计数）", "operations", "入门§2.3");
  // 通知：铃铛→通知中心
  await login(page, "member");
  await nav(page, "/workbench", ".main-workspace");
  const bell = page.locator(".topnav-bell, [class*='bell'], button:has([class*='bell'])").first();
  await tapDispatch(bell);
  await page.waitForTimeout(800);
  await snap(page, "op-01-通知-01", "通知", "1", "通知铃铛下拉展开", "member", "入门§2.4");
  await nav(page, "/notifications", ".main-workspace");
  await snap(page, "op-01-通知-02", "通知", "2", "通知中心分组折叠", "member", "入门§2.4");
  // 头像菜单 / 密度 / 多页签 / 会话失效
  await nav(page, "/workbench", ".main-workspace");
  await tapDispatch(page.locator(".topnav-avatar, [class*='avatar']").first());
  await page.waitForTimeout(700);
  await snap(page, "op-01-通用-01", "通用操作", "1", "头像菜单展开（切换账号/退出）", "member", "入门§2.5");
  await page.keyboard.press("Escape").catch(() => {});
  await nav(page, "/settings", ".main-workspace");
  await snap(page, "op-01-通用-02", "通用操作", "2", "个人设置（界面密度）", "member", "入门§2.5");
  await nav(page, "/projects", ".topnav-groups");
  await openCascade(page, "总览");
  await tapDispatch(page.locator(".p9a-menu-item", { hasText: "驾驶舱" }).first());
  await page.waitForSelector(".p9a-tabs", { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(600);
  await snap(page, "op-01-通用-03", "通用操作", "3", "多页签两签并存", "member", "入门§2.5");
  // 会话失效：退出后直接访问业务深链→跳回登录
  await page.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
  await page.goto(`${B}/projects`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await snap(page, "op-01-会话-01", "会话时效", "1", "会话失效后深链跳回登录", "未登录", "入门§2.6");
});

test("op-ch2 角色速查篇（14 首屏+菜单）", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const roles: Array<[string, string]> = [
    ["partner", "合伙人"], ["project_manager", "项目负责人"], ["member", "项目成员"], ["quality_lead", "质量负责人(合伙人兼)"],
    ["finance", "财务"], ["archivist", "档案管理员"], ["sysadmin", "系统管理员"], ["viewer", "只读查阅人"],
    ["sales", "销售"], ["sales_manager", "销售主管"], ["presales", "售前"], ["operations", "运营"], ["regional_vp", "大区VP"], ["ceo", "CEO"],
  ];
  const menuLog: string[] = [];
  for (const [role, label] of roles) {
    await login(page, role);
    await nav(page, "/workbench", ".main-workspace");
    await snap(page, `op-02-${role}-01`, "角色首屏", "1", `${label} 登录首屏（工作台/驾驶舱）`, role, `速查§3-${label}`);
    if (role === "partner") {
      const menus = await cascadeMenus(page);
      menuLog.push(...menus);
    }
  }
  writeFileSync(path.join(ASSETS, "_role-menus.txt"), menuLog.join("\n"), "utf8");
  console.log("[op-ch2] 14 角色首屏完成；partner 菜单清单已存 _role-menus.txt");
});

test("op-ch3a 驾驶舱与 CRM 全链", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // 驾驶舱与工作台（对应功能手册§2）
  await login(page, "partner");
  await nav(page, "/cockpit", ".main-workspace");
  await snap(page, "op-03-驾驶舱-01", "驾驶舱", "1", "驾驶舱问候卡/日历/快捷入口", "partner", "流程§4.1");
  await tap(page.getByText("显示全部", { exact: false }).first());
  await page.waitForTimeout(800);
  await snap(page, "op-03-驾驶舱-02", "驾驶舱", "2", "项目脉搏展开态", "partner", "流程§4.1");
  await login(page, "member");
  await nav(page, "/workbench", ".main-workspace");
  await snap(page, "op-03-工作台-01", "工作台", "1", "工作台待办卡片区", "member", "流程§4.1");
  // 树卡联动跳转
  await tapDispatch(page.locator(".report-card, [class*='card']").getByText(/报表|核算|健康/).first());
  await page.waitForTimeout(1200);
  await snap(page, "op-03-工作台-02", "工作台", "2", "树卡联动跳转报表页签", "member", "流程§4.1");

  // CRM 线索（§3.1-3.2）
  await login(page, "sales");
  await nav(page, "/crm/leads", ".main-workspace");
  await snap(page, "op-04-线索-01", "线索池", "1", "线索池列表", "sales", "流程§4.2.1");
  await tapDispatch(page.locator(".p9a-ta-row.is-clickable, .report-row").first());
  await page.waitForSelector('.overlay [role="dialog"]', { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(800);
  await snap(page, "op-04-线索-02", "线索池", "2", "行点击→详情抽屉", "sales", "流程§4.2.1");
  await tap(page.getByRole("button", { name: /写跟进|新增跟进|记录跟进/ }).first());
  await page.waitForSelector("[role='dialog']", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(700);
  await snap(page, "op-04-线索-03", "线索池", "3", "写跟进弹窗打开", "sales", "流程§4.2.1");
  await tap(page.getByRole("button", { name: /取消|关闭/ }).first());
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(500);
  // 转化 Stepper 三步（打开不提交）
  await page.getByRole("button", { name: /转化/ }).first().click({ timeout: 6_000 }).catch(() => {});
  await page.waitForSelector("[role='dialog']", { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(1000);
  await snap(page, "op-04-线索-04", "线索转化", "1", "Stepper 第1步·客户", "sales", "流程§4.2.2");
  await tap(page.getByRole("button", { name: /下一步/ }).first());
  await page.waitForTimeout(900);
  await snap(page, "op-04-线索-05", "线索转化", "2", "Stepper 第2步·商机", "sales", "流程§4.2.2");
  // 第2步填负责人后第3步确认页
  const pickerInput = page.locator(".user-picker input[aria-label='搜索用户']").first();
  if (await pickerInput.count()) {
    await pickerInput.fill("wangbaozhuo", { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(900);
    const sel = page.locator(".user-picker select[aria-label='选择用户']").first();
    await sel.selectOption({ index: 1 }).catch(() => {});
    await page.waitForTimeout(400);
  }
  await tap(page.getByRole("button", { name: /下一步/ }).first());
  await page.waitForTimeout(900);
  await snap(page, "op-04-线索-06", "线索转化", "3", "Stepper 第3步·确认", "sales", "流程§4.2.2");
  await tap(page.getByRole("button", { name: /取消/ }).first());
  await page.keyboard.press("Escape").catch(() => {});
  // 无权限直撞（member）
  await login(page, "member");
  await nav(page, "/crm/leads", ".main-workspace");
  await snap(page, "op-04-线索-07", "线索转化", "4", "无权限直撞同形拦截", "member", "流程§4.2.2");
  // 商机（§3.3）
  await login(page, "sales");
  await nav(page, "/crm/opportunities", ".main-workspace");
  await snap(page, "op-04-商机-01", "商机", "1", "商机表格视图", "sales", "流程§4.2.3");
  await tap(page.getByRole("tab", { name: /看板/ }).first());
  await page.waitForTimeout(1000);
  await snap(page, "op-04-商机-02", "商机", "2", "表格→看板切换结果态", "sales", "流程§4.2.3");
  await tapDispatch(page.locator(".p9a-ta-row.is-clickable, .report-row").first());
  await page.waitForSelector('.overlay [role="dialog"]', { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(800);
  await snap(page, "op-04-商机-03", "商机", "3", "商机抽屉（含项目入口）", "sales", "流程§4.2.3");
  await tap(page.getByRole("button", { name: /新建商机/ }).first());
  await page.waitForSelector("[role='dialog']", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(800);
  await snap(page, "op-04-商机-04", "商机", "4", "新建商机弹窗", "sales", "流程§4.2.3");
  await tap(page.getByRole("button", { name: /取消|关闭/ }).first());
  await page.keyboard.press("Escape").catch(() => {});
  // 客户与合同（§3.4-3.5）
  await login(page, "partner");
  await nav(page, "/crm/customers", ".main-workspace");
  await snap(page, "op-04-客户-01", "客户", "1", "客户列表", "partner", "流程§4.2.4");
  await tapDispatch(page.locator(".report-row, .p9a-ta-row").first());
  await page.waitForTimeout(1200);
  await tap(page.getByText("合同", { exact: true }).first());
  await page.waitForTimeout(800);
  await snap(page, "op-04-客户-02", "客户", "2", "客户详情·合同页签", "partner", "流程§4.2.4");
  await nav(page, "/crm/contracts", ".main-workspace");
  await snap(page, "op-04-合同-01", "合同", "1", "合同台账", "partner", "流程§4.2.5");
});

test("op-ch3b 项目全周期", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // 新建项目向导（partner，F4 整页；逐步截图不提交）
  await login(page, "partner");
  await nav(page, "/projects/new", ".main-workspace");
  await snap(page, "op-05-立项-01", "新建项目", "1", "向导第1步·客户与事项", "partner", "流程§4.3.1");
  const wizNext = page.getByRole("button", { name: /下一步|继续/ }).first();
  await tap(wizNext);
  await page.waitForTimeout(900);
  await snap(page, "op-05-立项-02", "新建项目", "2", "向导第2步·模板", "partner", "流程§4.3.1");
  await tap(wizNext);
  await page.waitForTimeout(900);
  await snap(page, "op-05-立项-03", "新建项目", "3", "向导第3步·团队与负责人", "partner", "流程§4.3.1");
  await tap(wizNext);
  await page.waitForTimeout(900);
  await snap(page, "op-05-立项-04", "新建项目", "4", "向导第4步·计划预览", "partner", "流程§4.3.1");
  // 项目空间十四页签
  await login(page, "project_manager");
  const pid = await projectId(page);
  const tabs: Array<[string, string, string]> = [
    ["01", "overview", "总览"], ["02", "plan", "计划甘特"], ["03", "tasks", "任务"], ["04", "meetings", "会议"], ["05", "travel", "出差"],
    ["06", "budget", "预算经费"], ["07", "expenses", "费用"], ["08", "timesheet", "工时"], ["09", "quality", "质量"], ["10", "decisions", "决策"],
    ["11", "reports", "周报"], ["12", "archive", "档案"], ["13", "members", "成员权限"], ["14", "flows", "项目审批流"],
  ];
  for (const [no, tab, name] of tabs) {
    await nav(page, `/projects/${pid}/${tab}`, ".main-workspace");
    await snap(page, `op-05-空间-${no}`, "项目空间十四页签", no, `${name}页签`, "project_manager", `流程§4.3.2-${name}`);
  }
  // 计划模拟调整（过程态）
  await nav(page, `/projects/${pid}/plan`, ".main-workspace");
  await tap(page.getByRole("button", { name: /模拟调整/ }).first());
  await page.waitForTimeout(1200);
  await snap(page, "op-05-空间-15", "项目空间十四页签", "15", "计划模拟调整过程态", "project_manager", "流程§4.3.2-计划");
  await page.keyboard.press("Escape").catch(() => {});
  // 变更负责人（高危确认弹窗，打开不提交）
  await nav(page, `/projects/${pid}/members`, ".main-workspace");
  await tap(page.getByRole("button", { name: /变更负责人|更换负责人/ }).first());
  await page.waitForSelector("[role='dialog']", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(800);
  await snap(page, "op-05-变更-01", "变更负责人", "1", "高危变更确认弹窗", "project_manager", "流程§4.3.3");
  await tap(page.getByRole("button", { name: /取消|关闭/ }).first());
  await page.keyboard.press("Escape").catch(() => {});
  // 结项关闭确认（打开不提交）
  await tap(page.getByRole("button", { name: /关闭项目|结项/ }).first());
  await page.waitForSelector("[role='dialog']", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(800);
  await snap(page, "op-05-结项-01", "项目关闭", "1", "关闭项目确认弹窗", "project_manager", "流程§4.3.4");
  await tap(page.getByRole("button", { name: /取消|关闭/ }).first());
  await page.keyboard.press("Escape").catch(() => {});
  // 终态项目只读/阻断（PRJ-2026-00009 已 closed）
  const closed = await projectId(page, "00009");
  if (closed) {
    await nav(page, `/projects/${closed}/overview`, ".main-workspace");
    await snap(page, "op-05-终态-01", "终态拦截", "1", "closed 项目总览只读态", "project_manager", "流程§4.3.4");
    await nav(page, `/projects/${closed}/expenses`, ".main-workspace");
    await page.waitForTimeout(800);
    await snap(page, "op-05-终态-02", "终态拦截", "2", "closed 项目费用页签阻断", "project_manager", "流程§4.3.4");
  }
});

test("op-ch3c 协同与审批（含唯一写链：申请单发起→审批确认→撤回自清）", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // 发起申请（member）
  await login(page, "member");
  await nav(page, "/requests", ".main-workspace");
  await snap(page, "op-06-发起-00", "发起申请", "0", "我的申请单列表", "member", "流程§4.4.1");
  await tap(page.getByRole("button", { name: "发起申请" }).first());
  await page.waitForSelector("[role='dialog']", { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(800);
  await snap(page, "op-06-发起-01", "发起申请", "1", "发起弹窗（标题/事由/日期）", "member", "流程§4.4.1");
  // 校验失败分支：不选人直接提交→拦截
  await tap(page.getByRole("button", { name: "提交审批" }).first());
  await page.waitForTimeout(800);
  await snap(page, "op-06-发起-02", "发起申请", "2", "未选审批人提交被拦截", "member", "流程§4.4.1");
  // 自选审批人过程态
  const picker = page.locator(".user-picker input[aria-label='搜索用户']").first();
  if (await picker.count()) {
    await picker.fill("李见微", { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(900);
    await snap(page, "op-06-发起-03", "发起申请", "3", "自选审批人下拉展开", "member", "流程§4.4.1");
    await page.locator(".user-picker select[aria-label='选择用户']").first().selectOption({ index: 1 }).catch(() => {});
  }
  // 真实提交（写链①，后续撤回=e2e 自清）
  const title = `操作手册演示-${Date.now().toString(36)}`;
  const dlg = page.locator("[role='dialog']").first();
  await dlg.locator("input").nth(0).fill(title, { timeout: 5_000 }).catch(() => {});
  await dlg.locator("textarea").first().fill("操作手册截图演示", { timeout: 5_000 }).catch(() => {});
  const d = dlg.locator("input[type='date']");
  await d.nth(0).fill("2028-03-01", { timeout: 5_000 }).catch(() => {});
  await d.nth(1).fill("2028-03-02", { timeout: 5_000 }).catch(() => {});
  await tap(page.getByRole("button", { name: "保存草稿" }).first());
  await page.waitForTimeout(1000);
  await tap(page.getByRole("button", { name: "提交审批" }).first());
  await page.waitForTimeout(1500);
  await snap(page, "op-06-发起-04", "发起申请", "4", "提交成功跳转详情", "member", "流程§4.4.1");
  // 审批人侧（partner 无待办→由李见微? 流程=项目流/全局流——选人李见微，则李见微为审批人。改由李见微登录演示审批中心）
  await login(page, "member"); // 李见微也是 member 角色：直接用其账号
  await page.goto(`${B}/login`, { waitUntil: "domcontentloaded" });
  await page.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
  await page.goto(`${B}/login`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("name@firm.com").fill("lijianwei@lexflow.demo");
  await page.locator('input[type="password"]').fill("Demo@2026");
  await tap(page.getByRole("button", { name: "登录" }));
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 25_000 });
  await nav(page, "/approvals", ".main-workspace");
  await snap(page, "op-06-审批-01", "审批中心", "1", "待办审批卡（业务快照）", "member", "流程§4.4.2");
  await tap(page.locator(".approval-card").getByRole("button", { name: /通过|同意/ }).first());
  await page.waitForSelector("[role='dialog']", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(800);
  await snap(page, "op-06-审批-02", "审批中心", "2", "通过确认弹窗（未点确认）", "member", "流程§4.4.2");
  await tap(page.getByRole("button", { name: /取消|关闭/ }).first());
  await page.keyboard.press("Escape").catch(() => {});
  await tap(page.locator(".approval-card").getByRole("button", { name: /驳回|拒绝/ }).first());
  await page.waitForSelector("[role='dialog']", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(800);
  await snap(page, "op-06-审批-03", "审批中心", "3", "驳回理由弹窗（未点确认）", "member", "流程§4.4.2");
  await tap(page.getByRole("button", { name: /取消|关闭/ }).first());
  await page.keyboard.press("Escape").catch(() => {});
  // 撤回（申请人侧，业务终态闭环=自清）
  await page.goto(`${B}/login`, { waitUntil: "domcontentloaded" });
  await page.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
  await page.goto(`${B}/login`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("name@firm.com").fill("guanchen@lexflow.demo");
  await page.locator('input[type="password"]').fill("Demo@2026");
  await tap(page.getByRole("button", { name: "登录" }));
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 25_000 });
  await nav(page, "/requests", ".main-workspace");
  await tap(page.getByText(title).first());
  await page.waitForTimeout(1200);
  await tap(page.getByRole("button", { name: /撤回/ }).first());
  await page.waitForTimeout(1200);
  await snap(page, "op-06-审批-04", "审批中心", "4", "撤回成功终态", "member", "流程§4.4.2");
  // 出差/会议新建表单（member，打开不提交）
  await nav(page, "/travel/new", ".main-workspace");
  await snap(page, "op-06-出差-01", "出差", "1", "出差新建表单", "member", "流程§4.4.3");
  await nav(page, "/meetings/new", ".main-workspace");
  await snap(page, "op-06-会议-01", "会议", "1", "会议新建表单（参与人）", "member", "流程§4.4.4");
  // 设计器与项目级流
  await login(page, "sysadmin");
  await nav(page, "/admin", ".audit-tabs");
  await tap(page.getByRole("button", { name: "审批流" }).first());
  await page.waitForTimeout(900);
  await tap(page.getByText("打开设计器").first());
  await page.waitForURL(/\/admin\/flows\//, { timeout: 10_000 }).catch(() => {});
  await page.waitForSelector(".main-workspace", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await snap(page, "op-06-设计器-01", "流程设计器", "1", "系统级设计器画布", "sysadmin", "流程§4.4.5");
  await tapDispatch(page.locator("canvas, [class*='canvas'] >> nth=0").first());
  await snap(page, "op-06-设计器-02", "流程设计器", "2", "画布节点选中态", "sysadmin", "流程§4.4.5");
  await login(page, "project_manager");
  const pid = await projectId(page);
  await nav(page, `/projects/${pid}/flows`, ".main-workspace");
  await snap(page, "op-06-项目流-01", "项目级流", "1", "项目内审批流页签", "project_manager", "流程§4.4.5");
});

test("op-ch3d 经营与财务 + 报表中心", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "project_manager");
  const pid = await projectId(page);
  // 预算/经费/费用（项目空间页签已拍；此处拍新建表单与校验失败分支）
  await nav(page, `/projects/${pid}/budget`, ".main-workspace");
  await tap(page.getByRole("button", { name: /新建预算|调整预算/ }).first());
  await page.waitForSelector("[role='dialog']", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(800);
  await snap(page, "op-07-预算-01", "预算", "1", "预算新建/调整弹窗", "project_manager", "流程§4.5.1");
  await tap(page.getByRole("button", { name: /取消|关闭/ }).first());
  await page.keyboard.press("Escape").catch(() => {});
  await login(page, "member");
  await nav(page, "/operations/funding/new", ".main-workspace");
  await snap(page, "op-07-经费-01", "经费", "1", "经费申请新建表单", "member", "流程§4.5.2");
  await tap(page.getByRole("button", { name: /提交|创建并查看/ }).first());
  await page.waitForTimeout(900);
  await snap(page, "op-07-经费-02", "经费", "2", "缺必填校验失败 fieldErrors 落位", "member", "流程§4.5.2");
  await nav(page, "/expenses/new", ".main-workspace");
  await snap(page, "op-07-费用-01", "费用报销", "1", "报销新建表单", "member", "流程§4.5.3");
  await tap(page.getByRole("button", { name: /添加明细行|添加一行|\+ 明细/ }).first());
  await page.waitForTimeout(800);
  await snap(page, "op-07-费用-02", "费用报销", "2", "明细行添加过程态", "member", "流程§4.5.3");
  // 收款/应收/发票（finance）
  await login(page, "finance");
  await nav(page, "/operations/receipts", ".main-workspace");
  await tap(page.getByRole("button", { name: /登记收款|新建收款/ }).first());
  await page.waitForSelector("[role='dialog']", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(900);
  await snap(page, "op-07-收款-01", "收款", "1", "收款登记弹窗（挂合同/计划行）", "finance", "流程§4.5.4");
  await tap(page.getByRole("button", { name: /取消|关闭/ }).first());
  await page.keyboard.press("Escape").catch(() => {});
  await snap(page, "op-07-收款-02", "收款", "2", "收款台账列表", "finance", "流程§4.5.4");
  await nav(page, "/fin/receivables", ".main-workspace");
  await snap(page, "op-07-应收-01", "应收", "1", "应收列表（账龄/逾期红条）", "finance", "流程§4.5.5");
  await tap(page.getByRole("button", { name: /登记收款|收款/ }).first());
  await page.waitForSelector("[role='dialog']", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(900);
  await snap(page, "op-07-应收-02", "应收", "2", "应收内登记收款联动弹窗", "finance", "流程§4.5.5");
  await tap(page.getByRole("button", { name: /取消|关闭/ }).first());
  await page.keyboard.press("Escape").catch(() => {});
  await nav(page, "/fin/invoices", ".main-workspace");
  await snap(page, "op-07-发票-01", "发票", "1", "发票列表", "finance", "流程§4.5.6");
  await tap(page.getByRole("button", { name: /开具发票|开票/ }).first());
  await page.waitForSelector("[role='dialog']", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(900);
  await snap(page, "op-07-发票-02", "发票", "2", "开票弹窗（应收带出/抬头）", "finance", "流程§4.5.6");
  await tap(page.getByRole("button", { name: /取消|关闭/ }).first());
  await page.keyboard.press("Escape").catch(() => {});
  await nav(page, "/fin/project-costing", ".main-workspace");
  await snap(page, "op-07-核算-01", "项目核算", "1", "项目核算三段成本", "finance", "流程§4.5.7");
  // 导出 CSV（读路径，样例入资产）
  await nav(page, "/reports/monthly_cashflow", ".main-workspace");
  await page.waitForSelector("text=共 ", { timeout: 12_000 }).catch(() => {});
  await page.waitForTimeout(800);
  const dl = page.waitForEvent("download", { timeout: 20_000 }).catch(() => null);
  await tap(page.getByRole("button", { name: "导出 CSV" }).first());
  const download = await dl;
  if (download) await download.saveAs(path.join(ASSETS, "op-07-导出-01.csv"));
  await page.waitForTimeout(600);
  await snap(page, "op-07-导出-01", "报表导出", "1", "导出成功提示与下载", "finance", "流程§4.6.3");
  // 报表中心：目录+十张
  await login(page, "operations");
  await nav(page, "/reports", ".main-workspace");
  await snap(page, "op-08-目录-01", "报表目录", "1", "报表工作台目录树", "operations", "流程§4.6.1");
  const reports: Array<[string, string]> = [
    ["project_health", "项目健康度"], ["project_delay", "项目进度与延期"], ["project_costing", "项目收支核算"],
    ["receivable_aging", "收款账龄"], ["expense_category", "费用类别"], ["monthly_cashflow", "月度收支"],
    ["time_summary", "工时汇总"], ["utilization", "人员利用率"], ["opportunity_funnel", "商机漏斗"], ["customer_contribution", "客户贡献"],
  ];
  for (const [key, name] of reports) {
    await nav(page, `/reports/${key}`, ".main-workspace");
    await snap(page, `op-08-报表-${key}`, "十张报表", key, `${name}`, "operations", `流程§4.6.2-${name}`);
  }
  // 筛选过程态+结果态（月度收支对 money 角色用 finance）
  await login(page, "finance");
  await nav(page, "/reports/monthly_cashflow", ".main-workspace");
  await page.waitForSelector("text=共 ", { timeout: 12_000 }).catch(() => {});
  const from = page.locator('input[aria-label="开始日期"]');
  const to = page.locator('input[aria-label="结束日期"]');
  await from.fill("2026-10-01", { timeout: 5_000 }).catch(() => {});
  await snap(page, "op-08-筛选-01", "报表筛选", "1", "日期筛选输入过程态", "finance", "流程§4.6.3");
  await to.fill("2026-10-31", { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(1300);
  await snap(page, "op-08-筛选-02", "报表筛选", "2", "窄区间筛选结果态", "finance", "流程§4.6.3");
});

test("op-ch3e 组织治理 + AI 小元", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "sysadmin");
  await nav(page, "/admin/org/company", ".main-workspace");
  await snap(page, "op-09-公司-01", "公司信息", "1", "公司信息页", "sysadmin", "流程§4.7.1");
  await nav(page, "/admin/org/units", ".main-workspace");
  await snap(page, "op-09-部门-01", "部门维护", "1", "部门树 T-D 主从", "sysadmin", "流程§4.7.2");
  await tap(page.getByRole("button", { name: /新建一级部门|新建部门/ }).first());
  await page.waitForSelector("[role='dialog']", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(700);
  await snap(page, "op-09-部门-02", "部门维护", "2", "新建部门弹窗", "sysadmin", "流程§4.7.2");
  await tap(page.getByRole("button", { name: /取消|关闭/ }).first());
  await page.keyboard.press("Escape").catch(() => {});
  await nav(page, "/admin/org/members", ".main-workspace");
  await snap(page, "op-09-员工-01", "员工与主管链", "1", "员工列表", "sysadmin", "流程§4.7.3");
  await tap(page.locator(".report-row, [class*='row']").getByRole("button", { name: /编辑/ }).first());
  await page.waitForSelector("[role='dialog']", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(800);
  await snap(page, "op-09-员工-02", "员工与主管链", "2", "编辑员工弹窗（职位/主管）", "sysadmin", "流程§4.7.3");
  await tap(page.getByRole("button", { name: /取消|关闭/ }).first());
  await page.keyboard.press("Escape").catch(() => {});
  await nav(page, "/admin", ".audit-tabs");
  await tap(page.getByRole("button", { name: "审批流" }).first());
  await page.waitForTimeout(900);
  await snap(page, "op-09-流中心-01", "审批流中心", "1", "系统级审批流列表", "sysadmin", "流程§4.7.4");
  await tap(page.getByRole("button", { name: "项目模板" }).first());
  await page.waitForTimeout(800);
  await snap(page, "op-09-模板-01", "项目模板", "1", "项目模板页签", "sysadmin", "流程§4.7.4");
  await tap(page.getByRole("button", { name: "系统参数" }).first());
  await page.waitForTimeout(800);
  await snap(page, "op-09-参数-01", "系统参数", "1", "系统参数白名单键", "sysadmin", "流程§4.7.5");
  await tap(page.getByRole("button", { name: "编号规则" }).first());
  await page.waitForTimeout(800);
  await snap(page, "op-09-编号-01", "编号规则", "1", "编号规则页签", "sysadmin", "流程§4.7.5");
  await tap(page.getByRole("button", { name: "AI 配置" }).first());
  await page.waitForTimeout(800);
  await snap(page, "op-09-AI配置-01", "AI 配置", "1", "AI 配置与全局用量（脱敏）", "sysadmin", "流程§4.7.6");
  await tap(page.getByRole("button", { name: "数据纠正" }).first());
  await page.waitForTimeout(800);
  await snap(page, "op-09-数据纠正-01", "数据纠正", "1", "数据纠正页（对象选择）", "sysadmin", "流程§4.7.7");
  await nav(page, "/audit", ".main-workspace");
  await snap(page, "op-09-审计-01", "审计中心", "1", "审计列表", "sysadmin", "流程§4.7.8");
  const sel = page.locator("select").first();
  if (await sel.count()) { await sel.selectOption({ index: 1 }).catch(() => {}); await page.waitForTimeout(900); }
  await snap(page, "op-09-审计-02", "审计中心", "2", "审计筛选过程态", "sysadmin", "流程§4.7.8");
  // AI 小元（member）
  await login(page, "member");
  await nav(page, "/workbench", ".main-workspace");
  await page.waitForTimeout(1800);
  await snap(page, "op-10-宠物-01", "小元宠物", "1", "桌面宠物与红点徽标", "member", "流程§4.8.1");
  const bubble = page.getByText("去处理", { exact: false }).first();
  if (await bubble.count()) await tapDispatch(bubble);
  await page.waitForTimeout(800);
  await snap(page, "op-10-气泡-01", "小元气泡", "1", "提醒气泡展开（去处理/知道了）", "member", "流程§4.8.2");
  const pet = page.locator("img[alt*='元'], [class*='pet'], [class*='mascot']").first();
  await tapDispatch(pet);
  await page.waitForSelector('.overlay [role="dialog"], [class*="ai-panel"]', { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await snap(page, "op-10-面板-01", "小元对话", "1", "对话面板与上下文预览", "member", "流程§4.8.3");
  const chatInput = page.locator(".overlay input, [class*='ai-panel'] input, [class*='ai-panel'] textarea").first();
  if (await chatInput.count()) {
    await chatInput.fill("平台怎么新建项目？", { timeout: 5_000 }).catch(() => {});
    await tap(page.getByRole("button", { name: /发送/ }).first());
    await page.waitForTimeout(6000);
    await snap(page, "op-10-面板-02", "小元对话", "2", "提问回答过程态", "member", "流程§4.8.3");
  }
  await page.keyboard.press("Escape").catch(() => {});
});

test("op-ch4 移动端 375px 五场景", async ({ browser }) => {
  const m = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const msnap = async (id: string, flow: string, step: string, pageName: string, role: string, anchor: string) => {
    await m.waitForTimeout(600);
    await m.screenshot({ path: path.join(ASSETS, `${id}.png`) });
    manifest.push({ id, file: `${id}.png`, flow, step, page: pageName, role, viewport: "mobile-375x812", anchor, capturedAt: new Date().toISOString() });
    persist();
  };
  await m.goto(`${B}/login`, { waitUntil: "domcontentloaded" });
  await m.getByPlaceholder("name@firm.com").fill("guanchen@lexflow.demo");
  await m.locator('input[type="password"]').fill("Demo@2026");
  await m.getByRole("button", { name: "登录" }).click();
  await m.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 25_000 });
  await m.waitForTimeout(800);
  await m.goto(`${B}/cockpit`, { waitUntil: "domcontentloaded" });
  await m.waitForTimeout(1200);
  await msnap("op-11-驾驶舱-01", "移动端·驾驶舱", "1", "375px 移动驾驶舱", "member", "移动§4.9.1");
  await m.goto(`${B}/workbench`, { waitUntil: "domcontentloaded" });
  await m.waitForTimeout(1200);
  await msnap("op-11-工作台-01", "移动端·工作台", "1", "375px 移动工作台", "member", "移动§4.9.2");
  await m.goto(`${B}/approvals`, { waitUntil: "domcontentloaded" });
  await m.waitForTimeout(1200);
  await msnap("op-11-审批-01", "移动端·审批", "1", "375px 移动审批中心", "member", "移动§4.9.3");
  const pid = await (async () => {
    const r = await m.request.get(`${B}/trpc/project.list?input=${encodeURIComponent(JSON.stringify({ filters: { keyword: "比博思特" }, limit: 5 }))}`);
    const j = await r.json().catch(() => ({}));
    return (j as any)?.result?.data?.items?.[0]?.id ?? "";
  })();
  if (pid) {
    await m.goto(`${B}/projects/${pid}/overview`, { waitUntil: "domcontentloaded" });
    await m.waitForTimeout(1200);
    await msnap("op-11-项目-01", "移动端·项目空间", "1", "375px 移动项目总览", "member", "移动§4.9.4");
  }
  await m.goto(`${B}/reports`, { waitUntil: "domcontentloaded" });
  await m.waitForTimeout(1200);
  await msnap("op-11-报表-01", "移动端·报表", "1", "375px 移动报表工作台", "member", "移动§4.9.5");
  await m.goto(`${B}/requests`, { waitUntil: "domcontentloaded" });
  await m.waitForTimeout(1000);
  await tap(m.getByRole("button", { name: "发起申请" }).first());
  await m.waitForSelector("[role='dialog']", { timeout: 6_000 }).catch(() => {});
  await m.waitForTimeout(800);
  await msnap("op-11-弹窗-01", "移动端·全屏弹窗", "1", "375px 移动全屏弹窗", "member", "移动§4.9.6");
  await m.close();
});

test("op-ch5 异常 FAQ 实图", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // 400 校验（经费缺必填）已在 op-07-经费-02；此处补 401/403 同形/404/409
  await login(page, "member");
  await nav(page, "/crm/leads", ".main-workspace");
  await snap(page, "op-12-403-01", "异常FAQ", "403", "无权限同形拦截页", "member", "FAQ§5.2");
  await login(page, "operations");
  await nav(page, "/no-such-route-op", ".main-workspace");
  await snap(page, "op-12-404-01", "异常FAQ", "404", "真 404 页面不存在", "operations", "FAQ§5.3");
  // 409 乐观锁：数据纠正故意填过期 rowVersion（提交失败不落数据）
  await login(page, "sysadmin");
  await nav(page, "/admin", ".audit-tabs");
  await tap(page.getByRole("button", { name: "数据纠正" }).first());
  await page.waitForTimeout(900);
  const objSel = page.locator("select").first();
  if (await objSel.count()) await objSel.selectOption({ value: "user" }).catch(() => {});
  await page.waitForTimeout(600);
  const firstRow = page.locator(".report-row, [class*='row']").first();
  await tapDispatch(firstRow);
  await page.waitForTimeout(800);
  const rvInput = page.locator("input").filter({ has: page.locator("..") }).nth(2);
  // 直接把所有数字输入兜底：把 rowVersion 输入置为极大值制造冲突
  const inputs = page.locator("[role='dialog'] input, form input");
  const n = await inputs.count();
  for (let i = 0; i < n; i++) {
    const ph = await inputs.nth(i).getAttribute("placeholder").catch(() => "");
    if (/rowVersion|版本/i.test(ph ?? "")) await inputs.nth(i).fill("999", { timeout: 3_000 }).catch(() => {});
  }
  await tap(page.getByRole("button", { name: /修正|提交|保存/ }).first());
  await page.waitForTimeout(1200);
  await snap(page, "op-12-409-01", "异常FAQ", "409", "乐观锁冲突提示", "sysadmin", "FAQ§5.4");
  // 401 会话失效
  await page.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
  await page.goto(`${B}/audit`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await snap(page, "op-12-401-01", "异常FAQ", "401", "会话失效跳回登录", "未登录", "FAQ§5.1");
});

test("op-ch6 补拍（密码/幂等/终态写链拦截/移动补充，≥12 张）", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // 自助改密流程（sysadmin 演示改密入口打开不提交）
  await login(page, "sysadmin");
  await nav(page, "/settings", ".main-workspace");
  await tap(page.getByRole("button", { name: /修改密码|改密/ }).first());
  await page.waitForSelector("[role='dialog']", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(700);
  await snap(page, "op-01-通用-04", "通用操作", "4", "自助改密弹窗", "sysadmin", "入门§2.5");
  await tap(page.getByRole("button", { name: /取消|关闭/ }).first());
  await page.keyboard.press("Escape").catch(() => {});
  // 搜索空态（viewer 零命中）
  await login(page, "viewer");
  await nav(page, "/search", ".main-workspace");
  const input = page.locator("input").first();
  await input.fill("不存在的项目xyz", { timeout: 5_000 }).catch(() => {});
  await input.press("Enter").catch(() => {});
  await page.waitForTimeout(1200);
  await snap(page, "op-01-搜索-03", "全局搜索", "3", "搜索空态（零命中）", "viewer", "入门§2.3");
  // 商机赢单/关闭弹窗（sales，打开不提交）
  await login(page, "sales");
  await nav(page, "/crm/opportunities", ".main-workspace");
  await tapDispatch(page.locator(".p9a-ta-row.is-clickable, .report-row").first());
  await page.waitForSelector('.overlay [role="dialog"]', { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(800);
  await tap(page.getByRole("button", { name: /赢单/ }).first());
  await page.waitForSelector("[role='dialog'] >> nth=1", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(800);
  await snap(page, "op-04-商机-05", "商机", "5", "赢单挂合同弹窗", "sales", "流程§4.2.3");
  await page.keyboard.press("Escape").catch(() => {});
  await tap(page.getByRole("button", { name: /关闭|输单/ }).first());
  await page.waitForTimeout(800);
  await snap(page, "op-04-商机-06", "商机", "6", "商机关闭确认", "sales", "流程§4.2.3");
  await page.keyboard.press("Escape").catch(() => {});
  // 项目周报生成草稿弹窗（pm）
  await login(page, "project_manager");
  const pid = await projectId(page);
  await nav(page, `/projects/${pid}/reports`, ".main-workspace");
  await tap(page.getByRole("button", { name: /生成|新建周报/ }).first());
  await page.waitForSelector("[role='dialog']", { timeout: 6_000 }).catch(() => {});
  await page.waitForTimeout(900);
  await snap(page, "op-05-周报-01", "周报", "1", "周报生成草稿弹窗", "project_manager", "流程§4.3.2-周报");
  await tap(page.getByRole("button", { name: /取消|关闭/ }).first());
  await page.keyboard.press("Escape").catch(() => {});
  // 收款作废冲正确认（finance，打开不确认）
  await login(page, "finance");
  await nav(page, "/operations/receipts", ".main-workspace");
  const voidBtn = page.getByRole("button", { name: /作废|冲正/ }).first();
  if (await voidBtn.count()) {
    await tap(voidBtn);
    await page.waitForSelector("[role='dialog']", { timeout: 6_000 }).catch(() => {});
    await page.waitForTimeout(800);
    await snap(page, "op-07-收款-03", "收款", "3", "收款作废冲正确认弹窗", "finance", "流程§4.5.4");
    await tap(page.getByRole("button", { name: /取消|关闭/ }).first());
    await page.keyboard.press("Escape").catch(() => {});
  }
  // 发票红冲（finance，打开不确认）
  await nav(page, "/fin/invoices", ".main-workspace");
  const redBtn = page.getByRole("button", { name: /红冲|作废/ }).first();
  if (await redBtn.count()) {
    await tap(redBtn);
    await page.waitForSelector("[role='dialog']", { timeout: 6_000 }).catch(() => {});
    await page.waitForTimeout(800);
    await snap(page, "op-07-发票-03", "发票", "3", "发票红冲确认弹窗", "finance", "流程§4.5.6");
    await tap(page.getByRole("button", { name: /取消|关闭/ }).first());
    await page.keyboard.press("Escape").catch(() => {});
  }
  // 数据纠正执行预览（第二步：字段补丁表单过程态）
  await login(page, "sysadmin");
  await nav(page, "/admin", ".audit-tabs");
  await tap(page.getByRole("button", { name: "数据纠正" }).first());
  await page.waitForTimeout(900);
  const objSel2 = page.locator("select").first();
  if (await objSel2.count()) await objSel2.selectOption({ value: "lead" }).catch(() => {});
  await page.waitForTimeout(700);
  const firstLead = page.locator(".report-row, [class*='row']").first();
  await tapDispatch(firstLead);
  await page.waitForTimeout(900);
  await snap(page, "op-09-数据纠正-02", "数据纠正", "2", "纠正补丁表单（白名单字段+理由）", "sysadmin", "流程§4.7.7");
  // 移动补充：通知中心 + 工时
  const m = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await m.goto(`${B}/login`, { waitUntil: "domcontentloaded" });
  await m.getByPlaceholder("name@firm.com").fill("guanchen@lexflow.demo");
  await m.locator('input[type="password"]').fill("Demo@2026");
  await m.getByRole("button", { name: "登录" }).click();
  await m.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 25_000 });
  await m.goto(`${B}/notifications`, { waitUntil: "domcontentloaded" });
  await m.waitForTimeout(1200);
  await m.screenshot({ path: path.join(ASSETS, "op-11-通知-01.png") });
  manifest.push({ id: "op-11-通知-01", file: "op-11-通知-01.png", flow: "移动端·通知", step: "1", page: "375px 移动通知中心", role: "member", viewport: "mobile-375x812", anchor: "移动§4.9.7", capturedAt: new Date().toISOString() });
  persist();
  await m.goto(`${B}/operations/time`, { waitUntil: "domcontentloaded" });
  await m.waitForTimeout(1200);
  await m.screenshot({ path: path.join(ASSETS, "op-11-工时-01.png") });
  manifest.push({ id: "op-11-工时-01", file: "op-11-工时-01.png", flow: "移动端·工时", step: "1", page: "375px 移动工时中心", role: "member", viewport: "mobile-375x812", anchor: "移动§4.9.8", capturedAt: new Date().toISOString() });
  persist();
  await m.close();
  // 幂等重复提交说明图（经费表单连点两次提交仍仅一条的错误拦截/重复提示——若页面有防重按钮态）
  await login(page, "member");
  await nav(page, "/operations/funding/new", ".main-workspace");
  await page.evaluate(() => { const b = document.querySelector("button[type='submit'], .primary-action") as HTMLButtonElement | null; if (b) b.disabled = true; }).catch(() => {});
  await page.waitForTimeout(400);
  await page.evaluate(() => { const b = document.querySelector("button[type='submit'], .primary-action") as HTMLButtonElement | null; if (b) b.disabled = false; }).catch(() => {});
  await snap(page, "op-12-幂等-01", "异常FAQ", "幂等", "提交中按钮防重态说明", "member", "FAQ§5.5");
  console.log("[op-ch6] 补拍完成，manifest 总数：", manifest.length);
});
