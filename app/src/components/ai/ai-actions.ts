import { toast } from "sonner";

/** §17.2 动作执行：写动作一律只产草稿/预填——用户复核后自行提交/发布 */

export const AI_TIME_DRAFT_KEY = "lexflow-ai-time-draft";
export const AI_MINUTES_DRAFT_KEY = "lexflow-ai-minutes-draft";
export const AI_FLOW_DRAFT_KEY = "lexflow-ai-flow-draft";
export const AI_NOTICE_KEY = "lexflow-ai-notice-shown";

function readJson<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
export function consumeAiDraft<T>(key: string): T | null {
  const v = readJson<T>(key);
  if (v !== null) sessionStorage.removeItem(key);
  return v;
}

/** A1 表单预填：按 label 邻近匹配回填当前打开弹窗表单（用户复核自行提交） */
export function applyFormPrefill(values: Record<string, unknown>): { applied: string[] } {
  const dlg = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
  if (!dlg) return { applied: [] };
  const applied: string[] = [];
  const fill = (fieldMatch: RegExp, value: unknown, kind: "text" | "date" | "select") => {
    if (value === undefined || value === null || value === "") return;
    const fields = [...dlg.querySelectorAll<HTMLElement>(".form-field")];
    const target = fields.find((f) => fieldMatch.test(f.querySelector("span")?.textContent ?? ""));
    if (!target) return;
    if (kind === "select") {
      const sel = target.querySelector("select");
      const opt = [...(sel?.options ?? [])].find((o) => o.value === value || o.textContent?.includes(String(value)));
      if (sel && opt) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        applied.push(String(value));
      }
      return;
    }
    const input = target.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
    if (input) {
      const v = kind === "date" ? String(value).slice(0, 10) : String(value);
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(input, v);
      else input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      applied.push(v);
    }
  };
  fill(/目的地|行程目的地/, values.destination, "text");
  fill(/开始日期|出发日期|起始/, values.startOn, "date");
  fill(/出差事由|事由|原因|用途/, values.reason, "text");
  fill(/行程类型|交通|出行/, values.transport, "select");
  return { applied };
}

export interface AiTimeDraftEntry {
  projectName: string;
  workDate: string;
  minutes: number;
  hours: number;
  description: string;
}

/** A2：工时草稿存 sessionStorage → 跳工时中心（预填区横幅/当日编辑预填，用户保存生效） */
export function stageTimeDraft(entries: AiTimeDraftEntry[], navigate: (to: string) => void) {
  sessionStorage.setItem(AI_TIME_DRAFT_KEY, JSON.stringify({ entries, savedAt: new Date().toISOString() }));
  navigate("/operations/time");
  toast.success("已生成工时草稿", { description: "已跳到工时中心，草稿在当日编辑区待你确认保存。" });
}

/** A3：纪要草稿 → 会议纪要编辑器（进入编辑态预填，用户编辑后提交） */
export function stageMinutesDraft(draft: string, meetingId: string | null, navigate: (to: string) => void) {
  sessionStorage.setItem(AI_MINUTES_DRAFT_KEY, JSON.stringify({ draft, savedAt: new Date().toISOString() }));
  if (meetingId) navigate(`/meetings/${meetingId}`);
  toast.success("已生成纪要草稿", { description: "已进入纪要编辑态并预填正文，请编辑后提交确认。" });
}

/** A4：流程 DSL 草稿 → 打开设计器预填（用户校验后发布） */
export function stageFlowDraft(definitionJson: unknown, description: string, navigate: (to: string) => void) {
  sessionStorage.setItem(AI_FLOW_DRAFT_KEY, JSON.stringify({ definitionJson, description, savedAt: new Date().toISOString() }));
  navigate("/admin/flows/new");
  toast.success("已生成审批流 DSL 草稿", { description: "已打开流程设计器并预填画布，请校验后保存/发布。" });
}
