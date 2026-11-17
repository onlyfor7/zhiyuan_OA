import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowLeft, Eye } from "lucide-react";
import { toast } from "sonner";

import type { CustomFormSchema } from "@lexflow/shared";
import { FLOW_BIZ_BINDINGS } from "../../lib/labels";
import { type RouterOutputs } from "../../lib/trpc";
import { useFlow, useFlowMutations } from "../../api/flow";
import { useForm, useFormList, useFormMutations } from "../../api/forms";
import { newClientKey, rootErrorMessage } from "../../lib/form";
import { AI_FLOW_DRAFT_KEY } from "../../components/ai/ai-actions";
import { defaultV2Def, isV2Def, serializeDef, validateV2, type V2Def } from "./v2-model";
import { FormDesignStep } from "./FormDesignStep";
import { FlowDesignStep } from "./FlowDesignStep";

/**
 * 四步审批流向导（arch/14 §2/§10-11）：系统级（新建自定义审批/新建业务流程/编辑）与项目级（三步态）两形态。
 * 草稿自动保存（防抖 → forms/flows updateDraft，rowVersion 往返，409 提示刷新）。
 */

type FlowRow = RouterOutputs["flow"]["getById"];
type FormRow = RouterOutputs["forms"]["getById"];

export interface WizardMeta {
  name: string;
  description: string;
  icon: string;
  groupName: string;
  visibility: { mode: "all" | "roles" | "users"; roleKeys: string[]; userIds: string[] };
}

export interface WizardState {
  meta: WizardMeta;
  schema: CustomFormSchema;
  def: V2Def;
  formId: string | null;
  formRv: number;
  flowId: string | null;
  flowRv: number;
  flowEnabled: boolean;
  bizBinding: string;
  isCustom: boolean;
  projectId: string | null;
}

const ICON_OPTIONS = ["ClipboardList", "FileText", "Receipt", "Plane", "Banknote", "CalendarClock", "ShieldCheck", "GitBranch"];
const emptyMeta = (): WizardMeta => ({ name: "", description: "", icon: "ClipboardList", groupName: "通用", visibility: { mode: "all", roleKeys: [], userIds: [] } });

