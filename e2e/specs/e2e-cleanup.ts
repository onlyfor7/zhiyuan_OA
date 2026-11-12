/** 迭代 17-01 · e2e 创建物自清（arch/12 §20.1）——统一尾部 cleanup 钩子。
 * 每 spec 顶部 installE2eSelfClean()：afterAll（失败也跑）调用 runE2eCleanup()，
 * 经各域既有语义闭环清理本窗口内 spec 创建的未结业务对象（作废冲正/撤回/关闭/删除语义）。
 * 审计 append-only 不动。计数口径见 collectOpenCounts()——prod 两轮连跑零增长验收用。
 */
import { test } from "@playwright/test";

const B = process.env.LX_BASE ?? "http://localhost:8080";
const LOADED_AT = Date.now();
const WINDOW_MS = 6 * 60_000; // 覆盖单 spec 运行时长（afterAll 触发点回溯）
const STAMP = /E2E-|验收|探针|probe|快照|抽屉|勾稽|红冲|冲正|KEEPALIVE|load-smoke/i;

const EMAILS = {
  finance: "guojingwen@lexflow.demo",
  member: "guanchen@lexflow.demo",
  partner: "liangqifeng@lexflow.demo",
  pm: "wangbaozhuo@lexflow.demo",
  sysadmin: "zhaokai@lexflow.demo",
} as const;
const ROLE_EMAIL: Record<string, string> = {
  finance: EMAILS.finance,
  project_manager: EMAILS.pm,
  partner: EMAILS.partner,
  quality_lead: EMAILS.partner,
  sysadmin: EMAILS.sysadmin,
  archivist: EMAILS.sysadmin,
};

