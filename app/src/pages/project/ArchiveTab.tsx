import { useRef, useState } from "react";

import { useUserNameMap } from "../../api/reference";
import { FormDialog } from "../../components/FormDialog";
import { Download, Eye, FileText, Folder, FolderOpen, Link2, Plus, Upload } from "lucide-react";
import { ACCESS_GRANT_SCOPE_TYPE } from "@lexflow/shared";

import {
  fileDownloadUrl,
  filePreviewUrl,
  uploadProjectFile,
  useArchiveMutations,
  useArchiveTree,
  useDirectoryItems,
  useGrantList,
} from "../../api/archive";
import { newIdempotencyKey, rootErrorMessage } from "../../lib/form";
import { GRANT_STATUS_LABEL } from "../../lib/labels";
import type { RouterOutputs } from "../../lib/trpc";
import { UserPicker } from "../../components/UserPicker";
import { useSpaceParams } from "./space-context";

type DirRow = RouterOutputs["archive"]["tree"][number];
type ItemRow = RouterOutputs["archive"]["directoryItems"]["items"][number];
type GrantRow = RouterOutputs["archive"]["grantList"][number];

function fmtSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes > 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function DirectoryView({ dir }: { dir: DirRow }) {
  const { projectId } = useSpaceParams();
  const items = useDirectoryItems(dir.id);
  const mutations = useArchiveMutations();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idemKey, setIdemKey] = useState(newIdempotencyKey);

  if (items.isPending) return <p className="list-note">正在加载目录内容…</p>;
  if (items.isError) throw items.error;

  const uploadAndLink = async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      const uploaded = await uploadProjectFile(file, "project", projectId, idemKey);
      await mutations.link.mutateAsync({ directoryId: dir.id, fileVersionId: uploaded.fileVersionId });
      setIdemKey(newIdempotencyKey());
    } catch (err) {
      setError(err instanceof Error ? err.message : "上传或归集失败");
    } finally {
      setUploading(false);
    }
  };

  return (
    <section className="file-area">
      <div className="file-toolbar">
        <span>
          {dir.name} · {items.data.items.length} 项
        </span>
        <button
          className="secondary-action"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
        >
          <Upload size={15} />
          {uploading ? "上传中…" : "上传并归集"}
        </button>
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadAndLink(f);
            e.target.value = "";
          }}
        />
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="file-list-head archive-items-head">
        <span>名称</span>
        <span>业务日期</span>
        <span>大小/期间</span>
        <span>操作</span>
      </div>
      {items.data.items.length === 0 ? (
        <div className="empty-state">
          <FolderOpen size={24} />
          <strong>目录暂无内容</strong>
          <p>上传过程文件后将按目录自动归集；周报确认归档后会登记到「06_周报与月报」。</p>
        </div>
      ) : (
        items.data.items.map((item: ItemRow) => (
          <div className="file-row archive-item" key={item.id}>
            <div>
              {item.report ? <FileText size={18} /> : <Link2 size={18} />}
              <span>
                <strong>{item.report ? `周报 ${item.report.code}` : (item.file?.name ?? "文件")}</strong>
                <small>
                  {item.report
                    ? `${item.report.periodStart} ~ ${item.report.periodEnd}`
                    : `${item.file?.mimeType ?? ""} · sha256 ${item.file?.sha256?.slice(0, 12) ?? "—"}…`}
                </small>
              </span>
            </div>
            <time>{item.businessDate ?? "—"}</time>
            <span>{item.file?.sizeBytes != null ? fmtSize(item.file.sizeBytes) : "报告"}</span>
            <span className="archive-ops">
              {item.file?.fileVersionId ? (
                <>
                  <a className="text-action" href={filePreviewUrl(item.file.fileVersionId)} target="_blank" rel="noreferrer">
                    <Eye size={13} />
                    预览
                  </a>
                  <a className="text-action" href={fileDownloadUrl(item.file.fileVersionId)}>
                    <Download size={13} />
                    下载
                  </a>
                </>
              ) : (
                <span className="file-status">已登记</span>
              )}
            </span>
          </div>
        ))
      )}
    </section>
  );
}

