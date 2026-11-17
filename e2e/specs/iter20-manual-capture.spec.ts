/** 迭代 20 工单 05 §4：两册手册受影响截图重拍（dev 取证，只读为主/写链自清）。
 * 产物：
 *  - docs/manual-assets/2026-11-17/        （功能手册 §5 嵌入）
 *  - docs/operation-assets/2026-11-17/     （操作手册 §4.4 重写嵌入）
 * 各自 manifest.json 增量（按 id 去重）。用法：LX_BASE=http://localhost:3000 npx playwright test iter20-manual-capture
 */
import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { installE2eSelfClean } from "./e2e-cleanup";

const B = process.env.LX_BASE ?? "http://localhost:3000";
const MANUAL_DIR = "../docs/manual-assets/2026-11-17";
const OP_DIR = "../docs/operation-assets/2026-11-17";
mkdirSync(MANUAL_DIR, { recursive: true });
mkdirSync(OP_DIR, { recursive: true });

test.describe.configure({ timeout: 600_000, mode: "serial" });
test.use({ actionTimeout: 8_000, navigationTimeout: 20_000 });
installE2eSelfClean();

const EMAIL = {
  sysadmin: "zhaokai@lexflow.demo",
  member: "guanchen@lexflow.demo",
  partner: "liangqifeng@lexflow.demo",
  pm: "wangbaozhuo@lexflow.demo",
} as const;
const STAMP = `手册20-${Date.now() % 1000000}`;

async function login(page: Page, email: string) {
  await page.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
  await page.goto(`${B}/login`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("name@firm.com").fill(email);
  await page.locator('input[type="password"]').fill("Demo@2026");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 25_000 });
  await page.waitForTimeout(400);
}

type ShotMeta = Record<string, unknown>;
async function snap(page: Page, dir: string, file: string, meta: ShotMeta) {
  await page.waitForTimeout(450);
  const path = `${dir}/${file}`;
  await page.screenshot({ path });
  const manPath = `${dir}/manifest.json`;
  const wrap: { shots: ShotMeta[] } = existsSync(manPath) ? JSON.parse(readFileSync(manPath, "utf8")) : { shots: [] };
  const list = wrap.shots ?? [];
  const entry = { file, capturedAt: new Date().toISOString(), ...meta };
  const i = list.findIndex((e) => e.file === file);
  if (i >= 0) list[i] = entry; else list.push(entry);
  writeFileSync(manPath, JSON.stringify({ shots: list }, null, 2));
}

async function api(page: Page, path: string, input?: unknown) {
  if (input === undefined) {
    const r = await page.request.get(`${B}/trpc/${path}`);
    return { status: r.status(), json: await r.json().catch(() => null) };
  }
  const r = await page.request.post(`${B}/trpc/${path}`, { headers: { "content-type": "application/json" }, data: JSON.stringify(input) });
  return { status: r.status(), json: await r.json().catch(() => null) };
}
const d = (r: { json: any }) => r.json?.result?.data;

let WIZ_FORM: { id: string; code: string; flowId: string } | null = null;
const MARK = `验收-${STAMP}-${Date.now() % 100000}`;

