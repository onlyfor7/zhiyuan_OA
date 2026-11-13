import { useState } from "react";
import { toast } from "sonner";

import { useCorrectRecord } from "../../api/admin";
import { useCustomerList, useLeadList, useOpportunityList } from "../../api/crm";
import { useProjectList } from "../../api/project";
import { useUnitTree } from "../../api/org";
import { useUserList } from "../../api/reference";
import { rootErrorMessage } from "../../lib/form";
import { fieldErrorsOf } from "../../lib/trpc";
import { UserPicker } from "../../components/UserPicker";
import { ListSkeleton } from "../../components/feedback";

/**
 * 数据纠正（arch/13 §7.3，sysadmin 专属）：白名单对象/字段最小集 + 目标记录选择 + 理由必填 + rowVersion 乐观锁。
 * users 无 row_version 列（架构裁定关闭）：员工对象不展示版本号输入（服务端以 updated_at 快照自校验）。
 * 成功提示审计已记录；409/400 fieldErrors 落表单；无任意 SQL 入口。
 */

const OBJECTS = [
  ["lead", "线索"],
  ["opportunity", "商机"],
  ["client", "客户"],
  ["project", "项目"],
  ["user", "员工"],
] as const;
type Obj = (typeof OBJECTS)[number][0];

const FIELD_LABEL: Record<Obj, Record<string, string>> = {
  lead: { contactName: "联系人", contactPhone: "联系电话", source: "来源" },
  opportunity: { name: "商机名称", expectedAmountCents: "预计金额（分）", winRate: "赢率（%）", presalesId: "售前指派" },
  client: { name: "客户名称", level: "客户级别", industry: "行业", address: "地址" },
  project: { name: "项目名称", type: "项目类型", confidentialityLevel: "密级" },
  user: { orgUnitId: "部门", position: "职位", managerId: "直属主管" },
};
const WHITELIST = Object.fromEntries(OBJECTS.map(([o]) => [o, Object.keys(FIELD_LABEL[o])])) as Record<Obj, string[]>;

const CONF_LABEL: Record<string, string> = { public: "公开", internal: "内部", confidential: "保密", secret: "秘密" };