function GrantApplyForm({ onDone }: { onDone: () => void }) {
  const { projectId } = useSpaceParams();
  const mutations = useArchiveMutations();
  const [granteeId, setGranteeId] = useState("");
  const [scopeType, setScopeType] = useState<(typeof ACCESS_GRANT_SCOPE_TYPE)[number]>("project");
  const [scopeId, setScopeId] = useState(projectId);
  const [actions, setActions] = useState<string[]>(["read"]);
  const [expiresAt, setExpiresAt] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [idemKey] = useState(newIdempotencyKey);

  const toggleAction = (a: string) =>
    setActions((prev) => (prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]));

  const canSubmit = granteeId && scopeId.trim() && actions.length > 0 && reason.trim();

  return (
    <div className="grant-apply-form">
      <div className="owner-line">
        <label className="form-field">
          <span>被授权人 *</span>
          <UserPicker value={granteeId} onChange={setGranteeId} />
        </label>
        <label className="form-field">
          <span>授权范围类型 *</span>
          <select value={scopeType} onChange={(e) => setScopeType(e.target.value as never)}>
            {ACCESS_GRANT_SCOPE_TYPE.map((t) => (
              <option key={t} value={t}>
                {t === "project" ? "项目" : t === "file" ? "文件" : t === "report" ? "报告" : "目录"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="form-field">
        <span>范围对象 ID *{scopeType === "project" ? "（默认当前项目）" : ""}</span>
        <input value={scopeId} onChange={(e) => setScopeId(e.target.value)} />
      </label>
      <div className="form-field">
        <span>允许动作 *</span>
        <label className="check-field compact">
          <input type="checkbox" checked={actions.includes("read")} onChange={() => toggleAction("read")} />
          在线查看（read）
        </label>
        <label className="check-field compact">
          <input type="checkbox" checked={actions.includes("download")} onChange={() => toggleAction("download")} />
          下载（download）
        </label>
      </div>
      <div className="owner-line">
        <label className="form-field">
          <span>授权到期日（留空为长期）</span>
          <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </label>
        <label className="form-field span-2">
          <span>申请理由 *</span>
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
      </div>
      <div className="drawer-note">授权申请提交后进入档案管理员审批（archivist），通过即生效；到期或撤销即时失效。</div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="drawer-actions">
        <button className="secondary-action" onClick={onDone}>
          取消
        </button>
        <button
          className="primary-action"
          disabled={!canSubmit || mutations.grantApply.isPending}
          onClick={() => {
            setError(null);
            mutations.grantApply.mutate(
              {
                scopeType,
                scopeId: scopeId.trim(),
                granteeId,
                actions,
                expiresAt: expiresAt || null,
                reason: reason.trim(),
                idempotencyKey: idemKey,
              },
              {
                onSuccess: onDone,
                onError: (err) => setError(rootErrorMessage(err)),
              },
            );
          }}
        >
          {mutations.grantApply.isPending ? "提交中…" : "提交授权申请"}
          <Plus size={15} />
        </button>
      </div>
    </div>
  );
}

function GrantPanel() {
  const userNames = useUserNameMap();
  const grants = useGrantList();
  const mutations = useArchiveMutations();
  const [applyOpen, setApplyOpen] = useState(false);
  const [revokeFor, setRevokeFor] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (grants.isPending) return <p className="list-note">正在加载授权…</p>;
  if (grants.isError) throw grants.error;

  return (
    <section className="grant-panel">
      <div className="section-heading">
        <div>
          <span className="section-label">ACCESS GRANTS</span>
          <h2>档案授权（{grants.data.length}）</h2>
        </div>
        <button className="secondary-action" onClick={() => setApplyOpen((v) => !v)}>
          <Plus size={15} />
          申请授权
        </button>
      </div>
      {applyOpen ? (
        <FormDialog title="申请档案授权" eyebrow="F2 · 创建走弹窗" onClose={() => setApplyOpen(false)} wide>
          <GrantApplyForm onDone={() => setApplyOpen(false)} />
        </FormDialog>
      ) : null}
      {grants.data.length === 0 ? (
        <p className="list-note">暂无授权记录。</p>
      ) : (
        <div className="grant-table">
          <div className="grant-head">
            <span>被授权人</span>
            <span>范围</span>
            <span>动作</span>
            <span>有效期</span>
            <span>状态</span>
            <span />
          </div>
          {grants.data.map((g: GrantRow) => (
            <div className={`grant-row ${g.status === "revoked" ? "revoked" : ""}`} key={g.id}>
              <div>
                <span className="mini-avatar">{g.granteeId.slice(0, 1)}</span>
                <span>
                  <strong>{userNames.get(g.granteeId) ?? "—"}</strong>
                </span>
              </div>
              <span>
                {g.scopeType}
              </span>
              <span>{g.actions.join("、")}</span>
              <span>{g.expiresAt ? g.expiresAt.slice(0, 10) : "长期"}</span>
              <span className="grant-status">
                {GRANT_STATUS_LABEL[g.status]}
                {g.expired ? "（已过期）" : ""}
              </span>
              {g.status === "active" || g.status === "pending_approval" ? (
                revokeFor === g.id ? (
                  <span className="revoke-inline">
                    <input
                      value={revokeReason}
                      placeholder="撤销理由（必填）"
                      aria-label="撤销理由"
                      onChange={(e) => setRevokeReason(e.target.value)}
                    />
                    <button
                      className="secondary-action"
                      disabled={!revokeReason.trim() || mutations.grantRevoke.isPending}
                      onClick={() => {
                        setError(null);
                        mutations.grantRevoke.mutate(
                          { id: g.id, reason: revokeReason.trim() },
                          {
                            onSuccess: () => {
                              setRevokeFor(null);
                              setRevokeReason("");
                            },
                            onError: (err) => setError(rootErrorMessage(err)),
                          },
                        );
                      }}
                    >
                      确认撤销
                    </button>
                  </span>
                ) : (
                  <button className="text-action" onClick={() => setRevokeFor(g.id)}>
                    撤销
                  </button>
                )
              ) : (
                <span />
              )}
            </div>
          ))}
        </div>
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** 项目空间·档案页签：十一目录树 + 目录内容（文件/周报）+ 授权管理 */
export default function ArchiveTab() {
  const { projectId } = useSpaceParams();
  const tree = useArchiveTree(projectId);
  const [selectedDir, setSelectedDir] = useState<string | null>(null);

  if (tree.isPending) return <p className="list-note">正在加载档案目录…</p>;
  if (tree.isError) throw tree.error;
  const current = tree.data.find((d) => d.id === selectedDir) ?? tree.data[0];

  return (
    <div className="space-tab-body archive-tab">
      <div className="archive-browser">
        <aside className="folder-tree">
          <div className="section-label">DIRECTORY</div>
          {tree.data.map((d) => (
            <button
              className={current?.id === d.id ? "active" : ""}
              key={d.id}
              onClick={() => setSelectedDir(d.id)}
            >
              {current?.id === d.id ? <FolderOpen size={15} /> : <Folder size={15} />}
              <span>{d.name}</span>
              <small>{d.linkCount}</small>
            </button>
          ))}
        </aside>
        {current ? <DirectoryView dir={current} /> : null}
      </div>
      <GrantPanel />
    </div>
  );
}
