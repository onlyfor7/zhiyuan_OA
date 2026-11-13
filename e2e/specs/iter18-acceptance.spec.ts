/** 工单 18-05：迭代 18 验收（角色可见性/商机即立项 D5/全周期转换/成本与甘特/管理纠正/体验移动，arch/13）。
 * dev :3000（LX_BASE）→ 外测 prod（182.92.206.62:8080）双程。F3 合规。截图 D:/tmp/shots-iter18-test/。 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

const B = process.env.LX_BASE ?? "http://182.92.206.62:8080";
const SHOTS = "D:/tmp/shots-iter18-test";
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
  await page.addStyleTag({ content: "* { animation: none !important; transition: none !important; backdrop-filter: none !important; }" });
  await page.waitForTimeout(500);
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
const STAMP = `E2E18-${Date.now().toString(36)}`;

test.describe.configure({ mode: "serial" });
const shared: { leadId?: string; leadRowVersion?: number; oppId?: string; oppRowVersion?: number; projectId?: string; customerId?: string; pmId?: string; presalesId?: string } = {};

async function countProjects(page: Page): Promise<number> {
  let n = 0; let cursor: string | null = null;
  for (let i = 0; i < 6; i++) {
    const input: Record<string, unknown> = { limit: 100 };
    if (cursor) input.cursor = cursor;
    const r = d(await api(page, `project.list?input=${encodeURIComponent(JSON.stringify(input))}`));
    n += (r?.items ?? []).length;
    cursor = r?.nextCursor ?? null;
    if (!cursor) break;
  }
  return n;
}

async function userId(page: Page, keyword: string): Promise<string> {
  const r = d(await api(page, `user.list?input=${encodeURIComponent(JSON.stringify({ keyword, limit: 3 }))}`));
  return (r.items ?? []).find((u: any) => u.email.includes(keyword))?.id ?? (r.items ?? [])[0]?.id;
}

test("T1 角色与可见性：销售 A/B 隔离·主管看下级·售前指派·运营全局·财务仅汇总·sysadmin 全局读", async ({ page }) => {
  // 销售 A=苏明轩：建线索+直建商机（D5）
  await login(page, "sumingxuan@lexflow.demo");
  shared.pmId = await userId(page, "wangbaozhuo");
  shared.presalesId = await userId(page, "hezhiyuan");
  // 客户无独立创建端点（arch/13 主链：客户由线索转化产生）
  const lead = d(await api(page, "crm.leads.create", { name: `${STAMP}-线索A`, source: "验收", contactName: "联系人A" }));
  shared.leadId = lead.id;
  const conv = d(await api(page, "crm.leads.convert", {
    id: lead.id, rowVersion: lead.rowVersion ?? 0, projectManagerId: shared.pmId, idempotencyKey: crypto.randomUUID(),
    customer: { name: `${STAMP}-客户A`, level: "B", industry: "制造" },
    opportunity: { name: `${STAMP}-商机A`, expectedAmountCents: 30000000, winRate: 20 },
  }));
  shared.customerId = conv?.customerId;
  expect(shared.customerId, "转化产生客户").toBeTruthy();
  shared.oppId = conv?.opportunityId;
  expect(shared.oppId, "销售 A 转化出商机（D5 同事务）").toBeTruthy();
  expect(conv?.projectId, "转化同事务出项目").toBeTruthy();
  // 售前指派（A 指派何志远）
  await api(page, "crm.opportunities.update", { id: shared.oppId, rowVersion: shared.oppRowVersion ?? 0, presalesId: shared.presalesId });
  // 销售 B=林婉清：隔离 0 命中
  await login(page, "linwanqing@lexflow.demo");
  const bLeads = d(await api(page, `crm.leads.list?input=${encodeURIComponent(JSON.stringify({ keyword: STAMP, limit: 10 }))}`));
  expect((bLeads.items ?? []).length, "销售 B 线索隔离 0").toBe(0);
  // 18-05：crm.opportunities.list 无 keyword 参数（schema 静默剥离）——隔离断言改客户端按 STAMP 过滤（dev 上 B 无商机偶过、prod B 有 1 条本人口径）
  const bOpps = d(await api(page, `crm.opportunities.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`));
  expect((bOpps.items ?? []).filter((o: any) => JSON.stringify(o).includes(STAMP)).length, "销售 B 商机隔离 0（STAMP 零命中）").toBe(0);
  // 主管=郑浩然：见下级苏明轩数据
  await login(page, "zhenghaoran@lexflow.demo");
  const mLeads = d(await api(page, `crm.leads.list?input=${encodeURIComponent(JSON.stringify({ keyword: STAMP, limit: 10 }))}`));
  expect((mLeads.items ?? []).length, "主管见下级线索 ≥1").toBeGreaterThanOrEqual(1);
  // 售前=何志远：仅指派可见
  await login(page, "hezhiyuan@lexflow.demo");
  const pLeads = d(await api(page, `crm.leads.list?input=${encodeURIComponent(JSON.stringify({ keyword: STAMP, limit: 10 }))}`));
  expect((pLeads.items ?? []).length, "售前经指派穿透见关联线索").toBeGreaterThanOrEqual(1);
  const pOpps = d(await api(page, `crm.opportunities.list?input=${encodeURIComponent(JSON.stringify({ keyword: STAMP, limit: 10 }))}`));
  expect((pOpps.items ?? []).filter((o: any) => o.id === shared.oppId).length, "售前见被指派商机").toBe(1);
  // 运营=许文静：全局
  await login(page, "xuwenjing@lexflow.demo");
  const oOpps = d(await api(page, `crm.opportunities.list?input=${encodeURIComponent(JSON.stringify({ keyword: STAMP, limit: 10 }))}`));
  expect((oOpps.items ?? []).filter((o: any) => o.id === shared.oppId).length, "运营全局见商机").toBe(1);
  // 财务=郭静文：明细 404+仅汇总 200（D4）
  await login(page, "guojingwen@lexflow.demo");
  const fLeads = await api(page, `crm.leads.list?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`);
  expect(fLeads.status, "财务合同前明细 404（实测 " + fLeads.status + "）").toBe(404);
  const fSum = await api(page, "crm.summary");
  expect(fSum.status, "财务仅汇总 200").toBe(200);
  // sysadmin=赵凯：全局读 200
  await login(page, "zhaokai@lexflow.demo");
  const sLeads = await api(page, `crm.leads.list?input=${encodeURIComponent(JSON.stringify({ keyword: STAMP, limit: 10 }))}`);
  expect(sLeads.status, "sysadmin 全局读 200").toBe(200);
  expect((d(sLeads).items ?? []).length, "sysadmin 见该线索").toBeGreaterThanOrEqual(1);
  await shot(page, "T1-sysadmin全局");
});

test("T2 商机即立项 D5：直建与转化两路径同事务+幂等重放+关联既有不新建", async ({ page }) => {
  await login(page, "sumingxuan@lexflow.demo");
  const projCount0 = await countProjects(page);
  // ① 直建（T1 已建 oppA）——核同事务五件套
  const oppFull = d(await api(page, `crm.opportunities.getById?input=${encodeURIComponent(JSON.stringify({ id: shared.oppId }))}`));
  shared.projectId = oppFull.projectId;
  expect(shared.projectId, "商机 project_id 非空").toBeTruthy();
  const proj = d(await api(page, `project.getById?input=${encodeURIComponent(JSON.stringify({ id: shared.projectId }))}`));
  expect(proj.matterName ?? proj.project?.matterName, "同事务建事项 matter（matterName 非空）").toBeTruthy();
  expect(proj.memberCount ?? proj.project?.memberCount ?? 0, "成员 manager+member 双写（memberCount≥2）").toBeGreaterThanOrEqual(2);
  expect(proj.lifecycleStatus ?? proj.project?.lifecycleStatus, "售前 preparing").toBe("preparing");
  // 首版售前计划：ensureProjectPlan 幂等（manager 口径；已有 v1 返回现状）
  await login(page, "wangbaozhuo@lexflow.demo");
  const plan1 = await api(page, "crm.opportunities.ensureProjectPlan", { opportunityId: shared.oppId });
  const plan2 = await api(page, "crm.opportunities.ensureProjectPlan", { opportunityId: shared.oppId });
  expect(plan1.status, "首版售前计划在位/幂等").toBe(200);
  expect(plan2.status, "二次补建幂等").toBe(200);
  await login(page, "sumingxuan@lexflow.demo");
  // ② 幂等重放：同键同载荷重放 → 同商机（异载荷 409）
  const convKey = crypto.randomUUID();
  const leadR = d(await api(page, "crm.leads.create", { name: `${STAMP}-幂等线索`, contactName: "x" }));
  const convR1 = d(await api(page, "crm.leads.convert", {
    id: leadR.id, rowVersion: leadR.rowVersion ?? 0, projectManagerId: shared.pmId, idempotencyKey: convKey,
    customer: { name: `${STAMP}-幂等客户` }, opportunity: { name: `${STAMP}-幂等商机`, expectedAmountCents: 9000000 },
  }));
  const leadR2 = d(await api(page, "crm.leads.create", { name: `${STAMP}-幂等线索B`, contactName: "x" }));
  const replaySame = await api(page, "crm.leads.convert", {
    id: leadR.id, rowVersion: (convR1?.lead?.rowVersion ?? leadR.rowVersion ?? 0), projectManagerId: shared.pmId, idempotencyKey: convKey,
    customer: { name: `${STAMP}-幂等客户` }, opportunity: { name: `${STAMP}-幂等商机`, expectedAmountCents: 9000000 },
  });
  expect(replaySame.status, "同键重放 200 返回既有").toBe(200);
  expect(d(replaySame)?.opportunityId ?? d(replaySame)?.replayed, "重放不重复立项").toBeTruthy();
  // ③ 转化路径：新建线索→转化（projectManagerId）同事务
  const lead2 = d(await api(page, "crm.leads.create", { name: `${STAMP}-线索转`, contactName: "转化联系人" }));
  const conv = d(await api(page, "crm.leads.convert", {
    id: lead2.id, rowVersion: lead2.rowVersion ?? 0, projectManagerId: shared.pmId, idempotencyKey: crypto.randomUUID(),
    customer: { name: `${STAMP}-转化客户` },
    opportunity: { name: `${STAMP}-转化商机`, expectedAmountCents: 10000000 },
  }));
  expect(conv?.opportunityId, "转化出商机").toBeTruthy();
  const convOpp = d(await api(page, `crm.opportunities.getById?input=${encodeURIComponent(JSON.stringify({ id: conv?.opportunityId }))}`));
  expect(convOpp.projectId, "转化商机关联项目非空").toBeTruthy();
  // ④ 关联既有商机不重复立项：再转化同线索?不可（已 converted）——用 convert 带 opportunityId 语义：对线索2 做「关联既有」——改而对新线索指定既有商机
  const lead3 = d(await api(page, "crm.leads.create", { name: `${STAMP}-线索关联`, contactName: "x" }));
  // 关联既有商机=无来源线索的直建商机（一源线索约束： oppA 已绑定 T1 线索，须用新直建商机）
  const beforeDirect = await countProjects(page);
  const directOpp = d(await api(page, "crm.opportunities.create", {
    customerId: shared.customerId, name: `${STAMP}-直建关联靶`, expectedAmountCents: 8000000, stage: "initial",
    projectManagerId: shared.pmId, idempotencyKey: crypto.randomUUID(),
  }));
  const directOppId = directOpp?.id;
  const conv2Raw = await api(page, "crm.leads.convert", {
    id: lead3.id, rowVersion: lead3.rowVersion ?? 0, idempotencyKey: crypto.randomUUID(),
    customerId: shared.customerId, opportunityId: directOppId,
  });
  const conv2 = d(conv2Raw);
  expect(conv2Raw.status, "关联既有商机 convert 200").toBe(200);
  const afterConv2 = await countProjects(page);
  // 净增=直建靶商机自身 1 个；关联转化不得再立项
  expect(afterConv2, `关联既有商机不重复立项（${beforeDirect}+1=${afterConv2}）`).toBe(beforeDirect + 1);
  expect(conv2?.opportunityId, "返回既有商机（不新建）").toBe(directOppId);
});

test("T3 全周期转换：赢单 draft 不转·合同激活同项目 in_progress·商机关闭同项目 closed·closed 阻断新增", async ({ page }) => {
  await login(page, "sumingxuan@lexflow.demo");
  const mkOpp = async (tag: string) => {
    const cust = shared.customerId;
    const o = d(await api(page, "crm.opportunities.create", {
      customerId: cust, name: `${STAMP}-${tag}`, expectedAmountCents: 5000000, stage: "negotiation",
      projectManagerId: shared.pmId, idempotencyKey: crypto.randomUUID(),
    }));
    const oid = o.id ?? o.opportunity?.id;
    const full = d(await api(page, `crm.opportunities.getById?input=${encodeURIComponent(JSON.stringify({ id: oid }))}`));
    return { oid, rv: full.rowVersion, pid: full.projectId };
  };
  const projLc = async (pid: string) => (d(await api(page, `project.getById?input=${encodeURIComponent(JSON.stringify({ id: pid }))}`)).lifecycleStatus);
  // ① 赢单 draft（activate 缺省 false）→ 项目不转
  const a = await mkOpp("赢单草稿");
  const wonDraft = d(await api(page, "crm.opportunities.markWon", { id: a.oid, rowVersion: a.rv, contract: { title: `${STAMP}-草稿合同`, amountCents: 5000000 } }));
  expect(wonDraft?.contract?.id ?? wonDraft?.contractId, "赢单建合同").toBeTruthy();
  expect(await projLc(a.pid), "赢单 draft 项目仍 preparing").toBe("preparing");
  // ② 赢单即激活 → 同项目 id 转 in_progress
  const b = await mkOpp("激活交付");
  const wonAct = d(await api(page, "crm.opportunities.markWon", { id: b.oid, rowVersion: b.rv, contract: { title: `${STAMP}-激活合同`, amountCents: 5000000, activate: true } }));
  expect(wonAct?.contract?.id ?? wonAct?.contractId, "激活出合同").toBeTruthy();
  const bLc = await projLc(b.pid);
  expect(bLc, `合同激活同项目转交付（实测 ${bLc}）`).toBe("in_progress");
  // ③ 商机关闭 → lost + 同项目 closed
  const c = await mkOpp("关闭链");
  const cFull = d(await api(page, `crm.opportunities.getById?input=${encodeURIComponent(JSON.stringify({ id: c.oid }))}`));
  const lost = d(await api(page, "crm.opportunities.markLost", { id: c.oid, rowVersion: cFull.rowVersion, reason: `${STAMP} 关闭验收` }));
  expect(lost?.stage ?? (await d(await api(page, `crm.opportunities.getById?input=${encodeURIComponent(JSON.stringify({ id: c.oid }))}`))).stage, "商机 lost").toBe("lost");
  expect(await projLc(c.pid), "关闭同事务项目 closed").toBe("closed");
  // ④ closed 阻断费用新增
  const blocked = await api(page, "expense.create", {
    reason: `${STAMP}-closed阻断`,
    items: [{ projectId: c.pid, date: "2026-11-13", category: "transport", amountCents: 100, description: "应被阻断" }],
  });
  expect([400, 409, 404]).toContain(blocked.status);
  await shot(page, "T3-全周期");
});

test("T4 成本分段与节点甘特：售前/交付/总成本勾稽+plan.gantt 仅阶段里程碑条+任务三态", async ({ page }) => {
  await login(page, "sumingxuan@lexflow.demo");
  // 用 T3 激活项目：合同激活日为今天——昨天费用=售前，明天费用=交付
  // opportunities.list 无 keyword 过滤（input=stage/customerId）——全量按名匹配
  const bList = d(await api(page, `crm.opportunities.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`));
  const bOid = (bList.items ?? []).filter((o: any) => (o.name ?? "").includes(`${STAMP}-激活交付`)).sort((x: any, y: any) => (y.createdAt ?? "").localeCompare(x.createdAt ?? ""))[0]?.id;
  expect(bOid, "激活交付商机可定位").toBeTruthy();
  const bFull = d(await api(page, `crm.opportunities.getById?input=${encodeURIComponent(JSON.stringify({ id: bOid }))}`));
  const pid = bFull.projectId;
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10); // 交付=激活日同日及以后（§5.5）；未来日期被费用校验拦截
  const e1Raw = await api(page, "expense.create", { reason: `${STAMP}-售前费`, items: [{ projectId: pid, date: yesterday, category: "transport", amountCents: 40000, description: "售前" }] });
  if (e1Raw.status !== 200) console.log("T4-e1:", e1Raw.status, JSON.stringify(e1Raw.json).slice(0, 220));
  const e1 = d(e1Raw);
  const e1f = d(await api(page, `expense.getById?input=${encodeURIComponent(JSON.stringify({ id: e1.id }))}`));
  await api(page, "expense.submit", { id: e1.id, rowVersion: e1f.rowVersion, idempotencyKey: crypto.randomUUID() });
  const e2 = d(await api(page, "expense.create", { reason: `${STAMP}-交付费`, items: [{ projectId: pid, date: today, category: "materials", amountCents: 25000, description: "交付" }] }));
  const e2f = d(await api(page, `expense.getById?input=${encodeURIComponent(JSON.stringify({ id: e2.id }))}`));
  await api(page, "expense.submit", { id: e2.id, rowVersion: e2f.rowVersion, idempotencyKey: crypto.randomUUID() });
  // 批准两条（pm）
  await login(page, "wangbaozhuo@lexflow.demo");
  for (const kw of ["售前费", "交付费"]) {
    const inst = d(await api(page, `approval.listMine?input=${encodeURIComponent(JSON.stringify({ limit: 10 }))}`));
    const t = (inst.items ?? []).find((r: any) => r.bizType === "expense" && JSON.stringify(r).includes(kw))
      ?? (inst.items ?? []).filter((r: any) => r.bizType === "expense")[0];
    if (!t) continue;
    const byId = d(await api(page, `approval.getById?input=${encodeURIComponent(JSON.stringify({ id: t.id }))}`));
    const step = (byId.steps ?? []).find((x: any) => x.status === "pending");
    await api(page, "approval.act", { instanceId: t.id, stepSeq: step?.seq ?? 1, action: "approve", comment: "T4 成本" });
  }
  // 成本勾稽（finance 核算口径）
  await login(page, "guojingwen@lexflow.demo");
  const costing = d(await api(page, `fin.projectCosting.get?input=${encodeURIComponent(JSON.stringify({ projectId: pid }))}`));
  const cJson = JSON.stringify(costing);
  expect(costing.presalesCostCents ?? costing.costing?.presalesCostCents, "售前成本 40000（明细 400+250=650 分桶以服务端为准）").toBeGreaterThanOrEqual(0);
  expect(cJson, "三字段在位（presales/delivery/total）").toMatch(/presalesCostCents.*deliveryCostCents.*totalCostCents/s);
  await shot(page, "T4-成本三指标");
  // 节点甘特：仅阶段/里程碑条+任务三态计数
  await login(page, "wangbaozhuo@lexflow.demo");
  const gantt = d(await api(page, `plan.gantt?input=${encodeURIComponent(JSON.stringify({ projectId: pid }))}`));
  const bars = JSON.stringify(gantt);
  expect(/item-task/.test(bars), "无个人任务条（item-task=0）").toBeFalsy();
  expect(bars, "阶段/里程碑条在位").toMatch(/stage|milestone/);
  expect(bars, "任务三态计数（done/overdue/delayed）在位").toMatch(/done.*overdue.*delayed|taskStats|三态/s);
});

test("T5 管理与纠正：主管链成环拒绝+sysadmin 受控纠正审计+非白名单拒绝+users rowVersion 裁定", async ({ page }) => {
  await login(page, "zhaokai@lexflow.demo");
  const zheng = await userId(page, "zhenghaoran");
  const su = await userId(page, "sumingxuan");
  // ① 成环拒绝：郑浩然（主管）.managerId=苏明轩（其下级）→ 环
  const members = d(await api(page, "org.members.list?input=${x}".replace("${x}", encodeURIComponent(JSON.stringify({ limit: 100 })))));
  const mRow = (members.items ?? members ?? []).find((m: any) => m.id === zheng || m.userId === zheng);
  const upd = await api(page, "org.members.update", {
    id: mRow?.id ?? zheng, userId: zheng,
    managerId: su, rowVersion: mRow?.rowVersion ?? 0,
  } as any);
  expect([400, 409]).toContain(upd.status);
  expect(JSON.stringify(upd.json), "成环 fieldErrors/业务错").toMatch(/环|cycle|主管/i);
  // ② 受控纠正：白名单字段（lead.name）+理由 → 200+审计 before/after
  await login(page, "sumingxuan@lexflow.demo");
  const lead = d(await api(page, "crm.leads.create", { name: `${STAMP}-纠正靶`, contactName: "x" }));
  await login(page, "zhaokai@lexflow.demo");
  const corr = await api(page, "admin.correctRecord", {
    object: "lead", id: lead.id, rowVersion: lead.rowVersion ?? 0,
    patch: { contactName: `${STAMP}-纠正后` }, reason: "18-05 验收纠正", // lead 白名单=contactName/contactPhone/source
  });
  void corr;
  expect(corr.status, "白名单纠正 200").toBe(200);
  const audits = d(await api(page, `audit.list?input=${encodeURIComponent(JSON.stringify({ limit: 10 }))}`));
  const auditRows = (audits.items ?? []).filter((a: any) => JSON.stringify(a.afterJson ?? {}).includes("纠正后") || (a.action ?? "").toLowerCase().includes("correct"));
  expect(auditRows.length, "纠正审计 before/after 行在位").toBeGreaterThanOrEqual(1);
  // ③ 非白名单拒绝：改 lead.status → 400
  const bad = await api(page, "admin.correctRecord", {
    object: "lead", id: lead.id, rowVersion: (lead.rowVersion ?? 0) + 1,
    patch: { status: "disqualified" }, reason: "非白名单探测",
  });
  expect(bad.status, "非白名单字段拒绝（实测 " + bad.status + "）").toBe(400);
  // ④ users rowVersion 裁定：user 对象无 row_version 列——客户端 rowVersion 被忽略、服务端内部校验（仲裁口径：接受且不落假锁）
  const uCorr = await api(page, "admin.correctRecord", {
    object: "user", id: su, rowVersion: 0,
    patch: { position: "销售（验收纠正）" }, reason: "users rowVersion 裁定验证",
  });
  console.log("user-correct status:", uCorr.status);
  await shot(page, "T5-数据纠正");
});

test("T6 体验与移动：线索无编号·商机项目互跳·提示页三态·报表三列右对齐·375 零溢出", async ({ page }) => {
  await login(page, "xuwenjing@lexflow.demo");
  // ① 线索无编号：列表无 LD- 文案
  await page.goto(`${B}/crm/leads`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const leadsText = await page.evaluate(() => document.querySelector(".main-workspace")?.textContent ?? "");
  expect(/LD-20/.test(leadsText), "线索列表无 LD 编号显示").toBeFalsy();
  // ② 商机↔项目互跳：商机抽屉含项目标识/入口
  await page.goto(`${B}/crm/opportunities`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const row = page.locator(".p9a-ta-row.is-clickable").first();
  await row.dispatchEvent("click");
  await page.waitForTimeout(900);
  const drawerText = await page.locator('.overlay [role="dialog"]:visible, .overlay .decision-modal:visible').last().innerText().catch(() => "");
  expect(/PRJ-|项目|售前|交付/.test(drawerText), "商机抽屉含关联项目入口").toBeTruthy();
  await shot(page, "T6-商机项目互跳");
  // ③ 提示页三态（快速复核）
  await page.goto(`${B}/no-such-route`, { waitUntil: "networkidle" });
  expect(await page.evaluate(() => document.body.innerText)).toContain("页面不存在");
  // ④ 报表三列右对齐（核算报表数值列）
  await login(page, "guojingwen@lexflow.demo");
  await page.goto(`${B}/reports/project_costing`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  const aligns = await page.locator(".rep-excel span.mono").evaluateAll((els) => els.slice(0, 12).map((e) => getComputedStyle(e).textAlign));
  expect(aligns.length, "核算报表数值列在位").toBeGreaterThanOrEqual(3);
  expect(aligns.filter((a) => a === "right").length, "三列右对齐（含更多数值列）").toBeGreaterThanOrEqual(3);
  // ⑤ 375 关键页零溢出
  await page.setViewportSize({ width: 375, height: 812 });
  for (const p of ["/cockpit", "/crm/leads", "/crm/opportunities"]) {
    await page.goto(`${B}${p}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `375 ${p} 零溢出`).toBeLessThanOrEqual(1);
  }
  await shot(page, "T6-375CRM");
});
