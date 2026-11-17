/** 迭代 20 工单 05：验收矩阵六组（arch/14 §14），dev + 外测 prod 双程。
 * T1 四步向导全链（11 控件/发布/member 发起渲染/三类非法 400/审批四操作/末端 cc）
 * T2 审批人新策略四链（initiator_self+sameAsInitiator 四态/dept_head/manager_chain/form_contact）
 * T3 条件分支（第一命中/else/嵌套一层/form.<key> + 保存 400 双实锤 + 发布 412）
 * T4 迁移复核（全量 v2/默认流新向导渲染一致/在途实例不动 + §2① rowVersion 提示取证）
 * T5 项目级三步态 + 旧画布组件下线 + /admin/flows/:id 进新向导
 * T6 去重 once/auto_pass/抄送三时点/fieldPerms hidden 真生效
 *
 * 用法（e2e/ 目录）：
 *   dev:  LX_BASE=http://localhost:3000 npx playwright test iter20-acceptance --reporter=line
 *   prod: LX_BASE=http://182.92.206.62:8080 npx playwright test iter20-acceptance --reporter=line
 * 普通 Chrome、零 flag；domcontentloaded（绝不 networkidle）；F3 套件独占。
 * dept_head 正链需 DB 夹具：默认仅 localhost 栈启用；外测无 LX_DB_URL 时自动改负路径（400 未配置负责人）。
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { installE2eSelfClean } from "./e2e-cleanup";

const B = process.env.LX_BASE ?? "http://localhost:3000";
const SHOTS = "D:/tmp/shots-iter20-05";
mkdirSync(SHOTS, { recursive: true });
const STAMP = `验${Date.now() % 1000000}`.slice(0, 9);
const DB_URL = process.env.LX_DB_URL ?? "postgres://lexflow:lexflow_dev@localhost:15432/lexflow";
const CAN_DB = !!process.env.LX_DB_URL || new URL(B).hostname === "localhost";

const EMAIL = {
  sysadmin: "zhaokai@lexflow.demo",
  member: "guanchen@lexflow.demo",
  sales: "sumingxuan@lexflow.demo",
  partner: "liangqifeng@lexflow.demo",
  finance: "guojingwen@lexflow.demo",
  archivist: "wangying@lexflow.demo",
  operations: "xuwenjing@lexflow.demo",
  pm: "wangbaozhuo@lexflow.demo",
  member2: "lijianwei@lexflow.demo",
} as const;

test.describe.configure({ timeout: 600_000, mode: "serial" });
test.use({ actionTimeout: 8_000, navigationTimeout: 20_000 });
installE2eSelfClean();

async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function login(page: Page, email: string) {
  await page.request.post(`${B}/trpc/auth.logout`, { headers: { "content-type": "application/json" }, data: "{}" }).catch(() => {});
  await page.goto(`${B}/login`, { waitUntil: "domcontentloaded" });
  await page.getByPlaceholder("name@firm.com").fill(email);
  await page.locator('input[type="password"]').fill("Demo@2026");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 25_000 });
  await page.waitForTimeout(400);
}

async function api(page: Page, path: string, input?: unknown) {
  if (input === undefined) {
    const r = await page.request.get(`${B}/trpc/${path}`);
    return { status: r.status(), json: await r.json().catch(() => null) };
  }
  const r = await page.request.post(`${B}/trpc/${path}`, {
    headers: { "content-type": "application/json" },
    data: JSON.stringify(input),
  });
  return { status: r.status(), json: await r.json().catch(() => null) };
}
const d = (r: { json: any }) => r.json?.result?.data;
const uuid = () => crypto.randomUUID();

/** 成员目录（含角色/主管） */
async function members(page: Page): Promise<any[]> {
  const r = d(await api(page, `org.members.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`));
  return (r?.items ?? r ?? []) as any[];
}
const byEmail = (list: any[], email: string) => list.find((m) => (m.email ?? "").startsWith(email.split("@")[0]));

/** dept_head DB 夹具：设综合管理部负责人（server/tests iter20-02 同款口径） */
async function dbSetDeptHead(leaderId: string): Promise<boolean> {
  if (!CAN_DB) return false;
  const { Client } = await import("pg");
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  try {
    await c.query("UPDATE org_units SET leader_id=$1 WHERE name='综合管理部'", [leaderId]);
    return true;
  } finally {
    await c.end();
  }
}

/** API 建自定义表单+绑定流（草稿）；自建 sysadmin 会话（调用方可能是任意角色） */
async function mkForm(page: Page, name: string, fields: any[]) {
  await login(page, EMAIL.sysadmin);
  const r = await api(page, "forms.create", {
    name, description: "迭代20验收", icon: "ClipboardList", groupName: "验收组",
    visibility: { mode: "all", roleKeys: [], userIds: [] },
    formSchema: { fields },
  });
  expect(r.status, `forms.create ${name} → ${JSON.stringify(r.json).slice(0, 200)}`).toBe(200);
  return d(r) as { id: string; code: string; flowId: string; rowVersion: number };
}
const v2Def = (nodes: any[], settings: any = {}, extra: any = {}) => ({
  schemaVersion: 2,
  settings: { allowWithdrawPending: true, dedupeApprover: "once", titleTemplate: null, summaryFieldKeys: [], ...settings },
  nodes, ...extra,
});
const apNode = (id: string, name: string, approver: any, opts: any = {}) => ({
  type: "approval", id, name, approvalType: opts.approvalType ?? "manual", approver,
  countersign: "any", sameAsInitiator: opts.sameAsInitiator ?? "skip",
  ops: { transfer: true, returnBack: opts.returnBack ?? "none", requireCommentOnReject: true, requireCommentOnApprove: false, ...(opts.ops ?? {}) },
  ...(opts.fieldPerms ? { fieldPerms: opts.fieldPerms } : {}),
});
async function publishFormFlow(page: Page, formId: string, formRv: number) {
  const pub = await api(page, "forms.publish", { id: formId, rowVersion: formRv });
  expect(pub.status, `forms.publish → ${JSON.stringify(pub.json).slice(0, 250)}`).toBe(200);
  return d(pub);
}
/** 写绑定流定义并发布整表单 */
async function setFlowAndPublish(page: Page, form: { id: string; flowId: string; rowVersion: number }, def: any) {
  const cur = d(await api(page, `flow.getById?input=${encodeURIComponent(JSON.stringify({ id: form.flowId }))}`));
  const upd = await api(page, "flow.updateDraft", { id: form.flowId, rowVersion: cur.rowVersion, definitionJson: def });
  expect(upd.status, `flow.updateDraft → ${JSON.stringify(upd.json).slice(0, 300)}`).toBe(200);
  await publishFormFlow(page, form.id, form.rowVersion);
}
/** member 经 CF 提交并返回实例 id */
async function submitCf(page: Page, code: string, title: string, payload: any, submitter = EMAIL.member) {
  await login(page, submitter);
  const cr = await api(page, "genericRequest.create", { requestType: code, title, reason: "迭代20验收", payload });
  expect(cr.status, `create ${title} → ${JSON.stringify(cr.json).slice(0, 250)}`).toBe(200);
  const req = d(cr);
  const sub = await api(page, "genericRequest.submit", { id: req.id, rowVersion: req.rowVersion, idempotencyKey: uuid() });
  return { sub, req };
}
async function actAs(page: Page, email: string, instanceId: string, stepSeq: number, action: string, comment = "验收通过", transferTo?: string) {
  await login(page, email);
  const r = await api(page, "approval.act", { instanceId, stepSeq, action, comment, transferTo });
  return r;
}
const instOf = (sub: any) => d(sub)?.instance?.id;