export default function DataCorrectTab() {
  const correct = useCorrectRecord();
  const [object, setObject] = useState<Obj>("lead");
  const [recordId, setRecordId] = useState("");
  const [patch, setPatch] = useState<Record<string, string>>({});
  const [rowVersion, setRowVersion] = useState("");
  const [reason, setReason] = useState("");
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [rootErr, setRootErr] = useState<string | null>(null);

  // 参照列表（sysadmin 全局读；CRM 列表越权同形 404 由边界承接）
  const leads = useLeadList({ limit: 50 });
  const opps = useOpportunityList({ limit: 50 });
  const customers = useCustomerList({ limit: 50 });
  const projects = useProjectList({}, 50);
  const users = useUserList("");
  const units = useUnitTree();

  // rowVersion 预填：仅 lead/opportunity 列表携带；client/project 列表为最小集不携带（手工输入）；user 无该列（裁定）
  const records: Array<{ id: string; label: string; rowVersion?: number }> =
    object === "lead"
      ? (leads.data?.items ?? []).map((r) => ({ id: r.id, label: r.name, rowVersion: r.rowVersion }))
      : object === "opportunity"
        ? (opps.data?.items ?? []).map((r) => ({ id: r.id, label: `${r.code} · ${r.name}`, rowVersion: r.rowVersion }))
        : object === "client"
          ? (customers.data?.items ?? []).map((r) => ({ id: r.id, label: r.name }))
          : object === "project"
            ? (projects.data?.items ?? []).map((r) => ({ id: r.id, label: `${r.code} · ${r.name}` }))
            : (users.data?.items ?? []).map((r) => ({ id: r.id, label: `${r.name} · ${r.email}` }));

  const loading =
    (object === "lead" && leads.isPending) ||
    (object === "opportunity" && opps.isPending) ||
    (object === "client" && customers.isPending) ||
    (object === "project" && projects.isPending) ||
    (object === "user" && users.isPending);

  const resetAll = () => {
    setRecordId("");
    setPatch({});
    setRowVersion("");
    setFieldErr({});
    setRootErr(null);
  };

  const submit = () => {
    setFieldErr({});
    setRootErr(null);
    const entries = Object.entries(patch).filter(([, v]) => v.trim() !== "");
    if (!recordId) {
      setRootErr("请选择目标记录");
      return;
    }
    if (entries.length === 0) {
      setRootErr("请至少填写一个白名单字段");
      return;
    }
    if (!reason.trim()) {
      setFieldErr({ reason: "纠正理由必填" });
      return;
    }
    const built: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      if (k === "expectedAmountCents" || k === "winRate") built[k] = Number(v);
      else if (k === "orgUnitId" || k === "managerId" || k === "presalesId") built[k] = v || null;
      else built[k] = v.trim();
    }
    correct.mutate(
      {
        object,
        id: recordId,
        // users 无 row_version 列（架构裁定）：员工对象不展示输入，传 0 由服务端快照自校验
        rowVersion: object === "user" ? 0 : Number(rowVersion || "0"),
        patch: built,
        reason: reason.trim(),
      },
      {
        onSuccess: () => {
          toast.success("纠正已提交：审计已记录（before/after 全快照）");
          resetAll();
          setReason("");
        },
        onError: (err) => {
          const fe = fieldErrorsOf(err);
          if (fe) {
            const mapped: Record<string, string> = {};
            for (const [f, msgs] of Object.entries(fe)) mapped[f] = msgs[0];
            setFieldErr(mapped);
          }
          setRootErr(rootErrorMessage(err));
        },
      },
    );
  };

  if (loading) return <ListSkeleton rows={4} />;

  return (
    <div className="space-tab-body" style={{ maxWidth: 760 }}>
      <p className="context-note">
        受控数据纠正（arch/13 §7.3）：仅白名单对象/字段、理由必填、乐观锁；全部写入审计（before/after 全快照）。
        已批准/已支付财务数据不走本入口（走作废/红冲/冲正/调整分录）；流程调整走新版本。
      </p>
      <div className="owner-line">
        <label className="form-field">
          <span>对象类型 *</span>
          <select
            value={object}
            onChange={(e) => {
              setObject(e.target.value as Obj);
              resetAll();
            }}
          >
            {OBJECTS.map(([o, l]) => (
              <option key={o} value={o}>{l}</option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>目标记录 *</span>
          <select value={recordId} onChange={(e) => {
            setRecordId(e.target.value);
            setPatch({});
            const rec = records.find((r) => r.id === e.target.value);
            setRowVersion(rec?.rowVersion != null ? String(rec.rowVersion) : "");
          }}>
            <option value="">请选择</option>
            {records.map((r) => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
        </label>
      </div>

      <span className="section-label">白名单字段（留空不纠正）</span>
      <div className="p9a-field-grid two">
        {WHITELIST[object].map((f) => (
          <label key={f} className="form-field">
            <span>{FIELD_LABEL[object][f]}</span>
            {f === "presalesId" || f === "managerId" ? (
              <UserPicker value={patch[f] ?? ""} onChange={(v) => setPatch((p) => ({ ...p, [f]: v }))} placeholder={`搜索${FIELD_LABEL[object][f]}`} />
            ) : f === "orgUnitId" ? (
              <select value={patch[f] ?? ""} onChange={(e) => setPatch((p) => ({ ...p, [f]: e.target.value }))}>
                <option value="">请选择部门</option>
                {(units.data ?? []).map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            ) : f === "confidentialityLevel" ? (
              <select value={patch[f] ?? ""} onChange={(e) => setPatch((p) => ({ ...p, [f]: e.target.value }))}>
                <option value="">请选择密级</option>
                {Object.entries(CONF_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            ) : (
              <input value={patch[f] ?? ""} onChange={(e) => setPatch((p) => ({ ...p, [f]: e.target.value }))} />
            )}
            {fieldErr[f] ? <em className="ux-err" role="alert">{fieldErr[f]}</em> : null}
          </label>
        ))}
      </div>

      {object !== "user" ? (
        <label className="form-field" style={{ maxWidth: 220 }}>
          <span>rowVersion *（从列表/详情取当前版本，乐观锁）</span>
          <input value={rowVersion} onChange={(e) => setRowVersion(e.target.value)} inputMode="numeric" />
          {fieldErr.rowVersion ? <em className="ux-err" role="alert">{fieldErr.rowVersion}</em> : null}
        </label>
      ) : (
        <p className="context-note">员工对象：users 表无 row_version 列（架构裁定关闭），不展示版本号输入；服务端以 before 快照自校验。</p>
      )}
      <label className="form-field">
        <span>纠正理由 *（写入审计，500 字内）</span>
        <textarea rows={2} value={reason} onChange={(e) => { setReason(e.target.value); setFieldErr((f) => ({ ...f, reason: "" })); }} />
        {fieldErr.reason ? <em className="ux-err" role="alert">{fieldErr.reason}</em> : null}
      </label>
      {fieldErr.patch ? <p className="form-error" role="alert">{fieldErr.patch}</p> : null}
      {rootErr ? <p className="form-error" role="alert">{rootErr}</p> : null}
      <div className="drawer-actions">
        <button className="secondary-action" onClick={resetAll}>重置</button>
        <button
          className="danger-action"
          disabled={correct.isPending || !recordId || !reason.trim()}
          onClick={submit}
        >
          {correct.isPending ? "提交中…" : "提交纠正（审计留痕）"}
        </button>
      </div>
    </div>
  );
}