class Session {
  private cookie = "";
  constructor(private email: string) {}
  async login(): Promise<void> {
    const res = await fetch(`${B}/trpc/auth.login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: this.email, password: "Demo@2026" }),
    });
    if (!res.ok) throw new Error(`cleanup login ${this.email} → ${res.status}`);
    this.cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  }
  async api(path: string, body?: unknown): Promise<{ status: number; data: any }> {
    const res = await fetch(`${B}/trpc/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    const data = (json as any).result?.data?.json ?? (json as any).result?.data;
    return { status: res.status, data };
  }
}

function fresh(row: any): boolean {
  const t = Date.parse(row?.createdAt ?? row?.created_at ?? row?.submittedAt ?? "");
  return Number.isFinite(t) ? t >= LOADED_AT - WINDOW_MS : false;
}
const d = (r: any) => r.data ?? {};

/** 主清扫：返回动作摘要（供报告/日志）。 */
export async function runE2eCleanup(): Promise<string[]> {
  const log: string[] = [];
  const sessions = new Map<string, Session>();
  const session = async (key: keyof typeof EMAILS | string): Promise<Session> => {
    const email = (EMAILS as any)[key] ?? key;
    if (!sessions.has(email)) {
      const s = new Session(email);
      await s.login();
      sessions.set(email, s);
    }
    return sessions.get(email)!;
  };
  const tryGet = async (ss: Session, path: string): Promise<any> => {
    try { return d(await ss.api(path)); } catch { return null; }
  };
  const safe = async (tag: string, fn: () => Promise<number>) => {
    try {
      const n = await fn();
      if (n > 0) log.push(`${tag}×${n}`);
    } catch (e) {
      log.push(`${tag}!${(e as Error).message.slice(0, 60)}`);
    }
  };

  // ① 待审批实例：按当前步审批人逐单 reject（至多 5 轮消化多级流）
  await safe("approval.reject", async () => {
    let closed = 0;
    const partner = await session("partner");
    const sys = await session("sysadmin");
    for (let round = 0; round < 5; round++) {
      const mine = d(await partner.api(`approval.listMine?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`));
      const targets = ((mine.items ?? []) as any[]).filter((r) => fresh(r));
      if (!targets.length) break;
      const users = d(await sys.api("admin.userList"));
      const uList = (users.items ?? users ?? []) as any[];
      for (const inst of targets) {
        const byId = d(await partner.api(`approval.getById?input=${encodeURIComponent(JSON.stringify({ id: inst.id }))}`));
        const step = (byId.steps ?? []).find((s: any) => s.status === "pending" && s.seq === byId.currentStepSeq)
          ?? (byId.steps ?? []).find((s: any) => s.status === "pending");
        if (!step) continue;
        const email = step.approverId
          ? (uList.find((u: any) => u.id === step.approverId)?.email ?? null)
          : ROLE_EMAIL[step.approverRole as string] ?? null;
        if (!email) continue;
        const approver = await session(email);
        const r = await approver.api("approval.act", {
          instanceId: inst.id, stepSeq: step.seq, action: "reject", comment: "E2E 自清闭环",
        });
        if (r.status === 200) closed++;
      }
    }
    return closed;
  });

  // ② 费用/出差/申请单/经费：创建者撤回（reject 后回落可撤状态→draft）
  for (const [tag, listPath, withdrawPath] of [
    ["expense.withdraw", "expense.list", "expense.withdraw"],
    ["travel.withdraw", "travel.list", "travel.withdraw"],
    ["request.withdraw", "genericRequest.list", "genericRequest.withdraw"],
    ["funding.withdraw", "funding.list", "funding.withdraw"],
  ] as const) {
    await safe(tag, async () => {
      const me = await session("member");
      let n = 0;
      for (let page = 0; page < 3; page++) {
        const list = d(await me.api(`${listPath}?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`));
        const targets = ((list.items ?? []) as any[]).filter((r) => fresh(r)
          && ["pending_approval", "submitted", "returned", "pending"].includes(r.status));
        if (!targets.length) break;
        for (const row of targets.slice(0, 20)) {
          const full = await tryGet(me, `${listPath.replace("list", "getById")}?input=${encodeURIComponent(JSON.stringify({ id: row.id }))}`);
          const rv = full?.rowVersion ?? row.rowVersion ?? 0;
          const r = await me.api(withdrawPath, { id: row.id, rowVersion: rv });
          if (r.status === 200) n++;
        }
      }
      return n;
    });
  }

  // ③ 会议：取消未开 E2E 会
  await safe("meeting.cancel", async () => {
    const me = await session("member");
    const list = d(await me.api(`meeting.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`));
    const targets = ((list.items ?? []) as any[]).filter((r) => fresh(r) && r.status === "planned");
    let n = 0;
    for (const m of targets.slice(0, 20)) {
      const full = await tryGet(me, `meeting.getById?input=${encodeURIComponent(JSON.stringify({ id: m.id }))}`);
      const r = await me.api("meeting.transition", { id: m.id, action: "cancel", rowVersion: full?.rowVersion ?? m.rowVersion ?? 0 });
      if (r.status === 200) n++;
    }
    return n;
  });

  // ④ CRM：线索作废 + 商机输单（partner 口径）
  await safe("lead.disqualify", async () => {
    const s = await session("partner");
    const list = d(await s.api(`crm.leads.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`));
    const targets = ((list.items ?? []) as any[]).filter((r) => fresh(r) && ["new", "contacted", "qualified"].includes(r.status));
    let n = 0;
    for (const l of targets.slice(0, 20)) {
      const full = (await tryGet(s, `crm.leads.getById?input=${encodeURIComponent(JSON.stringify({ id: l.id }))}`)) ?? l;
      const r = await s.api("crm.leads.disqualify", { id: l.id, rowVersion: full?.rowVersion ?? l.rowVersion ?? 0, reason: "E2E 自清" });
      if (r.status === 200) n++;
    }
    return n;
  });
  await safe("opp.markLost", async () => {
    const s = await session("partner");
    const list = d(await s.api(`crm.opportunities.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`));
    const targets = ((list.items ?? []) as any[]).filter((r) => fresh(r) && !["won", "lost"].includes(r.stage));
    let n = 0;
    for (const o of targets.slice(0, 20)) {
      const full = (await tryGet(s, `crm.opportunities.getById?input=${encodeURIComponent(JSON.stringify({ id: o.id }))}`)) ?? o;
      const r = await s.api("crm.opportunities.markLost", { id: o.id, rowVersion: full?.rowVersion ?? o.rowVersion ?? 0, reason: "E2E 自清" });
      if (r.status === 200) n++;
    }
    return n;
  });

  // ⑤ 收款作废（finance，registered→voided 冲正）
  await safe("receipt.void", async () => {
    const s = await session("finance");
    const list = d(await s.api(`receipts.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`));
    const targets = ((list.items ?? []) as any[]).filter((r) => fresh(r) && r.status === "registered");
    let n = 0;
    for (const rc of targets.slice(0, 30)) {
      const full = (await tryGet(s, `receipts.getById?input=${encodeURIComponent(JSON.stringify({ id: rc.id }))}`)) ?? rc;
      const r = await s.api("receipts.void", { id: rc.id, rowVersion: full?.rowVersion ?? rc.rowVersion ?? 0 });
      if (r.status === 200) n++;
    }
    return n;
  });

  // ⑥ 发票红冲（finance，draft/issued/sent→voided）
  await safe("invoice.void", async () => {
    const s = await session("finance");
    const list = d(await s.api(`fin.invoices.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`));
    const targets = ((list.items ?? []) as any[]).filter((r) => fresh(r) && ["draft", "issued", "sent"].includes(r.status));
    let n = 0;
    for (const inv of targets.slice(0, 20)) {
      const full = (await tryGet(s, `fin.invoices.getById?input=${encodeURIComponent(JSON.stringify({ id: inv.id }))}`)) ?? inv;
      const r = await s.api("fin.invoices.void", { id: inv.id, rowVersion: full?.rowVersion ?? inv.rowVersion ?? 0, reason: "E2E 自清红冲" });
      if (r.status === 200) n++;
    }
    return n;
  });

  return log;
}

/** 未结/未决口径计数（两轮零增长验收的度量集）。 */
export async function collectOpenCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const call = async (tag: string, email: string, path: string, filter: (r: any) => boolean) => {
    try {
      const s = new Session(email);
      await s.login();
      const data = d(await s.api(path));
      out[tag] = ((data.items ?? []) as any[]).filter(filter).length;
    } catch {
      out[tag] = -1;
    }
  };
  await call("approval.pending", EMAILS.partner, `approval.listMine?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`, () => true);
  await call("expense.open", EMAILS.finance, `expense.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`, (r) => ["pending_approval", "returned", "submitted", "pending"].includes(r.status));
  await call("receipt.registered", EMAILS.finance, `receipts.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`, (r) => r.status === "registered");
  await call("receivable.open", EMAILS.finance, `fin.receivables.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`, (r) => !["settled", "void"].includes(r.status));
  await call("invoice.active", EMAILS.finance, `fin.invoices.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`, (r) => ["draft", "issued", "sent"].includes(r.status));
  await call("lead.open", EMAILS.partner, `crm.leads.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`, (r) => ["new", "contacted", "qualified"].includes(r.status));
  await call("opp.open", EMAILS.partner, `crm.opportunities.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`, (r) => !["won", "lost"].includes(r.stage));
  const inFlight = (r: any) => ["submitted", "pending", "pending_approval"].includes(r.status);
  await call("travel.open", EMAILS.member, `travel.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`, inFlight);
  await call("request.open", EMAILS.member, `genericRequest.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`, inFlight);
  await call("funding.open", EMAILS.member, `funding.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`, inFlight);
  await call("meeting.planned", EMAILS.member, `meeting.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`, (r) => r.status === "planned");
  await call("project.total", EMAILS.partner, `project.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`, () => true);
  return out;
}

/** 每个 spec 文件顶部调用一次：注册尾部自清钩子（失败也清——afterAll 必跑）。 */
export function installE2eSelfClean(): void {
  test.afterAll(async () => {
    const log = await runE2eCleanup();
    if (log.length) console.log(`[e2e-selfclean] ${log.join(" | ")}`);
  });
}