test("手册截图：审批中心/申请单/管理后台分组（两册共用场景）", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // 1) 审批中心（partner 待审卡：通过/驳回/转交/退回 + 快照）
  await login(page, EMAIL.partner);
  await page.goto(`${B}/approvals`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".approvals-screen", { timeout: 20_000 });
  await page.waitForTimeout(900);
  await snap(page, MANUAL_DIR, "05-01-approval-center.png", { id: "05-01", chapter: "5 协同与审批", page: "审批中心", role: "partner", viewport: "1440x900" });
  await snap(page, OP_DIR, "op-06-审批-01.png", { id: "op-06-审批-01", flow: "4.4.2 审批中心", step: 1, page: "审批中心", role: "partner", viewport: "1440x900" });
  const card = page.locator(".approval-card").first();
  if (await card.count()) {
    await card.getByRole("button", { name: "审批快照/检查项" }).click().catch(() => {});
    await page.waitForTimeout(600);
    await snap(page, MANUAL_DIR, "05-02-approval-detail.png", { id: "05-02", chapter: "5 协同与审批", page: "审批详情（快照展开）", role: "partner", viewport: "1440x900" });
    await card.getByRole("button", { name: "通过" }).click().catch(() => {});
    await page.waitForTimeout(400);
    await snap(page, OP_DIR, "op-06-审批-02.png", { id: "op-06-审批-02", flow: "4.4.2 审批中心", step: 2, page: "通过确认（意见必填态）", role: "partner", viewport: "1440x900" });
    await page.keyboard.press("Escape").catch(() => {});
  }

  // 2) 通用申请单发起弹窗（member；选 CF 类型演示表单渲染——只拍不提交）
  await login(page, EMAIL.member);
  await page.goto(`${B}/requests`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".screen", { timeout: 20_000 });
  await snap(page, OP_DIR, "op-06-发起-00.png", { id: "op-06-发起-00", flow: "4.4.1 发起通用申请单", step: 1, page: "我的申请单", role: "member", viewport: "1440x900" });
  await page.getByRole("button", { name: "发起申请" }).first().click();
  await page.waitForSelector(".grant-apply-form", { timeout: 10_000 });
  await snap(page, MANUAL_DIR, "05-05-generic-request.png", { id: "05-05", chapter: "5 协同与审批", page: "通用申请单发起弹窗", role: "member", viewport: "1440x900" });
  // 若存在已发布自定义表单则选中展示 schema 渲染
  const typeSel = page.locator(".grant-apply-form select").first();
  const opts = await typeSel.locator("option").allTextContents();
  const cfOpt = await typeSel.locator("option").evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.textContent ?? "" })).filter((o) => o.t.startsWith("CF-") || /^CF-/.test(o.v)));
  if (cfOpt.length) {
    await typeSel.selectOption(cfOpt[cfOpt.length - 1].v);
    await page.waitForTimeout(1300);
    await snap(page, OP_DIR, "op-06-发起-01.png", { id: "op-06-发起-01", flow: "4.4.1 发起通用申请单", step: 2, page: "发起弹窗（自定义表单类型选中渲染字段）", role: "member", viewport: "1440x900" });
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.goto(`${B}/requests`, { waitUntil: "domcontentloaded" }).catch(() => {});
  void opts;
});

test("手册截图：四步向导全步（新建自定义审批，发布后作 §4.4 锚点）", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, EMAIL.sysadmin);
  await page.goto(`${B}/admin/flows/new?kind=custom`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".flow-wizard-screen", { timeout: 20_000 });
  await snap(page, MANUAL_DIR, "05-03a-wizard-step1-basic.png", { id: "05-03a", chapter: "5 协同与审批", page: "四步向导①基础信息", role: "sysadmin", viewport: "1440x900" });
  await snap(page, OP_DIR, "op-06-设计器-01.png", { id: "op-06-设计器-01", flow: "4.4.5 审批流设计（四步向导）", step: 1, page: "向导①基础信息", role: "sysadmin", viewport: "1440x900" });

  await page.locator(".fw-card input").first().fill(`${MARK}审批流`);
  await page.locator(".fw-card textarea").first().fill("手册截图专用：四步向导全步演示").catch(() => {});

  await page.getByRole("tab", { name: "表单设计" }).click();
  await page.waitForSelector(".fw-formdesign", { timeout: 10_000 });
  await page.getByRole("button", { name: "＋ 单行文本", exact: true }).click();
  await page.getByRole("button", { name: "＋ 金额（元）", exact: true }).click();
  await page.getByRole("button", { name: "＋ 人员", exact: true }).click();
  await page.waitForTimeout(400);
  await snap(page, MANUAL_DIR, "05-03b-wizard-step2-formdesign.png", { id: "05-03b", chapter: "5 协同与审批", page: "四步向导②表单设计（控件库+手机画布）", role: "sysadmin", viewport: "1440x900" });
  await snap(page, OP_DIR, "op-06-设计器-02.png", { id: "op-06-设计器-02", flow: "4.4.5 审批流设计（四步向导）", step: 2, page: "向导②表单设计", role: "sysadmin", viewport: "1440x900" });

  await page.getByRole("tab", { name: "流程设计" }).click();
  await page.waitForSelector(".vflow-lane", { timeout: 10_000 });
  const node1 = page.locator(".vf-card:not(.vf-submit):not(.vf-end)").first();
  await node1.click();
  await page.waitForSelector(".fw-node-drawer", { timeout: 8_000 });
  const drawer = page.locator(".fw-node-drawer");
  await drawer.locator("input").first().fill("负责人审批");
  await drawer.locator('.form-field:has-text("审批人策略") select').selectOption("role");
  await drawer.locator('.form-field:has(span:text-is("角色")) select').selectOption("partner");
  await drawer.locator('.form-field:has-text("退回") select').selectOption("prev");
  await snap(page, MANUAL_DIR, "05-03c-wizard-step3-flowdesign.png", { id: "05-03c", chapter: "5 协同与审批", page: "四步向导③流程设计（竖向画布+节点抽屉）", role: "sysadmin", viewport: "1440x900" });
  await snap(page, OP_DIR, "op-06-设计器-03.png", { id: "op-06-设计器-03", flow: "4.4.5 审批流设计（四步向导）", step: 3, page: "向导③流程设计（节点抽屉）", role: "sysadmin", viewport: "1440x900" });
  await drawer.locator(".drawer-head button").first().click();
  await page.waitForTimeout(400);

  await page.getByRole("tab", { name: "更多设置" }).click();
  await page.waitForTimeout(400);
  await snap(page, MANUAL_DIR, "05-03d-wizard-step4-settings.png", { id: "05-03d", chapter: "5 协同与审批", page: "四步向导④更多设置", role: "sysadmin", viewport: "1440x900" });
  await snap(page, OP_DIR, "op-06-设计器-04.png", { id: "op-06-设计器-04", flow: "4.4.5 审批流设计（四步向导）", step: 4, page: "向导④更多设置", role: "sysadmin", viewport: "1440x900" });

  // 发布（手册锚点「验收20手册表单」——disabled 终态由 cleanup 闭环）
  await page.waitForTimeout(1600);
  await page.getByRole("button", { name: /发布/ }).click();
  await page.waitForTimeout(2500);
  const forms = d(await api(page, "forms.list"));
  const mine = (forms.items ?? []).find((f: any) => (f.name ?? "").includes(`${MARK}审批流`));
  expect(mine?.status, "向导发布成功（手册锚点）").toBe("published");
  WIZ_FORM = mine;
});

