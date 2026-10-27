import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router";
import { ArrowRight, X } from "lucide-react";
import { EXPENSE_CATEGORY } from "@lexflow/shared";

import { useFundingList } from "../api/finance-budget";
import { useExpenseMutations } from "../api/finance-expense";
import { useTRPC } from "../lib/trpc";
import { uploadProjectFile } from "../api/archive";
import { parseYuanToCents, formatYuan } from "../api/reference";
import { useMe } from "../api/auth";
import { newIdempotencyKey, rootErrorMessage } from "../lib/form";
import { EXPENSE_CATEGORY_LABEL } from "../lib/labels";

interface ItemDraft {
  key: string;
  projectId: string;
  fundingRequestId: string;
  date: string;
  category: (typeof EXPENSE_CATEGORY)[number];
  amountYuan: string;
  description: string;
  payee: string;
  receiptNo: string;
  receiptFile: File | null;
}

function emptyItem(projectId: string): ItemDraft {
  return {
    key: crypto.randomUUID(),
    projectId,
    fundingRequestId: "",
    date: new Date().toISOString().slice(0, 10),
    category: "transport",
    amountYuan: "",
    description: "",
    payee: "",
    receiptNo: "",
    receiptFile: null,
  };
}

/**
 * 报销创建：明细编辑器 + 票据暂存上传。
 * 流程：expense.create（服务端算合计）→ 逐明细上传票据并 attachReceipt → 可提交审批。
 * 合计只读展示服务端计算值（创建前显示「预估」仅供参考）。
 */
