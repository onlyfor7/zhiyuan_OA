import { tabMeta } from "../workspace/tabsMeta";

/**
 * §17.4 上下文白名单采集：route / pageType / summary（项目名、打开表单类型与已填字段、列表计数）。
 * 密级/口令类不采（前端不收集 password 输入与「密级」字段；服务端另有正则剥离兜底）。
 */

export interface AiPageContext {
  route: string;
  pageType: string;
  summary: string;
}

const SKIP_FIELD = /密码|口令|密级|password|passwd|token|secret|credential|authorization|cookie/i;

/** 打开中的弹窗表单：类型 + 已填字段（白名单） */
function collectOpenForm(): { label: string; fields: Array<{ label: string; value: string }> } | null {
  const dlg = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
  if (!dlg) return null;
  const label = dlg.getAttribute("aria-label") ?? dlg.querySelector("h2")?.textContent?.trim() ?? "表单";
  const fields: Array<{ label: string; value: string }> = [];
  dlg.querySelectorAll<HTMLElement>(".form-field").forEach((f) => {
    const lab = f.querySelector("span")?.textContent?.trim() ?? "";
    const input = f.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      "input:not([type=checkbox]):not([type=radio]):not([type=password]), textarea, select",
    );
    const value = input?.value?.trim() ?? "";
    if (!lab || !value || SKIP_FIELD.test(lab)) return;
    fields.push({ label: lab.slice(0, 20), value: value.slice(0, 40) });
  });
  return { label: label.slice(0, 30), fields: fields.slice(0, 8) };
}

function collectListCount(): string | null {
  const body = document.querySelector(".ws-pane.is-active .p9a-ta-body, .ws-pane.is-active .grant-table");
  const rows = body?.querySelectorAll(".p9a-ta-row, .grant-row").length ?? 0;
  return rows > 0 ? `列表 ${rows} 行` : null;
}

export function collectAiContext(pathname: string): AiPageContext {
  const meta = tabMeta(pathname);
  const parts: string[] = [`页面=${meta.title}`];
  const form = collectOpenForm();
  if (form) {
    parts.push(`打开表单=${form.label}`);
    if (form.fields.length > 0) parts.push(`已填字段：${form.fields.map((f) => `${f.label}=${f.value}`).join("；")}`);
  }
  const count = collectListCount();
  if (count) parts.push(count);
  return { route: pathname, pageType: meta.key, summary: parts.join(" | ").slice(0, 900) };
}

/** 面板「本次将发送的上下文」预览（结构化展示用） */
export function contextPreviewLines(ctx: AiPageContext): Array<[string, string]> {
  const lines: Array<[string, string]> = [
    ["当前路由", ctx.route],
    ["页面类型", ctx.pageType || "—"],
  ];
  for (const seg of ctx.summary.split(" | ")) {
    const idx = seg.indexOf("=");
    if (idx > 0) lines.push([seg.slice(0, idx), seg.slice(idx + 1)]);
    else lines.push(["摘要", seg]);
  }
  return lines;
}
