// 迭代3打回项复测（临时，跑完即删）
const B = 'http://localhost:3001';
const jars = {};
const j = (r) => r.json();
async function login(email) {
  const r = await fetch(B + '/trpc/auth.login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Demo@2026' }) });
  jars[email] = r.headers.get('set-cookie').split(';')[0];
  return (await j(r)).result?.data?.user;
}
const q = (u, p, input) => fetch(`${B}/trpc/${p}?input=` + encodeURIComponent(JSON.stringify(input ?? {})), { headers: { cookie: jars[u] } }).then(j);
const m = (u, p, input) => fetch(`${B}/trpc/${p}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: jars[u] }, body: JSON.stringify(input) }).then(j);
const ok = (n, c, x = '') => console.log(c ? `PASS ${n}` : `FAIL ${n}`, x);
const { execSync } = await import('node:child_process');
const sql = (s) => execSync(`docker exec lexflow-postgres psql -U lexflow -d lexflow -tAc "${s}"`).toString().trim();

const pm = 'pm@lexflow.demo', mb = 'member@lexflow.demo', fi = 'finance@lexflow.demo', pa = 'partner@lexflow.demo';
await login(pm); await login(mb); await login(fi); await login(pa);
const A = 'dfb472e8-32ed-4f30-b550-4d2cc0e7b00c';
const FND1 = sql(`select id from funding_requests where code='FND-2026-00001'`);
const EX1 = sql(`select id from expense_reports where code='EXP-2026-00001'`);

// R1：无文件同号同额新票 → 必拦 + 定位原单
const dup = await m(mb, 'expense.create', { reason: 'R1复测重复票', items: [{ projectId: A, date: '2026-10-27', category: 'transport', amountCents: 800000, description: '复测重复票', receiptNo: 'TR202613-001' }] });
const dupId = dup.result?.data?.id;
if (!dupId) { ok('R1 创建期拦截', dup.error?.data?.businessCode === 'DUPLICATE_RECEIPT', JSON.stringify(dup.error?.data ?? '').slice(0, 200)); }
else {
  const dsub = await m(mb, 'expense.submit', { id: dupId, rowVersion: 0, idempotencyKey: crypto.randomUUID() });
  const bc = dsub.error?.data?.businessCode;
  const hasLoc = JSON.stringify(dsub.error ?? '').includes('EXP-2026-0000');
  ok('R1 提交拦截 DUPLICATE_RECEIPT + 定位原单', bc === 'DUPLICATE_RECEIPT' && hasLoc, JSON.stringify(dsub.error?.data ?? dsub.result?.data ?? '').slice(0, 200));
  // 清理：pm 驳回这张修复前漏网的 pending 单（EXP-2026-00005 同理清理）
  for (const code of [dupId, sql(`select id from expense_reports where code='EXP-2026-00005'`)]) {
    const inst = sql(`select approval_instance_id from expense_reports where id='${code}'`);
    if (inst) {
      const g = (await q(pm, 'approval.getById', { id: inst })).result?.data;
      const cur = (g?.instance ?? g).currentStepSeq ?? 1;
      const rj = await m(pm, 'approval.act', { instanceId: inst, stepSeq: cur, action: 'reject', comment: '重复票据冒烟清理', idempotencyKey: crypto.randomUUID() });
      console.log('清理驳回', code.slice(0, 8), rj.error ? 'ERR' : 'ok');
    }
  }
}

// R2：新小额报销核销 FND-00001（累计已核销 1.4M）→ 再核销 10 万 → partially_used
const ex2 = (await m(mb, 'expense.create', { reason: 'R2复测经费使用态', travelId: null, items: [{ projectId: A, fundingRequestId: FND1, date: '2026-10-27', category: 'meals', amountCents: 100000, description: '工作餐（复测）' }] })).result?.data;
ok('R2 创建报销', !!ex2?.id, ex2?.code);
const sub2 = await m(mb, 'expense.submit', { id: ex2.id, rowVersion: ex2.rowVersion ?? 0, idempotencyKey: crypto.randomUUID() });
ok('R2 提交', !sub2.error, JSON.stringify(sub2.error?.data ?? '').slice(0, 140));
const inst2 = sql(`select approval_instance_id from expense_reports where id='${ex2.id}'`);
const r2a = await m(pm, 'approval.act', { instanceId: inst2, stepSeq: 1, action: 'approve', comment: '同意', idempotencyKey: crypto.randomUUID() });
const r2b = await m(fi, 'approval.act', { instanceId: inst2, stepSeq: 2, action: 'approve', comment: '财务通过', idempotencyKey: crypto.randomUUID() });
ok('R2 审批链', !r2a.error && !r2b.error, JSON.stringify((r2a.error ?? r2b.error)?.data ?? '').slice(0, 120));
ok('R2 usage_status → partially_used', sql(`select usage_status from funding_requests where id='${FND1}'`) === 'partially_used', sql(`select usage_status from funding_requests where id='${FND1}'`));

// R3：finance 发起调整 → partner 终审 → EXPENSE_ADJUSTED
const adj = await m(fi, 'expense.adjustCreate', { expenseId: EX1, deltaCents: -100000, reason: '票据税率更正（R3复测）', idempotencyKey: crypto.randomUUID() });
ok('R3 finance 可发起', !adj.error, JSON.stringify(adj.error?.data ?? '').slice(0, 140));
const adjInst = sql(`select approval_instance_id from expense_adjustments where expense_report_id='${EX1}' order by created_at desc limit 1`);
const ag = (await q(pa, 'approval.getById', { id: adjInst })).result?.data;
const aa = await m(pa, 'approval.act', { instanceId: adjInst, stepSeq: (ag?.instance ?? ag).currentStepSeq ?? 1, action: 'approve', comment: '同意调整', idempotencyKey: crypto.randomUUID() });
ok('R3 partner 终审', !aa.error, JSON.stringify(aa.error?.data ?? '').slice(0, 120));
ok('R3 EXPENSE_ADJUSTED −100000', sql(`select actual_delta_cents from budget_ledger where entry_type='EXPENSE_ADJUSTED'`) === '-100000');
console.log('总台账(占用|实际):', sql(`select coalesce(sum(reserved_delta_cents),0)||'|'||coalesce(sum(actual_delta_cents),0) from budget_ledger where project_id='${A}'`));
console.log('R-RETEST DONE');