export default function ExpenseNewPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const preProjectId = params.get("projectId") ?? "";
  const travelId = params.get("travelId") ?? "";
  const me = useMe();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const mutations = useExpenseMutations();
  const [reason, setReason] = useState(travelId ? "出差费用报销" : "");
  const [items, setItems] = useState<ItemDraft[]>([emptyItem(preProjectId)]);
  const [error, setError] = useState<string | null>(null);
  const [attachState, setAttachState] = useState<string | null>(null);
  const projects = me.data?.projects ?? [];
  const fundings = useFundingList({ mine: true, status: "approved" });

  const update = (key: string, patch: Partial<ItemDraft>) =>
    setItems((prev) => prev.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  const estimateCents = items.reduce((sum, it) => sum + (parseYuanToCents(it.amountYuan) ?? 0), 0);

  const canCreate = reason.trim() && items.length > 0 && items.every((it) => it.projectId && it.date && it.amountYuan && parseYuanToCents(it.amountYuan));

  const createAndAttach = async () => {
    setError(null);
    try {
      const report = await mutations.create.mutateAsync({
        reason: reason.trim(),
        isCrossProject: new Set(items.map((i) => i.projectId)).size > 1,
        travelId: travelId || undefined,
        items: items.map((it) => ({
          projectId: it.projectId,
          fundingRequestId: it.fundingRequestId || undefined,
          date: it.date,
          category: it.category,
          amountCents: parseYuanToCents(it.amountYuan)!,
          description: it.description.trim(),
          payee: it.payee.trim() || undefined,
          receiptNo: it.receiptNo.trim() || undefined,
        })),
      });
      // 票据：按复合键匹配服务端落库的明细行，逐行上传并关联（幂等键）
      const draftsWithFile = items.filter((it) => it.receiptFile);
      if (draftsWithFile.length > 0) {
        const detail = await queryClient.fetchQuery(
          trpc.expense.getById.queryOptions({ id: report.id }),
        );
        for (const it of draftsWithFile) {
          const cents = parseYuanToCents(it.amountYuan)!;
          const row = detail.items.find(
            (r) =>
              r.projectId === it.projectId &&
              r.date === it.date &&
              r.category === it.category &&
              r.amountCents === cents &&
              (r.receiptNo ?? "") === it.receiptNo.trim(),
          );
          if (!row) continue;
          setAttachState(`上传票据：${it.receiptFile!.name}`);
          const uploaded = await uploadProjectFile(it.receiptFile!, "expense", report.id, newIdempotencyKey());
          await mutations.attachReceipt.mutateAsync({ itemId: row.id, fileVersionId: uploaded.fileVersionId });
        }
      }
      navigate(`/expenses/${report.id}`);
    } catch (err) {
      setError(rootErrorMessage(err));
      setAttachState(null);
    }
  };

  return (
    <div className="screen expense-new-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">NEW EXPENSE</span>
          <h1>费用报销</h1>
          <p>合计由服务端计算（前端传值被忽略）；票据号+金额重复将被阻止并定位原单。</p>
        </div>
        <button className="secondary-action" onClick={() => navigate(-1)}>
          <X size={15} />
          取消
        </button>
      </div>
      <section className="create-form">
        <label className="form-field">
          <span>报销事由 *{travelId ? "（已关联出差）" : ""}</span>
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <div className="form-field">
          <span>费用明细 *（跨项目可分行填写；每行归属一个项目）</span>
          {items.map((it) => (
            <ExpenseItemRow
              key={it.key}
              item={it}
              projects={projects.map((p) => ({ id: p.id, name: p.name }))}
              fundings={(fundings.data?.items ?? []).map((f) => ({ id: f.id, code: f.code, amountCents: f.amountCents }))}
              onChange={(patch) => update(it.key, patch)}
              onRemove={() => setItems((prev) => prev.filter((x) => x.key !== it.key))}
            />
          ))}
          <button className="secondary-action" onClick={() => setItems((prev) => [...prev, emptyItem(preProjectId || projects[0]?.id || "")])}>
            添加明细行
          </button>
        </div>
        <p className="context-note">
          合计：<strong className="mono">{formatYuan(estimateCents)} 元</strong>（预估，仅供填写参考；
          <strong>最终合计以服务端计算为准</strong>，创建后不可改）
          {items.some((it) => it.receiptFile) ? "；票据将在创建后自动上传并关联。" : ""}
        </p>
        {attachState ? <p className="context-note">{attachState}</p> : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="primary-action"
          disabled={!canCreate || mutations.create.isPending}
          onClick={() => void createAndAttach()}
        >
          {mutations.create.isPending ? "创建中…" : "创建报销单"}
          <ArrowRight size={16} />
        </button>
      </section>
    </div>
  );
}

function ExpenseItemRow({
  item,
  projects,
  fundings,
  onChange,
  onRemove,
}: {
  item: ItemDraft;
  projects: { id: string; name: string }[];
  fundings: { id: string; code: string; amountCents: number }[];
  onChange: (patch: Partial<ItemDraft>) => void;
  onRemove: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="expense-item-row">
      <div className="expense-item-grid">
        <select value={item.projectId} aria-label="明细项目" onChange={(e) => onChange({ projectId: e.target.value })}>
          <option value="">项目 *</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input type="date" value={item.date} aria-label="费用日期" onChange={(e) => onChange({ date: e.target.value })} />
        <select
          value={item.category}
          aria-label="费用类别"
          onChange={(e) => onChange({ category: e.target.value as never })}
        >
          {EXPENSE_CATEGORY.map((c) => (
            <option key={c} value={c}>
              {EXPENSE_CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
        <input
          type="number"
          min="0.01"
          step="0.01"
          value={item.amountYuan}
          placeholder="金额（元）*"
          aria-label="金额"
          onChange={(e) => onChange({ amountYuan: e.target.value })}
        />
        <input value={item.payee} placeholder="支付对象" aria-label="支付对象" onChange={(e) => onChange({ payee: e.target.value })} />
        <input value={item.receiptNo} placeholder="票据号码" aria-label="票据号码" onChange={(e) => onChange({ receiptNo: e.target.value })} />
        <select
          value={item.fundingRequestId}
          aria-label="关联经费"
          onChange={(e) => onChange({ fundingRequestId: e.target.value })}
        >
          <option value="">不关联经费</option>
          {fundings.map((f) => (
            <option key={f.id} value={f.id}>
              {f.code}（{formatYuan(f.amountCents)} 元）
            </option>
          ))}
        </select>
        <input
          value={item.description}
          placeholder="说明"
          aria-label="说明"
          onChange={(e) => onChange({ description: e.target.value })}
        />
        <button type="button" className="secondary-action" onClick={() => fileRef.current?.click()}>
          {item.receiptFile ? `已选：${item.receiptFile.name}` : "选择票据文件"}
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={(e) => onChange({ receiptFile: e.target.files?.[0] ?? null })}
        />
      </div>
      <button type="button" className="icon-button" aria-label="删除明细行" onClick={onRemove}>
        <X size={15} />
      </button>
    </div>
  );
}