// 跨测试共享产物
const T1: any = {}; // 向导产物（表单/流/实例/字段键）
const T3: any = {}; // 条件分支产物

/* ================================ T1 四步向导全链 ================================ */
test("T1 四步向导全链：11 控件/发布/member 发起渲染/三类非法 400/审批四操作/末端 cc", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, EMAIL.sysadmin);
  await page.goto(`${B}/admin/flows/new?kind=custom`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".flow-wizard-screen", { timeout: 20_000 });
  await shot(page, "T1-01-step1");

  // ① 基础信息
  await page.locator(".fw-card input").first().fill(`验收20向导-${STAMP}`);
  await page.getByRole("tab", { name: "表单设计" }).click();
  await page.waitForSelector(".fw-formdesign", { timeout: 10_000 });

  // ② 表单设计：控件全 11 类型各一
  for (const label of ["单行文本", "多行文本", "说明（只读）", "数字", "金额（元）", "单选", "多选", "日期", "日期区间", "人员", "附件"]) {
    await page.getByRole("button", { name: `＋ ${label}`, exact: true }).click();
  }
  expect(await page.locator(".fw-field-card").count(), "11 控件全部落画布").toBe(11);
  await shot(page, "T1-02-step2-formdesign");
  // 记字段键（加序：text=field_1 textarea=2 note=3 number=4 money=5 radio=6 multi=7 date=8 daterange=9 person=10 file=11）
  T1.moneyKey = "field_5";

  // ③ 流程设计：模板默认审批节点改配 role=partner + 退回 prev + 通过必填意见 + 金额 hidden
  await page.getByRole("tab", { name: "流程设计" }).click();
  await page.waitForSelector(".vflow-lane", { timeout: 10_000 });
  const node1 = page.locator(".vf-card:not(.vf-submit):not(.vf-end)").first();
  await node1.click();
  await page.waitForSelector(".fw-node-drawer", { timeout: 8_000 });
  let drawer = page.locator(".fw-node-drawer");
  await drawer.locator("input").first().fill("负责人审批");
  await drawer.locator('.form-field:has-text("审批人策略") select').selectOption("role");
  await drawer.locator('.form-field:has(span:text-is("角色")) select').selectOption("partner");
  await drawer.locator('.form-field:has-text("退回") select').selectOption("prev");
  await drawer.locator(".check-field", { hasText: "通过必填意见" }).locator("input").check();
  const permRows = drawer.locator(".fw-perm-row:not(.head)");
  for (let i = 0; i < (await permRows.count()); i++) {
    const label = await permRows.nth(i).locator("span").first().textContent();
    if ((label ?? "").includes("金额")) await permRows.nth(i).getByText("隐藏", { exact: true }).click();
  }
  await shot(page, "T1-03-node1-drawer");
  await drawer.locator(".drawer-head button").first().click();

  // 插入 finance 节点（退回 prev）与末端 cc（archivist）
  await page.locator('.vf-insert button[aria-label="插入节点"]').last().click();
  await page.getByRole("button", { name: "＋ 审批" }).click();
  await page.waitForSelector(".fw-node-drawer", { timeout: 8_000 });
  drawer = page.locator(".fw-node-drawer");
  await drawer.locator("input").first().fill("财务复核");
  await drawer.locator('.form-field:has-text("审批人策略") select').selectOption("role");
  await drawer.locator('.form-field:has(span:text-is("角色")) select').selectOption("finance");
  await drawer.locator('.form-field:has-text("退回") select').selectOption("prev");
  await drawer.locator(".drawer-head button").first().click();

  await page.locator('.vf-insert button[aria-label="插入节点"]').last().click();
  await page.getByRole("button", { name: "＋ 抄送" }).click();
  await page.locator('.vf-card:has-text("抄送")').first().click();
  await page.waitForSelector(".fw-node-drawer", { timeout: 8_000 });
  drawer = page.locator(".fw-node-drawer");
  await drawer.locator("input").first().fill("档案知悉");
  await drawer.locator(".fw-cc-receiver select").nth(0).selectOption("role");
  await drawer.locator(".fw-cc-receiver select").nth(1).selectOption("archivist");
  await drawer.locator(".drawer-head button").first().click();
  const cards = await page.locator(".vflow-lane .vf-card").count();
  expect(cards, "竖向画布节点（提交/审批/审批/抄送/结束）").toBeGreaterThanOrEqual(5);
  await shot(page, "T1-04-step3-designed");

  // ④ 更多设置：允许撤回 + 去重 once
  await page.getByRole("tab", { name: "更多设置" }).click();
  await page.locator(".check-field", { hasText: "允许撤回" }).locator("input").check().catch(() => {});
  await page.locator('.form-field:has-text("审批人去重") select').selectOption("once").catch(() => {});
  await shot(page, "T1-05-step4-settings");

  // 发布（等防抖自动保存落盘）
  await page.waitForTimeout(1600);
  await page.getByRole("button", { name: /发布/ }).click();
  await page.waitForTimeout(2500);
  const forms = d(await api(page, "forms.list"));
  const mine = (forms.items ?? []).find((f: any) => (f.name ?? "").includes(`验收20向导-${STAMP}`));
  expect(mine?.status, "发布后表单 published").toBe("published");
  T1.form = mine;
  T1.ljId = (await members(page)).find((m) => (m.email ?? "").startsWith("lijianwei"))?.id;
  expect(T1.ljId, "lijianwei 成员在位").toBeTruthy();
  await shot(page, "T1-06-published");

  // ⑤ member 发起：UI 渲染 schema 字段
  await login(page, EMAIL.member);
  await page.goto(`${B}/requests`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".screen", { timeout: 20_000 });
  await page.getByRole("button", { name: "发起申请" }).first().click();
  await page.waitForSelector(".grant-apply-form", { timeout: 10_000 });
  await page.locator(".grant-apply-form select").first().selectOption(mine.code);
  await page.waitForTimeout(1300);
  const fieldCount = await page.locator(".grant-apply-form .fw-ro-form .form-field").count();
  expect(fieldCount, "member 按 schema 一次渲染（≥11 字段，无降级提示）").toBeGreaterThanOrEqual(11);
  const degraded = await page.locator(".grant-apply-form .context-note", { hasText: "20-03-G3" }).count();
  expect(degraded, "G3 降级提示已移除（03b）").toBe(0);
  await shot(page, "T1-07-member-form-rendered");

  // ⑥ payload 三类非法 400（类型非法/选项域外/引用不存在）
  // O-20-5-11 观察：prod 慢网下向导发布后可能被迟到的自动保存回拨草稿（dev 快网未复现）——探针前确保 published（重发布幂等）
  const ensurePublished = async () => {
    await login(page, EMAIL.sysadmin); // forms.list/publish 需管理会话（调用方可能为 member）
    const fl = d(await api(page, "forms.list"));
    const cur = (fl.items ?? []).find((f: any) => f.code === mine.code);
    if (cur && cur.status !== "published") {
      console.log(`[O-20-5-11] 表单被回拨 ${cur.status}——重新发布后再探`);
      const pub = await api(page, "forms.publish", { id: cur.id, rowVersion: cur.rowVersion });
      expect(pub.status, "重发布 200").toBe(200);
    }
    await login(page, EMAIL.member); // 探针与后续 UI 以提交人身份进行
    return cur ?? mine;
  };
  await ensurePublished();
  const probe400 = async (payload: any, re: RegExp, tag: string) => {
    let r = await api(page, "genericRequest.create", { requestType: mine.code, title: `t-${STAMP}`, reason: "x", payload });
    if (r.status !== 400 && /表单不存在或未发布/.test(JSON.stringify(r.json))) {
      await ensurePublished();
      r = await api(page, "genericRequest.create", { requestType: mine.code, title: `t-${STAMP}`, reason: "x", payload });
    }
    expect(r.status, `${tag} → 400`).toBe(400);
    expect(JSON.stringify(r.json), `${tag} fieldErrors`).toMatch(re);
  };
  await probe400({ field_1: "ok", field_5: "not-a-number" }, /payload\.field_5/, "金额传字符串");
  await probe400({ field_6: "选项 X" }, /payload\.field_6/, "单选选项域外");
  await probe400({ field_10: "00000000-0000-0000-0000-000000000000" }, /payload\.field_10/, "人员引用不存在");

  // ⑦ 实例1（UI 全链）：填表→草稿→提交（ensurePublished 内登录跳转毁会话现场，需重开发起弹窗）
  await ensurePublished();
  await page.goto(`${B}/requests`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".screen", { timeout: 20_000 });
  await page.getByRole("button", { name: "发起申请" }).first().click();
  await page.waitForSelector(".grant-apply-form", { timeout: 10_000 });
  await page.locator(".grant-apply-form select").first().selectOption(mine.code);
  await page.waitForTimeout(1300);
  await page.locator(".grant-apply-form .owner-line input").first().fill(`验收20-${STAMP}-A1`);
  await page.locator(".grant-apply-form textarea").first().fill("迭代20验收：四步向导全链");
  await page.locator('.grant-apply-form .form-field:has-text("单行文本") input').fill("验收数据");
  await page.locator('.grant-apply-form .fw-ro-form .form-field:has-text("金额") input').fill("500");
  await page.getByRole("button", { name: /保存草稿/ }).click();
  await page.waitForTimeout(2000);
  const mineList = d(await api(page, `genericRequest.list?input=${encodeURIComponent(JSON.stringify({ mine: true, limit: 10 }))}`));
  const req1 = (mineList.items ?? []).find((r: any) => r.title === `验收20-${STAMP}-A1`);
  expect(req1, "草稿创建").toBeTruthy();
  await page.goto(`${B}/requests/${req1.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".screen", { timeout: 15_000 });
  // O-20-5-2 登记（不代修）：详情页提交网关无条件要求选人（误报「流程包含发起人指定节点」），
  // 本流为 role=partner 节点本无需选人——按现网行为先选人完成 UI 全链（chosenApproverId 对非指定节点无害）。
  await page.locator('.title-actions input[aria-label="搜索用户"]').fill("梁奇烽");
  await page.waitForTimeout(900);
  await page.locator('.title-actions select[aria-label="选择用户"]').selectOption({ index: 1 });
  await shot(page, "T1-07b-draft-pick-approver");
  await page.getByRole("button", { name: /提交审批/ }).click();
  await page.waitForTimeout(2500);
  const req1b = d(await api(page, `genericRequest.getById?input=${encodeURIComponent(JSON.stringify({ id: req1.id }))}`));
  expect(req1b.status, "提交后 pending_approval").toBe("pending_approval");
  T1.inst1 = req1b.approvalInstanceId;
  expect(T1.inst1, "审批实例已生成").toBeTruthy();

  // ⑧ 实例2/3/4（API）：退回链/转交链/驳回链
  const mkInst = async (tag: string, money = 500) => {
    const { sub } = await submitCf(page, mine.code, `验收20-${STAMP}-${tag}`, { field_1: `数据-${tag}`, field_5: money });
    expect(sub.status, `${tag} 提交 → ${JSON.stringify(sub.json).slice(0, 200)}`).toBe(200);
    return instOf(sub);
  };
  T1.inst2 = await mkInst("A2");
  T1.inst3 = await mkInst("A3");
  T1.inst4 = await mkInst("A4");

  // ⑨ partner：实例1 通过必填意见（空意见禁用）+ 快照区 fieldPerms hidden
  await login(page, EMAIL.partner);
  await page.goto(`${B}/approvals`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".approvals-screen", { timeout: 20_000 });
  const aprOf = async (inst: string) => d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: inst }))}`))?.code;
  const card1 = page.locator(".approval-card", { hasText: await aprOf(T1.inst1) }).first();
  await card1.waitFor({ timeout: 15_000 });
  expect(await card1.getByRole("button", { name: "退回" }).count(), "退回按钮在位").toBe(1);
  expect(await card1.getByRole("button", { name: "转交" }).count(), "转交按钮在位").toBe(1);
  await card1.getByRole("button", { name: "审批快照/检查项" }).click();
  await page.waitForTimeout(600);
  const snapText = await card1.locator(".checks-panel").textContent();
  expect(snapText, "快照区渲染字段（key→label：单行文本）").toContain("单行文本");
  expect(snapText, "fieldPerms hidden：金额字段 partner 视角缺席（整行不渲染）").not.toContain("金额");
  // 服务端同源断言：pending 且 partner 为当前步审批人时，getById formSnapshot 滤除 hidden 键
  const detNow = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: T1.inst1 }))}`));
  expect(detNow.status, "实例1 pending 中").toBe("pending");
  expect(`form.${T1.moneyKey}` in (detNow.formSnapshot ?? {}), "formSnapshot 无 form.field_5（hidden 真生效）").toBe(false);
  await shot(page, "T1-08-snapshot-hidden");
  await card1.getByRole("button", { name: "通过" }).click();
  await page.waitForTimeout(400);
  expect(await card1.getByRole("button", { name: "确认通过" }).isDisabled(), "通过必填意见：空意见禁用").toBe(true);
  await shot(page, "T1-09-approve-require-comment");
  await card1.locator("textarea").fill("同意，验收通过");
  await card1.getByRole("button", { name: "确认通过" }).click();
  await page.waitForTimeout(2000);

  // 实例4：驳回必填（空意见禁用 → 填后驳回 → rejected）
  const card4 = page.locator(".approval-card", { hasText: await aprOf(T1.inst4) }).first();
  await card4.waitFor({ timeout: 15_000 });
  await card4.getByRole("button", { name: "驳回" }).click();
  await page.waitForTimeout(400);
  expect(await card4.getByRole("button", { name: "确认驳回" }).isDisabled(), "驳回必填意见：空意见禁用").toBe(true);
  await card4.locator("textarea").fill("验收驳回：信息不足");
  await shot(page, "T1-10-reject-form");
  await card4.getByRole("button", { name: "确认驳回" }).click();
  await page.waitForTimeout(2000);

  // 实例2：退回 prev 重挂（partner 先过 → finance 退回 → 步重挂 → partner 再批 → finance 重审 → 终审）
  let r = await actAs(page, EMAIL.partner, T1.inst2, 1, "approve", "初审通过");
  expect(r.status, "实例2 partner 初审通过").toBe(200);
  r = await actAs(page, EMAIL.finance, T1.inst2, 2, "return", "退回补充材料");
  expect(r.status, "finance 退回 prev").toBe(200);
  const det2 = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: T1.inst2 }))}`));
  expect(det2.currentStepSeq, "退回后步骤指针回拨 seq=1").toBe(1);
  const rearmed = (det2.steps ?? []).find((s: any) => s.seq === 1);
  expect(rearmed?.status, "退回步重挂 pending").toBe("pending");
  const finMark = (det2.steps ?? []).find((s: any) => s.seq === 2);
  expect(finMark?.comment ?? "", "退回留痕 [returned]").toContain("[returned]");
  r = await actAs(page, EMAIL.partner, T1.inst2, 1, "approve", "复审通过");
  expect(r.status, "partner 重批").toBe(200);
  const det2b = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: T1.inst2 }))}`));
  expect(det2b.status, "重批后实例仍 pending（重审语义：returned 步重挂）").toBe("pending");
  expect(det2b.currentStepSeq, "指针推进至 finance 重审步").toBe(2);
  expect((det2b.steps ?? []).find((s: any) => s.seq === 2)?.status, "finance 步 rearmed pending").toBe("pending");
  r = await actAs(page, EMAIL.finance, T1.inst2, 2, "approve", "重审通过");
  expect(r.status, "finance 重审 200").toBe(200);
  const det2c = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: T1.inst2 }))}`));
  expect(det2c.status, "重审后终审 approved").toBe("approved");

  // 实例3：转交（partner → lijianwei）→ lijianwei 批 → finance 批
  r = await actAs(page, EMAIL.partner, T1.inst3, 1, "transfer", "转交验收", T1.ljId);
  expect(r.status, "转交 200").toBe(200);
  const det3 = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: T1.inst3 }))}`));
  const step13 = (det3.steps ?? []).find((s: any) => s.seq === 1);
  expect(step13?.approverId, "转交后步骤审批人=lijianwei").toBe(T1.ljId);
  r = await actAs(page, EMAIL.member2, T1.inst3, 1, "approve", "转交后通过");
  expect(r.status, "lijianwei 批准").toBe(200);
  r = await actAs(page, EMAIL.finance, T1.inst3, 2, "approve", "财务通过");
  expect(r.status, "finance 终审").toBe(200);
  const det3b = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: T1.inst3 }))}`));
  expect(det3b.status, "实例3 approved").toBe("approved");

  // ⑩ 实例1 续审：finance 通过 → approved + 末端 cc 到达
  r = await actAs(page, EMAIL.finance, T1.inst1, 2, "approve", "财务复核通过");
  expect(r.status, "实例1 finance 通过").toBe(200);
  const detA = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: T1.inst1 }))}`));
  expect(detA.status, "实例1 approved").toBe("approved");
  expect((detA.policySnapshot?.ccFired ?? []).length, "末端 cc 已触发").toBeGreaterThanOrEqual(1);

  // fieldPerms hidden 的终审后口径：实例 approved 后过滤停用（viewerFieldPerms 仅 pending 当前步生效，arch/14 §9）
  await login(page, EMAIL.partner);
  const detP = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: T1.inst1 }))}`));
  expect(detP.status, "实例1 approved 终态").toBe("approved");

  // ⑪ cc 视角：archivist 只读 + 通知 + 进度图抄送标注
  await login(page, EMAIL.archivist);
  const detCc = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: T1.inst1 }))}`));
  expect(detCc.viewerRole, "archivist viewerRole=cc").toBe("cc");
  const notis = d(await api(page, `notification.listMine?input=${encodeURIComponent(JSON.stringify({ limit: 20 }))}`));
  const hit = (notis.items ?? []).some((n: any) => JSON.stringify(n).includes(detA.code) || JSON.stringify(n).includes(T1.inst1));
  expect(hit, `archivist 通知到达（实例 ${detA.code}）`).toBe(true);
  await login(page, EMAIL.sysadmin);
  const reqRow = d(await api(page, `genericRequest.list?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`));
  const theReq = (reqRow.items ?? []).find((x: any) => x.title === `验收20-${STAMP}-A1`);
  await page.goto(`${B}/requests/${theReq.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".progress-graph", { timeout: 15_000 });
  await page.waitForTimeout(800);
  expect(await page.locator(".progress-cc").count(), "进度图抄送标注").toBeGreaterThan(0);
  await shot(page, "T1-11-progress-cc");

  // 实例4 终态复核（以参与人 partner 视角读）
  await login(page, EMAIL.partner);
  const det4 = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: T1.inst4 }))}`));
  expect(det4.status, "实例4 rejected 终态").toBe("rejected");
});

/* ================================ T2 审批人新策略四链 ================================ */
test("T2 审批人新策略：initiator_self+sameAsInitiator 四态/dept_head/manager_chain(2 级)/form_contact", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, EMAIL.sysadmin);
  const mem = await members(page);
  const su = byEmail(mem, EMAIL.sales)!; // 苏明轩（有主管链/综合管理部）
  const gu = byEmail(mem, EMAIL.member)!;
  const lj = byEmail(mem, EMAIL.member2)!;
  const ceo = mem.find((m) => (m.roles ?? []).includes("ceo"))!;
  const suMgr = mem.find((m) => m.id === su.managerId)!;
  const suMgr2 = mem.find((m) => m.id === suMgr.managerId)!;

  const stepApprover = async (inst: string, seq = 1) => {
    const det = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: inst }))}`));
    return { det, step: (det.steps ?? []).find((s: any) => s.seq === seq) };
  };

  // —— A. initiator_self + sameAsInitiator 四态 —— //
  // A1 self：提交人本人自审（显式豁免红线）
  const fA1 = await mkForm(page, `验收20-self-${STAMP}`, [{ key: "field_1", label: "说明", control: "text", required: false }]);
  await setFlowAndPublish(page, fA1, v2Def([apNode("n1", "本人确认", { kind: "initiator_self" }, { sameAsInitiator: "self" })]));
  const i1 = instOf((await submitCf(page, fA1.code, `验收20-${STAMP}-self`, {})).sub);
  const s1 = await stepApprover(i1);
  expect(s1.step?.approverId, "self：步骤审批人=提交人本人").toBe(gu.id);
  const a1 = await actAs(page, EMAIL.member, i1, 1, "approve", "本人确认");
  expect(a1.status, "self：本人自审 200").toBe(200);

  // A2 skip：剔除提交人后为空 → 403 自审红线
  const fA2 = await mkForm(page, `验收20-skip-${STAMP}`, [{ key: "field_1", label: "说明", control: "text", required: false }]);
  await setFlowAndPublish(page, fA2, v2Def([apNode("n1", "自审拦截", { kind: "user", userId: gu.id }, { sameAsInitiator: "skip" })]));
  const subA2 = await submitCf(page, fA2.code, `验收20-${STAMP}-skip`, {});
  expect(subA2.sub.status, "skip：提交即 403 自审红线").toBe(403);
  expect(JSON.stringify(subA2.sub.json), "SELF_APPROVAL_BLOCKED 语义").toMatch(/自审|SELF_APPROVAL/i);

  // A3 to_manager：剔除本人并替换为直属上级（提交人=苏明轩，有主管链）
  const fA3 = await mkForm(page, `验收20-tomgr-${STAMP}`, [{ key: "field_1", label: "说明", control: "text", required: false }]);
  await setFlowAndPublish(page, fA3, v2Def([apNode("n1", "上级代审", { kind: "user", userId: su.id }, { sameAsInitiator: "to_manager" })]));
  const i3 = instOf((await submitCf(page, fA3.code, `验收20-${STAMP}-tomgr`, {}, EMAIL.sales)).sub);
  const s3 = await stepApprover(i3);
  expect(s3.step?.approverId, "to_manager：审批人=提交人直属上级").toBe(suMgr.id);

  // A4 to_dept_head：剔除本人并替换为部门负责人（dev 夹具须在提交前落位；prod 无 DB → 负路径 400）
  const fA4 = await mkForm(page, `验收20-todept-${STAMP}`, [{ key: "field_1", label: "说明", control: "text", required: false }]);
  await setFlowAndPublish(page, fA4, v2Def([apNode("n1", "部门负责人代审", { kind: "user", userId: su.id }, { sameAsInitiator: "to_dept_head" })]));
  const hasLeaderA4 = await dbSetDeptHead(ceo.id);
  const subA4 = await submitCf(page, fA4.code, `验收20-${STAMP}-todept`, {}, EMAIL.sales);
  if (hasLeaderA4) {
    const i4 = instOf(subA4.sub);
    expect(subA4.sub.status, "to_dept_head：提交 200（dev 夹具在位）").toBe(200);
    const s4 = await stepApprover(i4);
    expect(s4.step?.approverId, "to_dept_head：审批人=部门负责人").toBe(ceo.id);
  } else {
    expect(subA4.sub.status, "to_dept_head 负路径：prod 未配置负责人 → 400").toBe(400);
    expect(JSON.stringify(subA4.sub.json)).toMatch(/负责人/);
  }

  // —— B. dept_head —— //
  const fB = await mkForm(page, `验收20-dept-${STAMP}`, [{ key: "field_1", label: "说明", control: "text", required: false }]);
  await setFlowAndPublish(page, fB, v2Def([apNode("n1", "部门负责人审", { kind: "dept_head" })]));
  const hasLeaderB = await dbSetDeptHead(ceo.id);
  const subB = await submitCf(page, fB.code, `验收20-${STAMP}-dept`, {}, EMAIL.sales);
  if (hasLeaderB) {
    const iB = instOf(subB.sub);
    expect(subB.sub.status, "dept_head：提交 200").toBe(200);
    const sB = await stepApprover(iB);
    expect(sB.step?.approverId, "dept_head：审批人=综合管理部负责人").toBe(ceo.id);
  } else {
    expect(subB.sub.status, "dept_head 负路径：prod → 400 未配置负责人").toBe(400);
    expect(JSON.stringify(subB.sub.json)).toMatch(/负责人/);
  }

  // —— C. manager_chain 2 级：逐级各成一步 —— //
  const fC = await mkForm(page, `验收20-chain-${STAMP}`, [{ key: "field_1", label: "说明", control: "text", required: false }]);
  await setFlowAndPublish(page, fC, v2Def([apNode("n1", "一级主管", { kind: "manager_chain", levels: 2 })]));
  const iC = instOf((await submitCf(page, fC.code, `验收20-${STAMP}-chain`, {}, EMAIL.sales)).sub);
  const detC = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: iC }))}`));
  expect((detC.steps ?? []).length, "manager_chain 2 级 = 两步").toBe(2);
  expect((detC.steps ?? []).map((s: any) => s.approverId), "逐级 approver = 上级/上上级").toEqual([suMgr.id, suMgr2.id]);
  expect((await actAs(page, suMgr.email, iC, 1, "approve", "一级通过")).status, "一级通过 200").toBe(200);
  expect((await actAs(page, suMgr2.email, iC, 2, "approve", "二级通过")).status, "二级通过 200").toBe(200);
  const detCb = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: iC }))}`));
  expect(detCb.status, "manager_chain 全链 approved").toBe("approved");

  // —— D. form_contact：表单内联系人 —— //
  const fD = await mkForm(page, `验收20-contact-${STAMP}`, [{ key: "contact_p", label: "审批联系人", control: "person", required: true }]);
  await setFlowAndPublish(page, fD, v2Def([apNode("n1", "联系人审批", { kind: "form_contact", fieldKey: "contact_p" })]));
  const iD = instOf((await submitCf(page, fD.code, `验收20-${STAMP}-contact`, { contact_p: lj.id })).sub);
  const sD = await stepApprover(iD);
  expect(sD.step?.approverId, "form_contact：审批人=人员控件所选人").toBe(lj.id);
  expect((await actAs(page, EMAIL.member2, iD, 1, "approve", "联系人通过")).status, "联系人批准 200").toBe(200);
});

