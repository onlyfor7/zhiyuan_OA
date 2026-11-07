/** 工单 10-03：迭代 10 验收（六裁定：表单视口约束+出差 F3/报表 Excel 风/分钟清零/ⓘ 气泡/H2 修订/多页签工作区）。
 * 取证路径：dev 全量（纯前端迭代，发布后 prod 复跑核心链，同迭代 7 例）。LX_BASE 默认 8080，dev 取证传 http://localhost:3000。
 * F3 合规：开跑前确认无其他测试会话在跑。截图 D:/tmp/shots-iter10-test/。 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const B = process.env.LX_BASE ?? "http://localhost:8080";
const SHOTS = "D:/tmp/shots-iter10-test";
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
/** 弹窗视口约束断言：.decision-modal 高≤视口-64 且不超屏、头尾 sticky（§5 v1.9 硬规则） */
async function assertModalViewport(page: Page, label: string) {
  const modal = page.locator(".overlay .decision-modal:visible").first();
  await expect(modal, `${label} 弹窗在位`).toBeVisible({ timeout: 10_000 });
  const box = await modal.boundingBox();
  expect(box, `${label} boundingBox`).toBeTruthy();
  expect(box!.height, `${label} 高≤736(800-64)`).toBeLessThanOrEqual(736);
  expect(box!.y + box!.height, `${label} 底≤视口`).toBeLessThanOrEqual(800);
  const headSticky = await modal.locator("> .drawer-head").first().evaluate((e) => getComputedStyle(e).position);
  expect(headSticky, `${label} 头 sticky`).toBe("sticky");
  const foot = modal.locator("> .drawer-actions, > .p9a-modal-foot").first();
  if (await foot.count()) expect(await foot.evaluate((e) => getComputedStyle(e).position), `${label} 尾 sticky`).toBe("sticky");
}

test.describe.configure({ mode: "serial" });

test("T1 表单视口约束 1280×800 逐弹窗不超屏+出差 F3 拆分", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await login(page, "guojingwen@lexflow.demo"); // finance：收款台账/发票/工时/CRM 全可见
  // ① 收款登记 F1（台账行内或页头入口）
  await page.goto(`${B}/operations/receipts`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  const regBtn = page.getByRole("button", { name: /登记收款|收款登记/ }).first();
  await regBtn.click();
  await assertModalViewport(page, "收款登记");
  await shot(page, "T1-收款登记-1280x800");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  // ② 发票开具 F2 抽屉
  await page.goto(`${B}/fin/invoices`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: /开具发票|新建发票/ }).first().click();
  await assertModalViewport(page, "开具发票");
  await shot(page, "T1-发票开具-1280x800");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  // ③ 工时快速填报 F1
  await page.goto(`${B}/operations/time`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "快速填报" }).first().click();
  await assertModalViewport(page, "快速填报");
  await shot(page, "T1-快速填报-1280x800");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  // ④ 新建线索 F1
  await page.goto(`${B}/crm/leads`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "新建线索" }).first().click();
  await assertModalViewport(page, "新建线索");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  // ⑤ 新建出差 F3 三页签拆分+校验红点
  await page.goto(`${B}/travel`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "新建出差申请" }).first().click();
  const modal = page.locator(".overlay .decision-modal:visible, .overlay .ux-modal-wide:visible").first();
  await expect(modal, "出差弹窗在位").toBeVisible({ timeout: 10_000 });
  const box = await modal.boundingBox();
  expect(box!.height, "出差弹窗高≤736").toBeLessThanOrEqual(736);
  const tabStrip = page.locator(".p9a-wizard-tabs:visible").first();
  await expect(tabStrip, "F3 页签条").toBeVisible();
  const tabs = await tabStrip.locator("button, [role=tab], a").allTextContents();
  for (const t of ["基本", "行程段", "费用与借款"]) expect(tabs.join("|"), `页签 ${t}`).toContain(t);
  // 直接提交触发校验 → 红点角标
  await page.getByRole("button", { name: /提交|下一步/ }).last().click();
  await page.waitForTimeout(600);
  const dots = await page.locator(".rep-tab-dot:visible").count();
  expect(dots, "校验红点≥1").toBeGreaterThanOrEqual(1);
  await shot(page, "T1-出差F3-页签红点");
});

