import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plug, Save } from "lucide-react";

import { useAiConfig, useAiConfigMutations, useAiUsageAdmin } from "../../api/ai";
import { GlobalUsageView } from "../../components/ai/AiUsage";
import { DomainIconBlock } from "../../lib/DomainIconBlock";
import { rootErrorMessage } from "../../lib/form";

/**
 * §17.6 AI 配置页（治理→系统配置→AI 配置；sysadmin 专有）：
 * provider_url/model/api_key（密文+现值后 4 位）/启用开关 + 测试联通（延迟/错误）+ 保存；
 * 配置页内全局用量视图（按人 Top+按日趋势）。改后全局生效（config 优先 env，30s 缓存即刻失效）。
 */
export default function AiConfigTab() {
  const config = useAiConfig();
  const mutations = useAiConfigMutations();
  const adminUsage = useAiUsageAdmin();
  const [providerUrl, setProviderUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- 配置到达时一次性同步表单（依赖即数据源） */
    if (config.data) {
      setProviderUrl(config.data.providerUrl ?? "");
      setModel(config.data.model ?? "");
      setEnabled(config.data.enabled);
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [config.data]);

  if (config.isPending) return <p className="list-note">正在加载 AI 配置…</p>;
  if (config.isError) throw config.error;
  const c = config.data;

  const dirty = providerUrl !== (c.providerUrl ?? "") || model !== (c.model ?? "") || apiKey !== "";

  return (
    <div className="ai-config-tab">
      <div className="section-heading">
        <div>
          <span className="section-label">AI PROVIDER · 全局生效</span>
          <h2 style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <DomainIconBlock domain="ai" size={24} iconSize={14} />
            AI 提供方配置
          </h2>
        </div>
        <span className="toolbar-hint">当前来源：{c.source === "system_config" ? "系统配置（优先于 env）" : "env 缺省（MockProvider）"}</span>
      </div>

      <div className="form-section"><span className="section-label">连接</span></div>
      <label className="form-field">
        <span>Provider URL（OpenAI 兼容 /chat/completions）</span>
        <input value={providerUrl} placeholder="https://api.example.com/v1" onChange={(e) => setProviderUrl(e.target.value)} />
      </label>
      <div className="owner-line">
        <label className="form-field">
          <span>模型</span>
          <input value={model} placeholder="如 kimi-k2 / gpt-4o-mini；留空=mock" onChange={(e) => setModel(e.target.value)} />
        </label>
        <label className="form-field">
          <span>API Key（密文保存，仅后 4 位可见）</span>
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={c.apiKeyMasked ? `现值 ${c.apiKeyMasked}（输入以更换）` : "未配置"}
            onChange={(e) => setApiKey(e.target.value)}
          />
          {c.apiKeyMasked ? <em className="context-note">现值仅显示后 4 位：{c.apiKeyMasked}</em> : null}
        </label>
      </div>
      {!c.providerUrl || !c.apiKeyMasked ? (
        <p className="context-note">未配置外部提供方——内置 MockProvider 可用（演示/验收模式），保存 key 后自动切换真实端点。</p>
      ) : null}

      <div className="form-section"><span className="section-label">开关与联通</span></div>
      <div className="ai-config-row">
        <label className="check-field compact">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用小元（关闭后 ai.chat 返回 403，调用不计用量）
        </label>
        <div className="row-ops">
          <button
            className="secondary-action"
            disabled={mutations.test.isPending}
            onClick={() => {
              setError(null);
              mutations.test.mutate({}, {
                onSuccess: (r) => {
                  if (r.ok) toast.success(`联通正常 · ${r.latencyMs}ms`, { description: "note" in r && r.note ? r.note : `model=${r.model}` });
                  else toast.error(`联通失败 · ${r.latencyMs}ms`, { description: r.error ?? "未知错误" });
                },
                onError: (err) => setError(rootErrorMessage(err)),
              });
            }}
          >
            <Plug size={15} />
            {mutations.test.isPending ? "探测中…" : "测试联通"}
          </button>
          {c.apiKeyMasked ? (
            <button
              className="secondary-action"
              disabled={mutations.set.isPending}
              onClick={() => {
                setError(null);
                mutations.set.mutate(
                  { apiKey: null },
                  { onSuccess: () => { setApiKey(""); toast.success("API Key 已清除", { description: "回落 env/缺省——MockProvider 模式。" }); }, onError: (err) => setError(rootErrorMessage(err)) },
                );
              }}
            >
              清除 Key
            </button>
          ) : null}
          <button
            className="primary-action"
            disabled={(!dirty && enabled === c.enabled) || mutations.set.isPending}
            onClick={() => {
              setError(null);
              mutations.set.mutate(
                {
                  providerUrl: providerUrl || null,
                  model: model || null,
                  apiKey: apiKey || undefined,
                  enabled,
                },
                {
                  onSuccess: (r) => {
                    setApiKey("");
                    toast.success("AI 配置已保存", { description: `全局生效（即刻失效缓存）· key=${r.apiKeyMasked ?? "已清除"}` });
                  },
                  onError: (err) => setError(rootErrorMessage(err)),
                },
              );
            }}
          >
            <Save size={15} />
            保存
          </button>
        </div>
      </div>
      {mutations.test.data ? (
        <p className={`context-note ${mutations.test.data.ok ? "" : "form-error"}`} role="status">
          最近测试：{mutations.test.data.ok ? "✅ 联通" : "❌ 失败"} · 延迟 {mutations.test.data.latencyMs}ms
          {("error" in mutations.test.data && mutations.test.data.error) ? ` · 错误：${mutations.test.data.error}` : ""}
          {("note" in mutations.test.data && mutations.test.data.note) ? ` · ${mutations.test.data.note}` : ""}
        </p>
      ) : null}
      {error ? <p className="form-error" role="alert">{error}</p> : null}

      <div className="form-section"><span className="section-label">GLOBAL USAGE · 全局用量（近 30 天）</span></div>
      {adminUsage.isPending ? <p className="list-note">正在加载用量…</p> : adminUsage.isError ? <p className="list-note">用量加载失败。</p> : (
        <GlobalUsageView items={adminUsage.data.items as never} />
      )}
    </div>
  );
}