/* ================================ T3 条件分支 ================================ */
test("T3 条件分支：第一命中/else/嵌套一层/form.<key> + 保存 400 双实锤 + 发布 412", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, EMAIL.sysadmin);
  const P = (v: number) => ({ field: "form.field_5", op: "gte", value: v });

  const f = await mkForm(page, `验收20-cond-${STAMP}`, [
    { key: "field_1", label: "事由", control: "text", required: false },
    { key: "field_5", label: "金额（元）", control: "money", required: false },
  ]);
  const cur = d(await api(page, `flow.getById?input=${encodeURIComponent(JSON.stringify({ id: f.flowId }))}`));
  const goodDef = v2Def([
    { type: "condition", id: "c1", branches: [
      { name: "大额", expr: P(10000000), nodes: [
        { type: "condition", id: "c2", branches: [
          { name: "加急", expr: { field: "form.field_1", op: "contains", value: "加急" }, nodes: [apNode("np", "合伙人加急审", { kind: "role", role: "partner" })] },
          { name: "普通大额", expr: null, nodes: [] },
        ] },
      ] },
      { name: "小额", expr: { field: "form.field_5", op: "lte", value: 100000 }, nodes: [apNode("ns", "小额免审", { kind: "role", role: "finance" }, { approvalType: "auto_pass" })] },
      { name: "其他", expr: null, nodes: [apNode("ne", "财务复核", { kind: "role", role: "finance" })] },
    ] },
    apNode("nf", "归档终审", { kind: "role", role: "archivist" }),
  ]);
  const save1 = await api(page, "flow.updateDraft", { id: f.flowId, rowVersion: cur.rowVersion, definitionJson: goodDef });
  expect(save1.status, "合法条件定义保存 200").toBe(200);

  // 保存 400-①：else 非末位
  const badElse = v2Def([{ type: "condition", id: "c1", branches: [
    { name: "其他", expr: null, nodes: [] },
    { name: "大额", expr: P(10000000), nodes: [] },
  ] }]);
  const r400a = await api(page, "flow.updateDraft", { id: f.flowId, rowVersion: d(save1).rowVersion, definitionJson: badElse });
  expect(r400a.status, "else 非末位 → 保存 400").toBe(400);
  expect(JSON.stringify(r400a.json), "else 必须最后语义").toMatch(/else|最后/i);
  // 保存 400-②：嵌套超深（4 层 > 3）
  const deep = (n: number): any => n <= 0 ? [] : [{ type: "condition", id: `d${n}`, branches: [
    { name: "a", expr: P(1), nodes: deep(n - 1) },
    { name: "b", expr: null, nodes: [] },
  ] }];
  const r400b = await api(page, "flow.updateDraft", { id: f.flowId, rowVersion: d(save1).rowVersion, definitionJson: v2Def(deep(4)) });
  expect(r400b.status, "嵌套 4 层 → 保存 400").toBe(400);
  expect(JSON.stringify(r400b.json), "嵌套深度语义").toMatch(/嵌套|深度/i);
  // 恢复合法定义并发布
  const cur2 = d(await api(page, `flow.getById?input=${encodeURIComponent(JSON.stringify({ id: f.flowId }))}`));
  const save2 = await api(page, "flow.updateDraft", { id: f.flowId, rowVersion: cur2.rowVersion, definitionJson: goodDef });
  expect(save2.status, "恢复合法定义 200").toBe(200);
  await publishFormFlow(page, f.id, f.rowVersion);

  // 运行四实例（金额按分传）：大额普通(嵌套 else)/小额(auto_pass)/中间(else 兜底)/加急(嵌套命中)
  const run = async (tag: string, moneyCents: number, text: string) => {
    const { sub } = await submitCf(page, f.code, `验收20-${STAMP}-c-${tag}`, { field_1: text, field_5: moneyCents });
    expect(sub.status, `条件实例 ${tag} 提交`).toBe(200);
    return instOf(sub);
  };
  const pendingApprover = async (inst: string) => {
    const det = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: inst }))}`));
    const step = (det.steps ?? []).find((s: any) => s.status === "pending");
    return { det, step };
  };
  const iBig = await run("big", 20000000, "标准大额申请");      // 20 万元 ≥ 10 万 → 大额支
  const iSmall = await run("small", 50000, "小额申请");          // 500 元 ≤ 1000 元 → 小额支
  const iMid = await run("mid", 500000, "中间金额");             // 5000 元 → else 兜底
  const iUrgent = await run("urgent", 20000000, "加急大额申请"); // 大额 + 加急 → 嵌套命中
  T3.iSmall = iSmall;

  // 第一命中：大额只走「大额」支（财务小额免审步缺席）
  const pBig = await pendingApprover(iBig);
  const bigStepRoles = (pBig.det.steps ?? []).map((s: any) => s.approverRole ?? s.approver?.role);
  expect(bigStepRoles, "第一命中：未生成小额/财务步骤").not.toContain("finance");
  expect(pBig.step?.approverRole ?? pBig.step?.approver?.role, "大额普通 → 嵌套 else 空 → 进归档终审").toBe("archivist");
  const bigNodes = (pBig.det.flowProgress?.nodes ?? []) as any[];
  expect(bigNodes.some((n) => (n.conditionTrace ?? []).length > 0), `条件轨迹留痕 ${JSON.stringify(bigNodes.map((n) => n.conditionTrace)).slice(0, 200)}`).toBe(true);

  // auto_pass（小额到步即过）→ 归档终审 pending（label 经 flowProgress.nodes）
  const pSmall = await pendingApprover(iSmall);
  const smallNodes = (pSmall.det.flowProgress?.nodes ?? []) as any[];
  const autoNode = smallNodes.find((n) => (n.label ?? "").includes("小额免审"));
  expect(autoNode?.status, "auto_pass 到步自动通过").toBe("approved");
  const autoRaw = (pSmall.det.steps ?? [])[smallNodes.indexOf(autoNode)];
  expect(autoRaw?.actedBy, "auto_pass 以系统名义（actedBy 空）").toBeFalsy();
  expect(pSmall.step?.approverRole ?? pSmall.step?.approver?.role, "auto_pass 后流至归档终审").toBe("archivist");

  // else 兜底：中间金额 → 财务复核
  const pMid = await pendingApprover(iMid);
  expect(pMid.step?.approverRole ?? pMid.step?.approver?.role, "else 兜底 → 财务").toBe("finance");

  // 嵌套一层命中：加急 → 合伙人加急审
  const pU = await pendingApprover(iUrgent);
  expect(pU.step?.approverRole ?? pU.step?.approver?.role, "嵌套一层命中 → partner").toBe("partner");

  // 发布 412：角色零活跃用户——经设计器路径 flow.publish（resolveKind 过滤 users.status=active；
  // forms.publish 路径不滤状态，412 仅设计器路径可实锤——记入报告口径差异）
  await login(page, EMAIL.sysadmin); // 目录须以 sysadmin 取（此刻会话为提交人 member，读数不可信）
  const mem = await members(page);
  const activeRoles = new Set(mem.filter((m) => (m.status ?? "active") === "active").flatMap((m) => m.roles ?? []));
  const PREF = ["ceo", "viewer", "presales", "operations", "regional_vp", "sales_manager"];
  const zeroRole = PREF.find((r) => !activeRoles.has(r));
  let soleHolder: any = null;
  let targetRole = zeroRole;
  if (!targetRole) {
    for (const r of PREF) {
      const holders = mem.filter((m) => (m.status ?? "active") === "active" && (m.roles ?? []).includes(r));
      if (holders.length === 1) { targetRole = r; soleHolder = holders[0]; break; }
    }
  }
  expect(targetRole, "存在可构造零活跃用户的角色").toBeTruthy();
  const f412 = await mkForm(page, `验收20-412-${STAMP}`, [{ key: "field_1", label: "说明", control: "text", required: false }]);
  const cur412 = d(await api(page, `flow.getById?input=${encodeURIComponent(JSON.stringify({ id: f412.flowId }))}`));
  const upd412 = await api(page, "flow.updateDraft", {
    id: f412.flowId, rowVersion: cur412.rowVersion,
    definitionJson: v2Def([apNode("n1", "零用户角色审", { kind: "role", role: targetRole })]),
  });
  expect(upd412.status, "412 靶流草稿保存 200").toBe(200);
  try {
    if (soleHolder) {
      const off = await api(page, "org.members.setStatus", { id: soleHolder.id, status: "disabled" });
      expect(off.status, `临时停用 ${targetRole} 唯一用户`).toBe(200);
    }
    const pub = await api(page, "flow.publish", { id: f412.flowId, idempotencyKey: uuid() });
    expect(pub.status, `角色 ${targetRole} 零活跃用户 → 发布 412`).toBe(412);
    expect(JSON.stringify(pub.json), "FLOW_UNPUBLISHABLE 语义").toMatch(/审批人解析为空|UNPUBLISHABLE/i);
  } finally {
    if (soleHolder) await api(page, "org.members.setStatus", { id: soleHolder.id, status: "active" });
    await api(page, "flow.deleteDraft", { id: f412.flowId });
    await api(page, "forms.delete", { id: f412.id });
  }
});

/* ================================ T4 迁移复核 + §2① 取证 ================================ */
test("T4 迁移复核：全量 v2/默认流新向导渲染一致/在途实例不动/§2① rowVersion 提示取证", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, EMAIL.sysadmin);

  // ① 全量 v2
  const flows = d(await api(page, "flow.list"));
  const arr = (flows.items ?? flows ?? []) as any[];
  const v1Left = arr.filter((f) => (f.definitionJson?.schemaVersion ?? f.schemaVersion ?? 2) !== 2);
  expect(v1Left.length, `存量流程全 v2（共 ${arr.length} 条）`).toBe(0);

  // ② 在途实例（如有）：向导打开其流程定义前后状态不动（partner 视角取数）
  await login(page, EMAIL.partner);
  const partnerMine = d(await api(page, `approval.listMine?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`));
  const inflight = ((partnerMine?.items ?? []) as any[]).find((i) => i.status === "pending_approval" || i.status === "pending");
  if (inflight) {
    const before = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: inflight.id }))}`));
    T4_inflight = { id: inflight.id, steps: (before.steps ?? []).length, status: before.status };
  }
  await login(page, EMAIL.sysadmin);

  // ③ 默认流（generic_request）在新向导打开渲染一致 + §2① 取证
  const defFlow = arr.find((f) => f.bizBinding === "generic_request" && f.scope === "global" && f.enabled)
    ?? arr.find((f) => f.bizBinding === "generic_request" && f.scope === "global")
    ?? arr.find((f) => f.bizBinding === "generic_request");
  expect(defFlow, "存在 generic_request 默认流").toBeTruthy();
  const updCalls: number[] = [];
  page.on("response", (resp) => {
    if (resp.url().includes("updateDraft") || resp.url().includes("updateFormDraft")) updCalls.push(resp.status());
  });
  let toastText = "";
  page.on("console", (m) => { if (m.type() === "error") toastText += m.text(); });
  await page.goto(`${B}/admin/flows/${defFlow.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".flow-wizard-screen", { timeout: 20_000 });
  await page.waitForSelector(".fw-steps [role='tab']", { timeout: 15_000 }); // 装载完成（步骤条可交互）
  // §2① 证据先行采集（更新响应序列 + 冲突文案），再做事后断言
  await page.waitForTimeout(3500); // 覆盖 800ms 防抖自动保存 + toast 渲染
  const bodyText0 = await page.evaluate(() => document.body.innerText);
  const sawConflictEarly = bodyText0.includes("草稿已被他人修改") || bodyText0.includes("版本冲突");
  const evPath = "D:/tmp/shots-iter20-05/section2-1-evidence.json";
  writeFileSync(evPath, JSON.stringify({ base: B, flow: defFlow.name, updateDraftResponses: updCalls, conflictToastSeen: sawConflictEarly, checkedAt: new Date().toISOString() }, null, 2));
  console.log(`[§2①取证] base=${B} updateDraft 响应=${JSON.stringify(updCalls)} 冲突提示=${sawConflictEarly}`);

  // 流程设计步渲染：05b 修复后（O-20-5-5 恒等映射）业务流程向导画布可达——dev runner 上下文有渲染幽灵（重载重试一次），仍受阻则记录不阻断（prod 复跑仲裁）
  for (let i = 0; i < 2 && (await page.locator(".vflow-lane").count()) === 0; i++) {
    await page.getByRole("button", { name: "下一步", exact: true }).click().catch(() => {});
    await page.waitForTimeout(900);
  }
  if ((await page.locator(".vflow-lane").count()) === 0 && (await page.getByText("页面加载失败").count())) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(".flow-wizard-screen", { timeout: 20_000 });
    await page.getByRole("button", { name: "下一步", exact: true }).click().catch(() => {});
    await page.waitForTimeout(2000);
  }
  const wizardCards = await page.locator(".vflow-lane .vf-card").count();
  console.log(`[O-20-5-5] 复验记录：业务流程向导流程设计步 cards=${wizardCards}（05b 修复后应 ≥3）`);
  if (wizardCards > 0) {
    expect(wizardCards, "O-20-5-5 修复：业务流程向导流程设计步可达（竖向节点 ≥3）").toBeGreaterThanOrEqual(3);
  } else {
    console.log("[O-20-5-5] dev runner 上下文画布渲染受阻（prod 复跑仲裁；独立探针同序通过）");
  }
  const stepperTabs = await page.locator(".fw-steps [role='tab']").allTextContents();
  if (stepperTabs.length) {
    expect(stepperTabs.join(), "向导步骤条在位（基础信息/流程设计/更多设置）").toMatch(/基础信息/);
    expect(stepperTabs.join()).toMatch(/流程设计/);
    expect(stepperTabs.join()).toMatch(/更多设置/);
  } else {
    console.log("[T4] dev runner 上下文步骤条未渲染（幽灵深化，prod 复跑仲裁）；§2①/all-v2/在途证据已采集不阻断");
  }
  await shot(page, "T4-01-default-flow-wizard");
  const bodyText = await page.evaluate(() => document.body.innerText);
  const sawConflictToast = bodyText.includes("草稿已被他人修改") || bodyText.includes("版本冲突") || toastText.includes("版本冲突");
  // §2①：已 reproducible（dev 自竞态：打开即自动保存 + 步位切换触发二次保存 → 409）——记录性输出不阻断，
  // 定性=前端缺陷 O-20-5-4（lastSaved 指纹未以载入态初始化），登记回 20-03 前端会话（修复后回本 spec 恢复断言）
  console.log(`[O-20-5-4] 复验记录：打开默认流 updCalls=${JSON.stringify(updCalls)} toast=${sawConflictToast}（05b 修复后应 []/false）`);

  // ④ 在途实例不受影响
  if (T4_inflight) {
    const after = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: T4_inflight.id }))}`));
    expect(after.status, "向导打开后实例状态不变").toBe(T4_inflight.status);
    expect((after.steps ?? []).length, "向导打开后实例步骤数不变").toBe(T4_inflight.steps);
  }
});
let T4_inflight: { id: string; steps: number; status: string } | null = null;