test("T2 报表 Excel 风五项逐项（格线/灰底表头/行高/右对齐/冻结）", async ({ page }) => {
  await login(page, "guojingwen@lexflow.demo");
  await page.goto(`${B}/reports/monthly_cashflow`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const table = page.locator(".rep-excel").first();
  await expect(table, ".rep-excel 表在位").toBeVisible();
  // ① 全格线 1px：表头首格右边线+表体首格右边线/下边线
  const grid = await table.evaluate((t) => {
    const headCell = t.querySelector(".p9a-ta-head > span") as HTMLElement;
    const bodyRow = t.querySelector(".p9a-ta-row:not(.p9a-ta-head)") as HTMLElement;
    const bodyCell = bodyRow?.querySelector("span") as HTMLElement;
    const cs = (e: HTMLElement) => getComputedStyle(e);
    return {
      headRight: cs(headCell).borderRightWidth,
      bodyRight: cs(bodyCell).borderRightWidth,
      bodyBottom: cs(bodyCell).borderBottomWidth,
      rowMinH: cs(bodyRow).minHeight,
    };
  });
  expect(Number.parseInt(grid.headRight), "表头格线右 1px").toBe(1);
  expect(Number.parseInt(grid.bodyRight), "表体格线右 1px").toBe(1);
  expect(Number.parseInt(grid.bodyBottom), "表体格线下 1px").toBe(1);
  // ② 表头灰底 #f3f4f6 + ⑤ sticky 冻结
  const head = await table.locator(".p9a-ta-head").first().evaluate((e) => {
    const cs = getComputedStyle(e);
    return { bg: cs.backgroundColor, pos: cs.position, top: cs.top };
  });
  expect(head.bg, "表头灰底").toBe("rgb(243, 244, 246)");
  expect(head.pos, "表头 sticky").toBe("sticky");
  // ③ 行高 34
  expect(Number.parseInt(grid.rowMinH), "行高 34").toBe(34);
  // ④ 数值列右对齐（.mono）
  const monoCount = await table.locator("span.mono").count();
  expect(monoCount, ".mono 数值列存在").toBeGreaterThanOrEqual(1);
  const align = await table.locator("span.mono").first().evaluate((e) => getComputedStyle(e).textAlign);
  expect(align, "数值右对齐").toBe("right");
  await shot(page, "T2-报表Excel风");
});

test("T3 分钟零残留（关键页 UI 扫描）", async ({ page }) => {
  await login(page, "guojingwen@lexflow.demo");
  const pages = [
    ["/time", "工时中心"],
    ["/reports/time_summary", "工时汇总报表"],
    ["/reports/utilization", "利用率报表"],
    ["/workbench", "工作台"],
    ["/fin/project-costing", "项目核算"],
  ] as const;
  for (const [path, label] of pages) {
    await page.goto(`${B}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    const text = await page.evaluate(() => document.body.innerText);
    const minMatches = text.match(/\d+(?:\.\d+)?\s*分钟/g) ?? [];
    expect(minMatches, `${label} 无 N 分钟显示`).toEqual([]);
    expect(/[0-9]m\b/.test(text), `${label} 无 Nm 缩写`).toBeFalsy();
  }
  await shot(page, "T3-分钟清零-工时中心");
});

test("T4 ⓘ 气泡：右栏零残留+弹出口径（8 角色页采样 8 页）", async ({ page }) => {
  await login(page, "zhaokai@lexflow.demo"); // sysadmin：audit/admin-center 可见
  const sysPages = [
    ["/admin", "admin-center"],
    ["/audit", "audit"],
  ] as const;
  for (const [path, key] of sysPages) await checkHelp(page, path, key);
  await login(page, "liangqifeng@lexflow.demo"); // partner：多域穿透
  const partnerPages = [
    ["/workbench", "workbench"],
    ["/approvals", "approvals"],
    ["/meetings", "meetings"],
    ["/projects", "projects"],
    ["/quality", "quality"],
    ["/operations/receipts", "receipts-ledger"],
    ["/travel", "travel"],
  ] as const;
  for (const [path, key] of partnerPages) await checkHelp(page, path, key);
  await shot(page, "T4-气泡弹出口径");
});

async function checkHelp(page: Page, path: string, key: string) {
  await page.goto(`${B}${path}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  // 右栏零残留：壳为 no-rail（rail 槽不渲染）+ 主区无说明栏类
  const railGone = await page.evaluate(() => {
    const body = document.querySelector(".app-body");
    return body ? body.className.includes("no-rail") : false;
  });
  expect(railGone, `${path} 右栏槽不渲染（no-rail）`).toBeTruthy();
  // ⓘ 在位+点击弹出口径文案（注册表单一源）
  const icon = page.locator(`[data-help="${key}"], .help-icon, button:has(svg.lucide-info)`).first();
  await expect(icon, `${path} ⓘ 在位`).toBeVisible({ timeout: 8_000 });
  await icon.click();
  await page.waitForTimeout(400);
  const pop = page.locator(".help-pop, .help-bubble, [class*='help-pop']").first();
  await expect(pop, `${path} 气泡弹出`).toBeVisible();
  const popText = await pop.innerText();
  expect(popText.length, `${path} 气泡有文案`).toBeGreaterThan(10);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await expect(pop, `${path} Esc 关闭`).toBeHidden();
}

test("T5 H2 修订：工作台/通知无纵向内滚框+分页/折叠在位", async ({ page }) => {
  await login(page, "liangqifeng@lexflow.demo");
  for (const [path, label] of [["/workbench", "工作台"], ["/notifications", "通知中心"], ["/cockpit", "驾驶舱"]] as const) {
    await page.goto(`${B}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const offenders = await page.evaluate(() => {
      const main = document.querySelector(".main-workspace") ?? document.body;
      const out: string[] = [];
      main.querySelectorAll("*").forEach((e) => {
        const cs = getComputedStyle(e);
        if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && e.scrollHeight - e.clientHeight > 4) {
          out.push(`${e.tagName}.${[...e.classList].slice(0, 2).join(".")}`);
        }
      });
      return out;
    });
    expect(offenders, `${label} 无纵向内滚框`).toEqual([]);
  }
  // 分页/折叠承载在位：驾驶舱待办 6 行/页扁平分页（「上一页/下一页」）+ 组头折叠
  await page.goto(`${B}/cockpit`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const cockpitText = await page.evaluate(() => document.body.innerText);
  expect(/上一页|下一页|共 \d+/.test(cockpitText), "驾驶舱分页承载").toBeTruthy();
  await shot(page, "T5-H2-分页折叠在位");
});

test("T6 多页签工作区：开签/keep-alive/关闭其他/恢复/375", async ({ page }) => {
  await login(page, "liangqifeng@lexflow.demo");
  // 首签：驾驶舱固定常驻不可关
  const bar = page.locator(".ws-bar");
  await expect(bar, "页签条在位").toBeVisible({ timeout: 10_000 });
  const firstTab = bar.locator(".ws-tab").first();
  expect(await firstTab.innerText(), "首签=驾驶舱").toContain("驾驶舱");
  await expect(firstTab.locator(".ws-fixed-mark"), "首签 ⌂ 固定标记").toBeVisible();
  expect(await firstTab.locator(".ws-close").count(), "首签无关闭×").toBe(0);
  // 开签：项目 → 报表工作台
  await page.goto(`${B}/projects`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  let tabs = await bar.locator(".ws-tab").count();
  expect(tabs, "项目签已开").toBe(2);
  await page.goto(`${B}/reports`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  tabs = await bar.locator(".ws-tab").count();
  expect(tabs, "报表签已开").toBe(3);
  // 同路由复用：再进 /projects 不重复开签
  await page.goto(`${B}/projects`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  expect(await bar.locator(".ws-tab").count(), "同路由复用不重复开签").toBe(3);
  // keep-alive：项目列表搜索词切签保留
  const search = page.getByPlaceholder("搜索项目名称或编号，回车确认");
  await search.fill("KEEPALIVE-草稿");
  await page.waitForTimeout(300);
  await bar.locator(".ws-tab", { hasText: "报表" }).first().click();
  await page.waitForTimeout(500);
  await bar.locator(".ws-tab", { hasText: "项目" }).first().click();
  await page.waitForTimeout(500);
  expect(await search.inputValue(), "keep-alive 表单状态保留").toBe("KEEPALIVE-草稿");
  await shot(page, "T6-keepalive草稿保留");
  // 关闭其他（右键菜单）：保留 驾驶舱+当前项目签
  await bar.locator(".ws-tab", { hasText: "项目" }).first().click({ button: "right" });
  await page.waitForTimeout(400);
  await page.locator(".ws-menu", { hasText: "关闭其他" }).locator("text=关闭其他").first().click();
  await page.waitForTimeout(600);
  const remaining = await bar.locator(".ws-tab").allTextContents();
  expect(remaining.length, "关闭其他后剩 2 签").toBe(2);
  expect(remaining.join("|"), "驾驶舱+项目签保留").toContain("驾驶舱");
  // sessionStorage 恢复：reload 后签集还原
  const stored = await page.evaluate(() => sessionStorage.getItem("lexflow-workspace-tabs-v1"));
  expect(stored, "sessionStorage 签集已持久化").toBeTruthy();
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  expect(await bar.locator(".ws-tab").count(), "reload 后签集恢复").toBe(2);
  await shot(page, "T6-签集恢复");
  // 375 不出签条
  await page.setViewportSize({ width: 375, height: 812 });
  await page.waitForTimeout(600);
  await expect(bar, "375 页签条隐藏").toBeHidden();
});
