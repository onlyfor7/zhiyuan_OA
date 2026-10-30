import { useState } from "react";
import { UserMinus, UserPlus } from "lucide-react";

import { useMe } from "../../api/auth";
import { useMemberMutations, useProjectMembers } from "../../api/project";
import { PROJECT_ROLE_LABEL } from "../../lib/labels";
import { rootErrorMessage } from "../../lib/form";
import { UserPicker } from "../../components/UserPicker";
import { DangerConfirm } from "../../components/FormDialog";
import { toast } from "sonner";
import { useSpaceParams } from "./space-context";

const ROLE_OPTIONS = ["manager", "member", "key_member"];

/** 项目空间·成员权限页签：成员列表/角色调整/移除（服务端 project.manage 强制；无 user.list 契约，新增成员选择器暂停——STATUS 待裁定） */
export default function MembersTab() {
  const { projectId } = useSpaceParams();
  const members = useProjectMembers(projectId);
  const me = useMe();
  const mutations = useMemberMutations();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState("member");
  const [newManagerId, setNewManagerId] = useState("");
  const [transferReason, setTransferReason] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ userId: string; name: string } | null>(null);
  const existingIds = new Set((members.data ?? []).map((m) => m.userId));
  const canTransfer =
    (me.data?.globalRoles ?? []).includes("partner") || (me.data?.globalRoles ?? []).includes("sysadmin");
  const currentManager = (members.data ?? []).find((m) => m.projectRole === "manager");
  const transferCandidates = (members.data ?? []).filter((m) => m.userId !== currentManager?.userId);

  if (members.isPending) return <p className="list-note">正在加载成员…</p>;
  if (members.isError) throw members.error;

  return (
    <div className="space-tab-body">
      <section className="member-panel">
        <div className="section-heading">
          <div>
            <span className="section-label">MEMBERS</span>
            <h2>项目成员（{members.data.length}）</h2>
          </div>
        </div>
        <div className="grant-table">
          <div className="grant-head member-head">
            <span>成员</span>
            <span>项目角色</span>
            <span />
          </div>
          {members.data.map((m) => (
            <div className="grant-row member-row" key={m.userId}>
              <div>
                <span className="mini-avatar">{m.name.slice(0, 1)}</span>
                <span>
                  <strong>{m.name}</strong>
                </span>
              </div>
              <select
                value={m.projectRole}
                aria-label={`${m.name}的项目角色`}
                onChange={(e) => {
                  setError(null);
                  mutations.update.mutate(
                    { projectId, userId: m.userId, projectRole: e.target.value },
                    { onError: (err) => setError(rootErrorMessage(err)) },
                  );
                }}
              >
                {ROLE_OPTIONS.map((role) => (
                  <option key={role} value={role}>
                    {PROJECT_ROLE_LABEL[role] ?? role}
                  </option>
                ))}
              </select>
              <button
                className="icon-button"
                aria-label={`移除${m.name}`}
                onClick={() => setRemoveTarget(m)}
              >
                <UserMinus size={16} />
              </button>
            </div>
          ))}
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
      <section className="member-add">
        <span className="section-label">ADD MEMBER</span>
        <h2>新增成员</h2>
        <div className="member-add-row">
          <UserPicker
            value={addUserId}
            onChange={setAddUserId}
            placeholder="搜索姓名、邮箱或部门"
          />
          <select value={addRole} aria-label="项目角色" onChange={(e) => setAddRole(e.target.value)}>
            {ROLE_OPTIONS.map((role) => (
              <option key={role} value={role}>
                {PROJECT_ROLE_LABEL[role] ?? role}
              </option>
            ))}
          </select>
          <button
            className="primary-action"
            disabled={!addUserId || mutations.add.isPending}
            onClick={() => {
              if (existingIds.has(addUserId)) {
                setError("该用户已是项目成员。");
                return;
              }
              setError(null);
              mutations.add.mutate(
                { projectId, userId: addUserId, projectRole: addRole },
                {
                  onSuccess: () => setAddUserId(""),
                  onError: (err) => setError(rootErrorMessage(err)),
                },
              );
            }}
          >
            <UserPlus size={15} />
            添加
          </button>
        </div>
        <p className="context-note">成员调整后，其项目内权限即时生效；服务端 project.manage 强制校验。</p>
      </section>
      {canTransfer && currentManager ? (
        <section className="member-add transfer-panel">
          <span className="section-label">TRANSFER MANAGER · 高危操作</span>
          <h2>变更负责人</h2>
          <p className="context-note">
            当前负责人：{currentManager.name}。新负责人须为项目成员；变更即时生效、写入审计，双方收到通知（project.transferManager）。
          </p>
          <div className="member-add-row">
            <select value={newManagerId} aria-label="新负责人" onChange={(e) => setNewManagerId(e.target.value)}>
              <option value="">选择新负责人（成员内）</option>
              {transferCandidates.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}（{PROJECT_ROLE_LABEL[m.projectRole] ?? m.projectRole}）
                </option>
              ))}
            </select>
          </div>
          <label className="form-field">
            <span>变更理由 *</span>
            <textarea rows={2} value={transferReason} onChange={(e) => setTransferReason(e.target.value)} />
          </label>
          <button
            className="danger-action"
            disabled={!newManagerId || !transferReason.trim() || mutations.transfer.isPending}
            onClick={() => setConfirmOpen(true)}
          >
            提交变更（需二次确认）
          </button>
        </section>
      ) : null}
      {notice ? (
        <p className="context-note" role="status">
          {notice}
        </p>
      ) : null}
      {removeTarget ? (
        <DangerConfirm
          title={`将 ${removeTarget.name} 移出项目？`}
          consequence={
            <>
              <strong>{removeTarget.name} 的项目内权限将立即失效。</strong>
              <p>该操作写入审计；如需恢复需重新添加成员。删除成员属高危操作，请确认已交接其进行中的任务。</p>
            </>
          }
          confirmLabel="确认移除"
          pending={mutations.remove.isPending}
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => {
            setError(null);
            mutations.remove.mutate(
              { projectId, userId: removeTarget.userId },
              {
                onSuccess: () => {
                  setRemoveTarget(null);
                  setNotice(`已将 ${removeTarget.name} 移出项目。`);
                  toast.success(`已将 ${removeTarget.name} 移出项目`);
                },
                onError: (err) => {
                  setRemoveTarget(null);
                  setError(rootErrorMessage(err));
                },
              },
            );
          }}
        />
      ) : null}
      {confirmOpen ? (
        <div className="overlay centered" onMouseDown={(e) => e.target === e.currentTarget && setConfirmOpen(false)}>
          <section className="decision-modal compact-modal danger-modal" role="dialog" aria-modal="true" aria-label="确认变更负责人">
            <div className="drawer-head">
              <div>
                <span className="section-label">CONFIRM TRANSFER</span>
                <h2>确认变更负责人（高危）</h2>
              </div>
              <button className="icon-button" aria-label="关闭" onClick={() => setConfirmOpen(false)}>
                ×
              </button>
            </div>
            <p className="context-note">
              将把项目负责人从 <strong>{currentManager?.name}</strong> 变更为{" "}
              <strong>{transferCandidates.find((m) => m.userId === newManagerId)?.name ?? "—"}</strong>
              。理由：{transferReason.trim()}。该操作立即生效、写入审计且不可一键撤销。
            </p>
            <div className="row-ops">
              <button className="secondary-action" onClick={() => setConfirmOpen(false)}>
                取消
              </button>
              <button
                className="danger-action"
                disabled={mutations.transfer.isPending}
                onClick={() => {
                  setError(null);
                  mutations.transfer.mutate(
                    { projectId, newManagerId, reason: transferReason.trim() },
                    {
                      onSuccess: () => {
                        setConfirmOpen(false);
                        setNewManagerId("");
                        setTransferReason("");
                        setNotice("负责人变更已生效：原负责人降级为成员，新负责人已接管；双方已收到通知。");
                      },
                      onError: (err) => {
                        setConfirmOpen(false);
                        setError(rootErrorMessage(err));
                      },
                    },
                  );
                }}
              >
                确认变更
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
