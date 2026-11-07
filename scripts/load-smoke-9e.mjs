#!/usr/bin/env node
/** 迭代 9e 压测冒烟（arch/12 §14.2）：100 并发打核心读链+登录+工时保存写路径。
 * 用法：node scripts/load-smoke-9e.mjs [base] [durationSec]
 * 前置（F3/错峰）：确认无其他测试会话在跑；压测占 prod 资源，避开部署/验收窗口。
 * SLO：读 p95<500ms；写 p95<1s。autocannon 无 p95 分位，以 p97.5 为保守代理（更严）。
 * 判定：读/写场景 5xx==0 且 p97.5<SLO；登录风暴段 429=限流设计实证（§14.4），
 *       SLO 以 5 连接标定段成功登录延迟为准。结果 JSON 写 scripts/load-smoke-9e.result.json。
 */
import { writeFileSync } from "node:fs";
import autocannon from "autocannon";

const B = process.argv[2] ?? "http://localhost:8080";
const DURATION = Number(process.argv[3] ?? 15);
const CONN = 100;

async function login(email) {
  const res = await fetch(`${B}/trpc/auth.login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Demo@2026" }),
  });
  if (!res.ok) throw new Error(`login ${email} → ${res.status}`);
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0]; // lx_session=...
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(opts) {
  return new Promise((resolve, reject) => {
    autocannon({ connections: CONN, duration: DURATION, connectionRate: 50, ...opts }, (err, result) => {
      if (err) return reject(err);
      resolve({
        name: opts.name,
        rps: Math.round(result.requests.average * 10) / 10,
        latency: {
          p50: result.latency.p50,
          p97_5: result.latency.p97_5, // p95 保守代理（更严）
          p99: result.latency.p99,
          max: result.latency.max,
        },
        statusCodes: result.statusCodes,
        errors: result.errors,
        non2xx: result["non2xx"],
        total: result.requests.sent,
      });
    });
  });
}

const J = { "content-type": "application/json" };
const fiveXX = (r) => Object.entries(r.statusCodes ?? {}).filter(([c]) => c.startsWith("5")).reduce((s, [, n]) => s + Number(n), 0);

async function main() {
  console.log(`[load-smoke] base=${B} connections=${CONN} duration=${DURATION}s/endpoint (ramp 50/s, 场景间冷却 3s)`);
  const fin = await login("guojingwen@lexflow.demo");
  const member = await login("guanchen@lexflow.demo");

  // 写路径前置：member 的当前周期 + 一可见项目
  const periodRes = await fetch(`${B}/trpc/time.myPeriod`, { headers: { cookie: member } });
  const periodJson = await periodRes.json();
  const period = periodJson.result.data.json ?? periodJson.result.data;
  const projRes = await fetch(`${B}/trpc/project.list?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`, { headers: { cookie: member } });
  const projJson = await projRes.json();
  const projects = projJson.result.data.json?.items ?? projJson.result.data.items ?? [];
  const periodId = period.period?.id ?? period.id;
  const projectId = projects[0]?.id ?? null;
  if (!periodId) throw new Error("myPeriod 无周期");
  console.log(`[load-smoke] write path: period=${periodId} project=${projectId}`);

  const scenarios = [
    { name: "读·驾驶舱聚合 dashboard.summary", method: "GET", path: "/trpc/dashboard.summary", headers: { cookie: fin } },
    { name: "读·项目列表 project.list", method: "GET", path: `/trpc/project.list?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`, headers: { cookie: fin } },
    { name: "读·报表 monthlyCashflow", method: "GET", path: `/trpc/reports.monthlyCashflow?input=${encodeURIComponent(JSON.stringify({}))}`, headers: { cookie: fin } },
    { name: "读·报表 projectHealth", method: "GET", path: "/trpc/reports.projectHealth", headers: { cookie: fin } },
    { name: "写·登录 auth.login 风暴段（429=§14.4 限流实证）", method: "POST", path: "/trpc/auth.login", headers: J, body: JSON.stringify({ email: "guojingwen@lexflow.demo", password: "Demo@2026" }) },
  ];
  // 写·工时保存：分 4 段换 idempotencyKey，保证每段都是真实 delete+insert 事务
  for (let i = 0; i < 4; i++) {
    scenarios.push({
      name: `写·工时保存 time.saveEntries #${i + 1}`,
      method: "POST",
      path: "/trpc/time.saveEntries",
      headers: { ...J, cookie: member },
      body: JSON.stringify({
        periodId,
        idempotencyKey: crypto.randomUUID(),
        entries: [{ projectId, activityType: "professional_work", workDate: "2026-11-07", durationMinutes: 30, description: "load-smoke-9e" }],
      }),
    });
  }

  const results = [];
  for (const s of scenarios) {
    const r = await run({ url: `${B}${s.path}`, method: s.method, headers: s.headers, body: s.body, name: s.name });
    results.push(r);
    console.log(
      `${String(r.latency.p97_5)}`.padStart(7), "ms p97.5 |", `${r.rps}`.padStart(8), "rps |",
      `5xx=${fiveXX(r)} 4xx=${r.non2xx - fiveXX(r)}`.padEnd(16), "|", r.name,
    );
    await sleep(3000); // 场景间冷却：释放 docker NAT 源端口/conntrack
  }

  // 登录 SLO 标定段：5 连接×5s——避开限流与连接风暴，测成功登录真实延迟（scrypt）
  const loginCal = await run({
    url: `${B}/trpc/auth.login`, method: "POST", headers: J, name: "写·登录 auth.login 标定段（5 连接）",
    connections: 5, duration: 5,
  });
  results.push(loginCal);
  console.log(`${String(loginCal.latency.p97_5)}`.padStart(7), "ms p97.5 |", `${loginCal.rps}`.padStart(8), "rps | 标定段(5conn) |", loginCal.name);

  // 清理：空 entries 复位 member 周期（saveEntries=replace 语义，不留压测行）
  const cleanup = await fetch(`${B}/trpc/time.saveEntries`, {
    method: "POST",
    headers: { ...J, cookie: member },
    body: JSON.stringify({ periodId, idempotencyKey: crypto.randomUUID(), entries: [] }),
  });
  console.log(`[load-smoke] cleanup saveEntries([]) → ${cleanup.status}`);

  const summary = { base: B, connections: CONN, durationPerEndpoint: DURATION, at: new Date().toISOString(), results };
  writeFileSync(new URL("./load-smoke-9e.result.json", import.meta.url), JSON.stringify(summary, null, 2));

  const slo = { readP95: 500, writeP95: 1000 };
  const verdicts = results.map((r) => {
    if (r.name.includes("标定段")) return { name: r.name, p95: r.latency.p97_5, limit: slo.writeP95, pass: r.latency.p97_5 < slo.writeP95 && fiveXX(r) === 0 };
    if (r.name.includes("风暴段")) return { name: r.name, p95: r.latency.p97_5, limit: slo.writeP95, pass: fiveXX(r) === 0, note: "429=限流设计实证" };
    const isWrite = r.name.startsWith("写");
    const limit = isWrite ? slo.writeP95 : slo.readP95;
    return { name: r.name, p95: r.latency.p97_5, limit, pass: r.latency.p97_5 < limit && fiveXX(r) === 0 };
  });
  console.log("\n[load-smoke] SLO 判定（p97.5 作 p95 保守代理）：");
  for (const v of verdicts) console.log(` ${v.pass ? "PASS" : "FAIL"}  p97.5=${v.p95}ms < ${v.limit}ms  ${v.name}${v.note ? `（${v.note}）` : ""}`);
  const allPass = verdicts.filter((v) => !v.name.includes("风暴段")).every((v) => v.pass);
  console.log(`[load-smoke] 总判定：${allPass ? "PASS" : "FAIL"}`);
  process.exit(allPass ? 0 : 2);
}

main().catch((e) => { console.error(e); process.exit(1); });