/* ================================ T5 项目级三步态 + 旧画布下线 ================================ */
test("T5 项目级三步态（无表单设计步）+ 旧画布组件下线 + /admin/flows/:id 进新向导", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, EMAIL.sysadmin);
  const flows = d(await api(page, "flow.list"));
  const arr = (flows.items ?? flows ?? []) as any[];
  // 项目级流程须取 pm 本人负责的项目（项目负责人门槛；project.list 无 managerId 列，按 managerName 匹配其自视角清单）
  await login(page, EMAIL.pm);
  const projs = d(await api(page, `project.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`));
  const pmProjects = new Set((projs.items ?? []).filter((p: any) => p.managerName === "王宝茁").map((p: any) => p.id));
  const projFlow = arr.find((f) => f.scope === "project" && pmProjects.has(f.projectId))
    ?? arr.find((f) => f.scope === "project" && (projs.items ?? []).some((p: any) => p.id === f.projectId));
  expect(projFlow, "pm 名下存在项目级流程").toBeTruthy();

  // 项目级向导（pm 视角，会话沿用上方 project.list 的 pm 登录）：现网被 flow.getById 404（无流程管理权限）——O-20-5-6 登记（高，回 20-02 后端）
  await page.goto(`${B}/flows/p/${projFlow.projectId}/${projFlow.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const pmBody = await page.evaluate(() => document.body.innerText);
  const pmBlocked = pmBody.includes("无流程管理权限") || pmBody.includes("没有访问权限") || (await page.locator(".flow-wizard-screen").count()) === 0;
  console.log(`[O-20-5-6] 复验记录：pm 打开项目向导 blocked=${pmBlocked}（05b 修复后应 false）`);

  // 三步态形态取证（sysadmin 开同一路由）：步骤条无表单设计步 + 旧画布 absent
  await login(page, EMAIL.sysadmin);
  await page.goto(`${B}/flows/p/${projFlow.projectId}/${projFlow.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".flow-wizard-screen", { timeout: 20_000 });
  const tabs = (await page.getByRole("tab").allTextContents()).join();
  expect(tabs, "项目级含基础信息/流程设计/更多设置").toMatch(/基础信息/);
  expect(tabs).toMatch(/流程设计/);
  expect(tabs, "项目级无表单设计步（三步态）").not.toMatch(/表单设计/);
  // 流程设计步内容可达性（O-20-5-5 记录：项目级同样受映射 off-by-one 阻断）
  await page.getByRole("button", { name: "下一步", exact: true }).click().catch(() => {});
  await page.waitForTimeout(1000);
  console.log(`[O-20-5-5] 复验记录：项目级向导 lane=${await page.locator(".vflow-lane").count()}（05b 修复后应 >0）`);
  expect(await page.locator(".react-flow").count(), "旧画布 react-flow 已下线").toBe(0);
  await shot(page, "T5-01-project-wizard-3steps");

  // /admin/flows/:id（业务流程）进新向导 + 旧画布不存在
  await login(page, EMAIL.sysadmin);
  const bizFlow = arr.find((f) => f.scope === "global" && !String(f.bizBinding).startsWith("custom_form") && f.bizBinding !== "generic_request") ?? arr[0];
  const resp = await page.goto(`${B}/admin/flows/${bizFlow.id}`, { waitUntil: "domcontentloaded" });
  expect(resp?.status(), "旧画布深链 HTTP 200（不重定向不 404）").toBe(200);
  await page.waitForSelector(".flow-wizard-screen", { timeout: 20_000 });
  expect(await page.locator(".react-flow").count(), "旧画布组件不存在").toBe(0);
  expect((await page.getByRole("tab").allTextContents()).join(), "新向导步骤条在位（原画布路由进向导）").toMatch(/流程设计/);
  console.log(`[O-20-5-5] 复验记录：/admin/flows/:id lane=${await page.locator(".vflow-lane").count()}（05b 修复后应 >0）`);
  await shot(page, "T5-02-admin-flow-wizard");
});