test("手册截图：管理后台分组列表 + 项目级三步向导", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, EMAIL.sysadmin);
  await page.goto(`${B}/admin?tab=flows`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".preview-tab-body", { timeout: 20_000 }).catch(() => {});
  await page.waitForTimeout(900);
  await snap(page, MANUAL_DIR, "08-04-admin-flows.png", { id: "08-04", chapter: "8 组织与系统治理", page: "审批流管理后台（分组列表）", role: "sysadmin", viewport: "1440x900" });
  await snap(page, OP_DIR, "op-06-设计器-05.png", { id: "op-06-设计器-05", flow: "4.4.5 审批流设计（四步向导）", step: 5, page: "审批流管理后台（业务审批组+自定义组）", role: "sysadmin", viewport: "1440x900" });

  // 项目级三步向导：取非 E2E 残留命名的项目流；抢在自动保存冲突 toast（O-20-5-4，~800ms 后浮现）前快拍
  const flows = d(await api(page, "flow.list"));
  const arr = (flows.items ?? flows ?? []) as any[];
  const projFlow = arr.find((f) => f.scope === "project" && f.projectId && !/E2E-|tmp|探针|验收|手册|走查/.test(f.name))
    ?? arr.find((f) => f.scope === "project" && f.projectId);
  if (projFlow) {
    // 项目负责人现网被 404（O-20-5-6）——截图取证用 sysadmin 开同一路由（三步态形态与操作者无关）
    await login(page, EMAIL.sysadmin);
    await page.goto(`${B}/flows/p/${projFlow.projectId}/${projFlow.id}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".flow-wizard-screen", { timeout: 20_000 });
    await page.waitForSelector(".fw-steps [role='tab']", { timeout: 15_000 });
    await page.waitForTimeout(250); // 短等首屏稳定，避开 800ms 防抖冲突 toast
    await page.screenshot({ path: `${MANUAL_DIR}/05-04-project-flows.png` });
    await page.screenshot({ path: `${OP_DIR}/op-06-项目流-01.png` });
    const manPath = `${MANUAL_DIR}/manifest.json`;
    const wrapM: { shots: any[] } = existsSync(manPath) ? JSON.parse(readFileSync(manPath, "utf8")) : { shots: [] };
    const entryM = { file: "05-04-project-flows.png", capturedAt: new Date().toISOString(), id: "05-04", chapter: "5 协同与审批", page: "项目级流程向导（三步态）", role: "sysadmin", viewport: "1440x900" };
    const iM = wrapM.shots.findIndex((e) => e.file === entryM.file);
    if (iM >= 0) wrapM.shots[iM] = entryM; else wrapM.shots.push(entryM);
    writeFileSync(manPath, JSON.stringify(wrapM, null, 2));
    const opPath = `${OP_DIR}/manifest.json`;
    const wrapO: { shots: any[] } = existsSync(opPath) ? JSON.parse(readFileSync(opPath, "utf8")) : { shots: [] };
    const entryO = { file: "op-06-项目流-01.png", capturedAt: new Date().toISOString(), id: "op-06-项目流-01", flow: "4.4.5 审批流设计（项目级）", step: 6, page: "项目级向导（无表单设计步）", role: "sysadmin", viewport: "1440x900" };
    const iO = wrapO.shots.findIndex((e) => e.file === entryO.file);
    if (iO >= 0) wrapO.shots[iO] = entryO; else wrapO.shots.push(entryO);
    writeFileSync(opPath, JSON.stringify(wrapO, null, 2));
  }
  void WIZ_FORM;
});
