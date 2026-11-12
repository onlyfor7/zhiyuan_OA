/** e2e 自清冒烟自测（迭代 17-01 辅助件，不进回归批）：造 2 域数据→runE2eCleanup→断言闭环。 */
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { collectOpenCounts, runE2eCleanup } from "./e2e-cleanup";

const B = process.env.LX_BASE ?? "http://localhost:8080";

async function loginSession(email: string) {
  const res = await fetch(`${B}/trpc/auth.login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Demo@2026" }),
  });
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  return async (path: string, body?: unknown) => {
    const r = await fetch(`${B}/trpc/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, data: (j as any).result?.data?.json ?? (j as any).result?.data };
  };
}

test("自清冒烟：线索作废+费用撤回+计数采集可运行", async () => {
  const api = await loginSession("guanchen@lexflow.demo");
  const stamp = `E2E-SELFTEST-${Date.now().toString(36)}`;
  // 造数：线索（partner 域）走 liangqifeng；费用走 guanchen
  const partner = await loginSession("liangqifeng@lexflow.demo");
  const lead = await partner("crm.leads.create", { name: `${stamp}-线索` });
  expect(lead.status).toBe(200);
  const exp = await api("expense.create", {
    reason: `${stamp}-报销`,
    items: [{ projectId: (await api("project.list?input=" + encodeURIComponent(JSON.stringify({ limit: 5 })))).data.items[0].id, date: "2026-11-12", category: "transport", amountCents: 100, description: "自清冒烟" }],
  });
  expect(exp.status).toBe(200);
  const full = await api(`expense.getById?input=${encodeURIComponent(JSON.stringify({ id: exp.data.id }))}`);
  const sub = await api("expense.submit", { id: exp.data.id, rowVersion: full.data.rowVersion, idempotencyKey: randomUUID() });
  expect(sub.status).toBe(200);
  // 清扫
  const log = await runE2eCleanup();
  console.log("selftest-cleanup-log:", log.join(" | "));
  expect(log.join(" ")).toMatch(/lead\.disqualify×1/);
  expect(log.join(" ")).toMatch(/expense\.withdraw×1/);
  // 断言闭环
  const leads = await partner(`crm.leads.list?input=${encodeURIComponent(JSON.stringify({ keyword: stamp, limit: 5 }))}`);
  expect((leads.data.items ?? [])[0]?.status).toBe("disqualified");
  const counts = await collectOpenCounts();
  expect(counts["project.total"] ?? -1).toBeGreaterThan(0);
  console.log("selftest-counts:", JSON.stringify(counts));
});
