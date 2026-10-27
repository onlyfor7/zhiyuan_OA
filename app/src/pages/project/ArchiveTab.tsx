import { useRef, useState } from "react";
import { Download, Eye, FileText, Folder, FolderOpen, Link2, Upload } from "lucide-react";

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
      const uploaded = await uploadProjectFile(file, projectId, idemKey);
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

function GrantPanel() {
  const grants = useGrantList();
  const mutations = useArchiveMutations();
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
      </div>
      <div className="pending-contract inline-pending">
        <p className="context-note">
          新增授权申请需要用户目录契约（user.list）选择被授权人，已在 STATUS 登记待裁定；补齐前申请入口暂停，撤销与查看不受影响。
        </p>
      </div>
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
                  <strong>{g.granteeId.slice(0, 8)}</strong>
                </span>
              </div>
              <span>
                {g.scopeType} · {g.scopeId.slice(0, 8)}
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