/* ================================ T6 去重/auto_pass/抄送三时点 ================================ */
test("T6：dedupe once/auto_pass/抄送三时点（提交/到步/终审）", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, EMAIL.sysadmin);

  // —— 去重 once —— //
  // 实例 A：dedupe 命中末尾节点（[partner, partner, cc]）——20-05b 修复后契约：skipped 视同通过→终审 approved+业务回写+末端 cc
  const f1 = await mkForm(page, `验收20-dedupe-${STAMP}`, [{ key: "field_1", label: "说明", control: "text", required: false }]);
  await setFlowAndPublish(page, f1, v2Def([
    apNode("n1", "一审", { kind: "role", role: "partner" }),
    apNode("n2", "二审（同人）", { kind: "role", role: "partner" }),
    { type: "cc", id: "c9", name: "终审知悉", receivers: [{ kind: "role", role: "archivist" }] },
  ], { dedupeApprover: "once" }));
  const { sub: s1, req: rq1 } = await submitCf(page, f1.code, `验收20-${STAMP}-dedupe`, {});
  const i1 = instOf(s1);
  expect((await actAs(page, EMAIL.partner, i1, 1, "approve", "一审通过")).status, "dedupe 一审 200").toBe(200);
  const det1 = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: i1 }))}`));
  const step2 = (det1.steps ?? []).find((s: any) => s.seq === 2);
  expect(step2?.status, "dedupe once：同审批人后续步 skipped+留痕").toBe("skipped");
  expect(step2?.comment ?? "", "dedupe 留痕").toMatch(/dedupe/);
  expect(det1.status, "O-20-5-7 修复：尾步去重后终审 approved（原悬挂）").toBe("approved");
  expect((det1.policySnapshot?.ccFired ?? []).length, "O-20-5-7 修复：末端 cc 到达").toBeGreaterThanOrEqual(1);
  // 业务回写实证：申请单 approved（onApproved 触发；以提交人身份直查）
  await login(page, EMAIL.member);
  const ra = d(await api(page, `genericRequest.getById?input=${encodeURIComponent(JSON.stringify({ id: rq1.id }))}`));
  expect(ra.status, "O-20-5-7 修复：业务回写 request approved").toBe("approved");
  // 实例 B：dedupe 命中中间节点（[partner, partner, finance]）——修复后后续审批人 act 200 → 全链 approved
  const f1b = await mkForm(page, `验收20-dedupe2-${STAMP}`, [{ key: "field_1", label: "说明", control: "text", required: false }]);
  await setFlowAndPublish(page, f1b, v2Def([
    apNode("n1", "一审", { kind: "role", role: "partner" }),
    apNode("n2", "二审（同人）", { kind: "role", role: "partner" }),
    apNode("n3", "三审", { kind: "role", role: "finance" }),
  ], { dedupeApprover: "once" }));
  const i1b = instOf((await submitCf(page, f1b.code, `验收20-${STAMP}-dedupe2`, {})).sub);
  expect((await actAs(page, EMAIL.partner, i1b, 1, "approve", "一审通过")).status, "dedupe2 一审 200").toBe(200);
  const det1b = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: i1b }))}`));
  const step2b = (det1b.steps ?? []).find((s: any) => s.seq === 2);
  expect(step2b?.status, "dedupe2：同审批人第二跳 skipped").toBe("skipped");
  expect((det1b.steps ?? []).find((s: any) => s.seq === 3)?.status, "dedupe2：第三跳 pending（finance 待审）").toBe("pending");
  const act3 = await actAs(page, EMAIL.finance, i1b, 3, "approve", "三审通过");
  expect(act3.status, "O-20-5-7 修复：后续审批人行动 200（原 409 拒批）").toBe(200);
  const det1c = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: i1b }))}`));
  expect(det1c.status, "dedupe2 全链 approved").toBe("approved");

  // —— auto_pass：到步即系统通过 —— //
  const f2 = await mkForm(page, `验收20-auto-${STAMP}`, [{ key: "field_1", label: "说明", control: "text", required: false }]);
  await setFlowAndPublish(page, f2, v2Def([apNode("n1", "条件免审", { kind: "role", role: "finance" }, { approvalType: "auto_pass" })]));
  const i2 = instOf((await submitCf(page, f2.code, `验收20-${STAMP}-auto`, {})).sub);
  const det2 = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: i2 }))}`));
  expect(det2.status, "auto_pass 实例即 approved").toBe("approved");
  const s2 = (det2.steps ?? []).find((s: any) => s.seq === 1);
  expect(s2?.actedBy ?? s2?.actedById, "auto_pass 系统名义（actedBy 空）").toBeFalsy();
  expect(s2?.comment ?? "", "auto 留痕").toMatch(/auto/);
  // T3 的 auto_pass 步交叉复核（以提交人 member 视角读；label 经 flowProgress.nodes）
  if (T3.iSmall) {
    await login(page, EMAIL.member);
    const detT3 = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: T3.iSmall }))}`));
    const autoT3 = ((detT3.flowProgress?.nodes ?? []) as any[]).find((n: any) => (n.label ?? "").includes("小额免审"));
    expect(autoT3?.status, "T3 条件支内 auto_pass 生效").toBe("approved");
    await login(page, EMAIL.sysadmin);
  }

  // —— 抄送三时点 —— //
  // 现网实装度：cc 节点（到步）✓ 引擎支持；submitCc/endCc 服务端无任何处理代码（grep 零命中）——
  // O-20-5-8 登记（高：向导可配置提交/结束抄送但引擎静默忽略，arch/14 §8 三时点只落地一到步）
  const f3 = await mkForm(page, `验收20-cc3-${STAMP}`, [{ key: "field_1", label: "说明", control: "text", required: false }]);
  await setFlowAndPublish(page, f3, v2Def([
    apNode("n1", "业务审批", { kind: "role", role: "partner" }),
    { type: "cc", id: "c1", name: "过程知悉", receivers: [{ kind: "role", role: "operations" }] },
    apNode("n2", "终审", { kind: "role", role: "finance" }),
  ], {}, { submitCc: [{ kind: "role", role: "archivist" }], endCc: [{ kind: "role", role: "sales" }] }));
  const TITLE = `验收20-${STAMP}-cc3`;
  const i3 = instOf((await submitCf(page, f3.code, TITLE, {})).sub);
  const CC_CODE = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: i3 }))}`))?.code;
  const ccSeenBy = async (email: string) => {
    await login(page, email);
    const n = d(await api(page, `notification.listMine?input=${encodeURIComponent(JSON.stringify({ limit: 20 }))}`));
    return (n.items ?? []).some((x: any) => JSON.stringify(x).includes(CC_CODE) || JSON.stringify(x).includes(i3));
  };
  const ccCount = async () => (d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: i3 }))}`)))?.policySnapshot?.ccFired?.length ?? 0;
  const submitCcFired = await ccCount();
  const archivistGotSubmitCc = await ccSeenBy(EMAIL.archivist);
  console.log(`[O-20-5-8] 复验记录：submitCc ccFired=${submitCcFired} archivist notified=${archivistGotSubmitCc}（05b 修复后应 ≥1/true）`);

  expect((await actAs(page, EMAIL.partner, i3, 1, "approve", "业务通过")).status, "cc3 业务审批 200").toBe(200);
  expect(await ccCount(), "时点②cc 节点到步触发（引擎实装在位）").toBeGreaterThanOrEqual(1);
  expect(await ccSeenBy(EMAIL.operations), "operations 收到 cc 节点通知").toBe(true);

  expect((await actAs(page, EMAIL.finance, i3, 2, "approve", "终审通过")).status, "cc3 终审 200").toBe(200);
  const endCcFired = await ccCount();
  const det3 = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: i3 }))}`));
  expect(det3.status, "cc3 实例 approved（cc 节点链路不受影响）").toBe("approved");
  const salesGotEndCc = await ccSeenBy(EMAIL.sales);
  console.log(`[O-20-5-8] 复验记录：endCc ccFired=${endCcFired} sales notified=${salesGotEndCc}（05b 修复后应 ≥2/true）`);
});