export default function FlowWizardPage() {
  const { flowId: routeFlowId, projectId: routeProjectId } = useParams();
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const flowMut = useFlowMutations();
  const formMut = useFormMutations();

  const isProject = !!routeProjectId;
  const isNew = !routeFlowId;
  const newKind = sp.get("kind") === "biz" ? "biz" : "custom";

  const flowQuery = useFlow(routeFlowId ?? null);
  const formList = useFormList(!isProject && !isNew && (flowQuery.data?.bizBinding ?? "").startsWith("custom_form:"));
  const boundForm = useMemo(() => {
    const binding = flowQuery.data?.bizBinding;
    if (!binding?.startsWith("custom_form:")) return null;
    const code = binding.slice("custom_form:".length);
    return (formList.data?.items ?? []).find((f) => f.code === code) ?? null;
  }, [flowQuery.data, formList.data]);
  const formQuery = useForm(boundForm?.id ?? null);

  const [state, setState] = useState<WizardState | null>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "conflict">("idle");
  const [created, setCreated] = useState(false); // 新建首存后置 true（避免重复 create）
  const [baselineFp, setBaselineFp] = useState<string | null>(null); // O-20-5-4：装载指纹基线（未编辑零请求）
  const saveTimer = useRef<number | null>(null);
  const lastSaved = useRef<string>("");

  // 装载：编辑态/项目态（render 期一次键控装载，替代 effect setState）
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const flowData = flowQuery.data as FlowRow | undefined;
  const formData = formQuery.data as FormRow | undefined;
  const loadKey = isNew
    ? `new:${newKind}:${routeProjectId ?? ""}`
    : flowData
      ? flowData.bizBinding.startsWith("custom_form:")
        ? formData
          ? `edit:${flowData.id}:${formData.id}`
          : null
        : `edit:${flowData.id}`
      : null;
  if (loadKey && loadedKey !== loadKey) {
    setLoadedKey(loadKey);
    if (isNew) {
      const meta = emptyMeta();
      const schema: CustomFormSchema = { fields: [] };
      const def = defaultV2Def();
      setBaselineFp(JSON.stringify([meta, schema, def, null]));
      setState({
        meta,
        schema,
        def,
        formId: null, formRv: 0, flowId: null, flowRv: 0, flowEnabled: false,
        bizBinding: isProject ? "generic_request" : newKind === "biz" ? "generic_request" : "",
        isCustom: !isProject && newKind === "custom",
        projectId: routeProjectId ?? null,
      });
    } else if (flowData) {
      const custom = flowData.bizBinding.startsWith("custom_form:");
      const def = isV2Def(flowData.definitionJson) ? (flowData.definitionJson as V2Def) : defaultV2Def();
      const meta = {
        name: flowData.name,
        description: formData?.description ?? "",
        icon: formData?.icon ?? "ClipboardList",
        groupName: formData?.groupName ?? "通用",
        visibility: (formData?.visibility as WizardMeta["visibility"]) ?? { mode: "all", roleKeys: [], userIds: [] },
      };
      const schema = (formData?.formSchema as CustomFormSchema | undefined) ?? { fields: [] };
      setBaselineFp(JSON.stringify([meta, schema, def, flowData.id]));
      setState({
        meta,
        schema,
        def,
        formId: formData?.id ?? null,
        formRv: formData?.rowVersion ?? 0,
        flowId: flowData.id,
        flowRv: flowData.rowVersion,
        flowEnabled: flowData.enabled,
        bizBinding: flowData.bizBinding,
        isCustom: custom,
        projectId: flowData.projectId ?? routeProjectId ?? null,
      });
    }
  }

  // 装载键变化时重置保存指纹（effect 内更新 ref，符合 react-hooks/refs）
  useEffect(() => {
    lastSaved.current = "";
  }, [loadedKey]);

  // O-20-5-9：AI A4 流程草稿预填——新向导挂载消费 sessionStorage 一次（读后即清，含坏数据）
  const aiDraftConsumed = useRef(false);
  useEffect(() => {
    if (!isNew || aiDraftConsumed.current) return;
    aiDraftConsumed.current = true;
    const raw = sessionStorage.getItem(AI_FLOW_DRAFT_KEY);
    if (!raw) return;
    sessionStorage.removeItem(AI_FLOW_DRAFT_KEY);
    try {
      const parsed = JSON.parse(raw) as { definitionJson?: unknown; description?: string };
      const def = isV2Def(parsed.definitionJson) ? (parsed.definitionJson as V2Def) : null;
      if (!def) return;
      const description = parsed.description ?? "";
      // setState 经微任务异步触发（react-hooks/set-state-in-effect 合规）
      queueMicrotask(() => {
        setState((s) => (s ? { ...s, def, meta: { ...s.meta, description: s.meta.description || description } } : s));
        setStep((v) => (state?.isCustom && !isProject ? Math.max(v, 2) : Math.max(v, 1))); // 直达流程设计步
      });
      toast.success("已载入 AI 流程草稿", { description: description || "已预填流程设计步，请校验后保存/发布。" });
    } catch {
      /* 坏数据静默忽略 */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅挂载消费一次
  }, [isNew]);

  const steps = state?.isCustom && !isProject ? ["基础信息", "表单设计", "流程设计", "更多设置"] : ["基础信息", "流程设计", "更多设置"];
  // O-20-5-5：stepIndex 与步骤条/渲染条件同一口径（四步态 slot 1=表单设计；三步态无表单设计步）
  const stepIndex = step;
  const flowDesignIndex = state?.isCustom && !isProject ? 2 : 1;
  const settingsIndex = state?.isCustom && !isProject ? 3 : 2;

  const patch = useCallback((p: Partial<WizardState>) => {
    setState((s) => (s ? { ...s, ...p } : s));
  }, []);

  const stateRef = useRef<WizardState | null>(null);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const savingRef = useRef<Promise<{ formRv: number; flowRv: number } | null> | null>(null);

  /** 首存：新建自定义=forms.create（同事务建绑定流）；新建业务/项目=flows.createDraft */
  const ensureCreated = async (): Promise<boolean> => {
    const cur = stateRef.current;
    if (!cur || cur.flowId) return true;
    try {
      if (cur.isCustom && !cur.projectId) {
        const createdForm = await formMut.create.mutateAsync({
          name: cur.meta.name.trim() || "未命名审批",
          description: cur.meta.description || undefined,
          icon: cur.meta.icon,
          groupName: cur.meta.groupName,
          visibility: cur.meta.visibility,
          formSchema: cur.schema,
        });
        patch({ formId: createdForm.id, formRv: createdForm.rowVersion, flowId: createdForm.flowId, flowRv: 0, bizBinding: `custom_form:${createdForm.code}` });
        setCreated(true);
        return true;
      }
      const createdFlow = await flowMut.createDraft.mutateAsync({
        name: cur.meta.name.trim() || "未命名流程",
        scope: cur.projectId ? "project" : "global",
        bizBinding: cur.projectId ? "generic_request" : cur.bizBinding,
        projectId: cur.projectId ?? undefined,
        definitionJson: serializeDef(cur.def),
      });
      patch({ flowId: createdFlow.id, flowRv: createdFlow.rowVersion });
      setCreated(true);
      return true;
    } catch (err) {
      setError(rootErrorMessage(err));
      return false;
    }
  };

  /** 立即保存草稿并返回最新 rowVersion（防抖计时器与发布前 flush 共用；串行化防并发写） */
  const saveNow = async (): Promise<{ formRv: number; flowRv: number } | null> => {
    if (savingRef.current) {
      try { await savingRef.current; } catch { /* 上一次失败不阻断本次 */ }
    }
    const run = (async () => {
      let cur = stateRef.current;
      if (!cur) return null;
      if (!cur.flowId) {
        const nameOk = cur.meta.name.trim().length > 0 || cur.isCustom === false;
        if (!nameOk) return null;
        if (!(await ensureCreated())) return null;
        cur = stateRef.current;
        if (!cur) return null;
      }
      setSaving("saving");
      try {
        if (cur.isCustom && cur.formId) {
          const f = await formMut.updateDraft.mutateAsync({
            id: cur.formId, rowVersion: cur.formRv,
            name: cur.meta.name.trim(), description: cur.meta.description, icon: cur.meta.icon,
            groupName: cur.meta.groupName, visibility: cur.meta.visibility, formSchema: cur.schema,
          });
          let flowRv = cur.flowRv;
          if (cur.flowId) {
            const fl = await flowMut.updateDraft.mutateAsync({ id: cur.flowId, rowVersion: cur.flowRv, name: cur.meta.name.trim(), definitionJson: serializeDef(cur.def) });
            flowRv = fl.rowVersion;
          }
          lastSaved.current = JSON.stringify([cur.meta, cur.schema, cur.def, cur.flowId]);
          setState((x) => (x ? { ...x, formRv: f.rowVersion, flowRv } : x));
          setSaving("saved");
          return { formRv: f.rowVersion, flowRv };
        }
        if (cur.flowId) {
          const fl = await flowMut.updateDraft.mutateAsync({ id: cur.flowId, rowVersion: cur.flowRv, name: cur.meta.name.trim(), definitionJson: serializeDef(cur.def) });
          lastSaved.current = JSON.stringify([cur.meta, cur.schema, cur.def, cur.flowId]);
          setState((x) => (x ? { ...x, flowRv: fl.rowVersion } : x));
          setSaving("saved");
          return { formRv: cur.formRv, flowRv: fl.rowVersion };
        }
        return null;
      } catch (err) {
        if (rootErrorMessage(err).includes("版本冲突")) {
          setSaving("conflict");
          toast.error("草稿已被他人修改，请刷新后重试");
        } else {
          setSaving("idle");
          setError(rootErrorMessage(err));
        }
        return null;
      }
    })();
    savingRef.current = run;
    try {
      return await run;
    } finally {
      if (savingRef.current === run) savingRef.current = null;
    }
  };

  /** 自动保存（防抖 800ms；指纹基线门控=未编辑零请求（O-20-5-4）；rowVersion 往返；409 提示刷新） */
  useEffect(() => {
    if (!state) return;
    const fingerprint = JSON.stringify([state.meta, state.schema, state.def, state.flowId]);
    if (fingerprint === lastSaved.current) return;
    if (baselineFp !== null && fingerprint === baselineFp) return; // 未经编辑（或改回初始值）不触发保存
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveNow();
    }, 800);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 指纹驱动防抖保存
  }, [state, created, baselineFp]);

  if (!state || (isNew === false && flowQuery.isPending) || (isNew === false && !state.flowId)) {
    return <p className="list-note">正在加载流程…</p>;
  }
  if (!isNew && flowQuery.isError) throw flowQuery.error;

  const publish = async () => {
    setError(null);
    try {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const fresh = await saveNow(); // 先冲刷防抖草稿，拿最新 rowVersion 再发布（避免 409 竞态）
      const s = stateRef.current;
      if (!s) return;
      if (!s.flowId && !(await ensureCreated())) return;
      const cur = stateRef.current ?? s;
      const errs = validateV2(cur.def, cur.schema.fields);
      if (Object.keys(errs).length > 0) {
        setError(`流程结构校验未通过：${Object.values(errs)[0]}（已定位到流程设计步）`);
        setStep(cur.isCustom && !isProject ? 2 : 1);
        return;
      }
      if (cur.isCustom && cur.formId) {
        await formMut.publish.mutateAsync({ id: cur.formId, rowVersion: fresh?.formRv ?? cur.formRv });
        toast.success("已发布：表单与绑定流程已生效");
      } else if (cur.flowId) {
        await flowMut.publish.mutateAsync({ id: cur.flowId, idempotencyKey: newClientKey() });
        toast.success("流程已发布并生效");
      }
      navigate(cur.projectId ? `/projects/${cur.projectId}/flows` : "/admin?tab=flows");
    } catch (err) {
      setError(rootErrorMessage(err));
    }
  };

  return (
    <div className="screen flow-wizard-screen">
      <div className="fw-topbar">
        <Link to={state.projectId ? `/projects/${state.projectId}/flows` : "/admin?tab=flows"} className="secondary-action">
          <ArrowLeft size={15} />
          返回
        </Link>
        <div className="p9a-stepper fw-steps" role="tablist">
          {steps.map((s, i) => (
            <button key={s} role="tab" aria-selected={stepIndex === i} className={`p9a-step ${stepIndex === i ? "current" : i < stepIndex ? "done" : ""}`} onClick={() => setStep(i)}>
              <span>{i < stepIndex ? "✓" : i + 1}</span>{s}
            </button>
          ))}
        </div>
        <div className="row-ops">
          <span className="fw-save-state">
            {saving === "saving" ? "保存中…" : saving === "saved" ? "草稿已自动保存" : saving === "conflict" ? "版本冲突，请刷新" : ""}
          </span>
          <button className="secondary-action" disabled title="P2：预览">
            <Eye size={15} />
            预览
          </button>
          <button className="primary-action" onClick={() => void publish()} disabled={formMut.publish.isPending || flowMut.publish.isPending}>
            发布
          </button>
        </div>
      </div>
      {error ? <p className="form-error" role="alert" style={{ margin: "8px 0 0" }}>{error}</p> : null}

      {stepIndex === 0 ? (
        <BasicStep state={state} patch={patch} isProject={isProject} isNew={isNew} newKind={newKind} />
      ) : null}
      {stepIndex === 1 && state.isCustom && !isProject ? (
        <FormDesignStep schema={state.schema} onChange={(schema) => patch({ schema })} />
      ) : null}
      {stepIndex === flowDesignIndex ? (
        <FlowDesignStep
          def={state.def}
          bizBinding={state.bizBinding}
          formFields={state.schema.fields}
          isCustomForm={state.isCustom}
          onChange={(def) => patch({ def })}
        />
      ) : null}
      {stepIndex === settingsIndex ? (
        <SettingsStep state={state} patch={patch} />
      ) : null}

      <div className="fw-foot">
        <button className="secondary-action" disabled={stepIndex === 0} onClick={() => setStep((v) => Math.max(0, v - 1))}>上一步</button>
        <button className="primary-action" disabled={stepIndex >= steps.length - 1} onClick={() => setStep((v) => Math.min(steps.length - 1, v + 1))}>下一步</button>
      </div>
    </div>
  );
}

