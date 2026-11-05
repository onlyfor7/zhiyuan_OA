import { useState } from "react";

import { useCompany, useOrgMutations } from "../../api/org";
import { useMe } from "../../api/auth";
import { ListSkeleton } from "../../components/feedback";
import { rootErrorMessage } from "../../lib/form";
import { toast } from "sonner";

const FIELDS = [
  ["name", "公司名称", "因诺智元科技有限公司"],
  ["creditCode", "统一社会信用代码", "91310000MA1FL0000X"],
  ["address", "地址", ""],
  ["phone", "电话", ""],
  ["bankName", "开户行", ""],
  ["bankAccount", "银行账号", ""],
] as const;

/** 治理→组织管理·公司信息（arch/12 §9：T-B 单页签表单；org.manage=sysadmin 可编辑/partner 只读） */
export default function OrgCompanyPage() {
  const me = useMe();
  const company = useCompany();
  const mutations = useOrgMutations();
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canEdit = (me.data?.globalRoles ?? []).includes("sysadmin");
  const editing = draft !== null;
  const values = draft ?? Object.fromEntries(FIELDS.map(([k]) => [k, (company.data?.[k] as string | null) ?? ""]));

  if (company.isPending) return <ListSkeleton rows={5} />;
  if (company.isError) throw company.error;

  return (
    <div className="screen org-company-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">ORG · COMPANY</span>
          <h1>公司信息</h1>
          <p>单记录维护：发票抬头与合同水印引用源（org.company.get 登录可读）。</p>
        </div>
        <div className="title-actions">
          {!canEdit ? <span className="badge badge-health-normal">只读（partner 只读穿透）</span> : null}
          {canEdit && !editing ? (
            <button className="primary-action" onClick={() => setDraft({ ...values })}>
              编辑
            </button>
          ) : null}
          {canEdit && editing ? (
            <>
              <button className="secondary-action" onClick={() => setDraft(null)}>
                取消
              </button>
              <button
                className="primary-action"
                disabled={mutations.updateCompany.isPending}
                onClick={() => {
                  setError(null);
                  mutations.updateCompany.mutate(
                    {
                      rowVersion: company.data?.rowVersion ?? 0,
                      name: values.name.trim() || undefined,
                      creditCode: values.creditCode.trim() || undefined,
                      address: values.address.trim() || undefined,
                      phone: values.phone.trim() || undefined,
                      bankName: values.bankName.trim() || undefined,
                      bankAccount: values.bankAccount.trim() || undefined,
                    },
                    {
                      onSuccess: () => {
                        setDraft(null);
                        toast.success("公司信息已更新");
                      },
                      onError: (err) => setError(rootErrorMessage(err)),
                    },
                  );
                }}
              >
                保存
              </button>
            </>
          ) : null}
        </div>
      </div>
      <section className="p9a-card" style={{ maxWidth: 720 }}>
        <div className="p9a-field-grid two">
          {FIELDS.map(([key, label, ph]) => (
            <label className="form-field" key={key}>
              <span>{label}</span>
              <input
                value={values[key]}
                placeholder={ph}
                disabled={!editing || !canEdit}
                onChange={(e) => setDraft((d) => ({ ...(d ?? values), [key]: e.target.value }))}
              />
            </label>
          ))}
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="context-note">保存走 org.company.update（乐观锁 rowVersion；写操作服务端 org.manage 门+审计）。</p>
      </section>
    </div>
  );
}