/** ① 基础信息（自定义审批全字段；业务流程=名称/说明/绑定；项目级=名称/说明简形态） */
function BasicStep({ state, patch, isProject, isNew, newKind }: { state: WizardState; patch: (p: Partial<WizardState>) => void; isProject: boolean; isNew: boolean; newKind: "custom" | "biz" }) {
  const setMeta = (p: Partial<WizardMeta>) => patch({ meta: { ...state.meta, ...p } });
  const roleKeys = Object.keys({ partner: 1, project_manager: 1, member: 1, quality_lead: 1, finance: 1, archivist: 1, sysadmin: 1, viewer: 1, sales: 1, sales_manager: 1, presales: 1, operations: 1, regional_vp: 1, ceo: 1 });
  return (
    <div className="fw-step-body">
      <div className="fw-card">
        <span className="section-label">BASIC · 基础信息</span>
        {state.isCustom && !isProject ? (
          <>
            <label className="form-field">
              <span>图标 *</span>
              <select value={state.meta.icon} onChange={(e) => setMeta({ icon: e.target.value })}>
                {ICON_OPTIONS.map((i) => <option key={i} value={i}>{i}</option>)}
              </select>
            </label>
          </>
        ) : null}
        <label className="form-field">
          <span>{state.isCustom ? "审批名称 *" : "流程名称 *"}</span>
          <input value={state.meta.name} onChange={(e) => setMeta({ name: e.target.value })} placeholder={state.isCustom ? "如：用章申请" : "如：报销自定义流程"} />
        </label>
        <label className="form-field">
          <span>说明</span>
          <textarea rows={2} value={state.meta.description} onChange={(e) => setMeta({ description: e.target.value })} />
        </label>
        {state.isCustom && !isProject ? (
          <>
            <label className="form-field">
              <span>分组（选择既有或输入新组名）</span>
              <input list="fw-groups" value={state.meta.groupName} onChange={(e) => setMeta({ groupName: e.target.value })} />
              <datalist id="fw-groups">
                <option value="通用" />
                <option value="人事" />
                <option value="行政" />
                <option value="财务" />
              </datalist>
            </label>
            <span className="section-label">谁可以提交</span>
            <div className="owner-line">
              <label className="form-field">
                <span>范围</span>
                <select value={state.meta.visibility.mode} onChange={(e) => setMeta({ visibility: { ...state.meta.visibility, mode: e.target.value as WizardMeta["visibility"]["mode"] } })}>
                  <option value="all">全员</option>
                  <option value="roles">指定角色</option>
                  <option value="users">指定成员</option>
                </select>
              </label>
              {state.meta.visibility.mode === "roles" ? (
                <div className="form-field">
                  <span>角色（多选）</span>
                  <div className="org-role-grid">
                    {roleKeys.map((r) => (
                      <label key={r} className="check-field">
                        <input
                          type="checkbox"
                          checked={state.meta.visibility.roleKeys.includes(r)}
                          onChange={(e) =>
                            setMeta({
                              visibility: {
                                ...state.meta.visibility,
                                roleKeys: e.target.checked
                                  ? [...state.meta.visibility.roleKeys, r]
                                  : state.meta.visibility.roleKeys.filter((x) => x !== r),
                              },
                            })
                          }
                        />
                        {r}
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            <p className="context-note">流程管理员：系统管理员（sysadmin）——按 arch/14 §13 为展示语义，不新增权限点。</p>
          </>
        ) : null}
        {isNew && !isProject && newKind === "biz" ? (
          <label className="form-field">
            <span>绑定业务 *</span>
            <select value={state.bizBinding} onChange={(e) => patch({ bizBinding: e.target.value })}>
              {FLOW_BIZ_BINDINGS.filter(([v]) => v !== "generic_request").map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
    </div>
  );
}

/** ④ 更多设置（arch/14 §10 P1 子集） */
function SettingsStep({ state, patch }: { state: WizardState; patch: (p: Partial<WizardState>) => void }) {
  const setSettings = (p: Partial<V2Def["settings"]>) => patch({ def: { ...state.def, settings: { ...state.def.settings, ...p } } });
  return (
    <div className="fw-step-body">
      <div className="fw-card">
        <span className="section-label">SETTINGS · 更多设置</span>
        <label className="check-field">
          <input type="checkbox" checked={state.def.settings.allowWithdrawPending} onChange={(e) => setSettings({ allowWithdrawPending: e.target.checked })} />
          允许撤回审批中的申请
        </label>
        <div className="form-field">
          <span>审批人去重</span>
          <div className="owner-line">
            <label className="check-field">
              <input type="radio" checked={state.def.settings.dedupeApprover === "once"} onChange={() => setSettings({ dedupeApprover: "once" })} />
              once（同一审批人只审一次，后续节点自动同意）
            </label>
            <label className="check-field">
              <input type="radio" checked={state.def.settings.dedupeApprover === "always"} onChange={() => setSettings({ dedupeApprover: "always" })} />
              always（每节点都审）
            </label>
          </div>
        </div>
        <p className="context-note">
          审批标题=表单名 / 摘要=前 3 个字段（arch/14 §10 固定规则 P1）；撤回已通过、效率统计、打印模板等列 P2 不做。
        </p>
      </div>
    </div>
  );
}
