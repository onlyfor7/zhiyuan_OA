import { useState } from "react";
import { UserMinus, UserPlus } from "lucide-react";

import { useMemberMutations, useProjectMembers } from "../../api/project";
import { PROJECT_ROLE_LABEL } from "../../lib/labels";
import { rootErrorMessage } from "../../lib/form";
import { UserPicker } from "../../components/UserPicker";
import { useSpaceParams } from "./space-context";

const ROLE_OPTIONS = ["manager", "member", "key_member"];

/** 项目空间·成员权限页签：成员列表/角色调整/移除（服务端 project.manage 强制；无 user.list 契约，新增成员选择器暂停——STATUS 待裁定） */
export default function MembersTab() {
  const { projectId } = useSpaceParams();
  const members = useProjectMembers(projectId);
  const mutations = useMemberMutations();
  const [error, setError] = useState<string | null>(null);
  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState("member");
  const existingIds = new Set((members.data ?? []).map((m) => m.userId));

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
                onClick={() => {
                  if (!window.confirm(`确认将 ${m.name} 移出项目？其项目内权限将立即失效。`)) return;
                  setError(null);
                  mutations.remove.mutate(
                    { projectId, userId: m.userId },
                    { onError: (err) => setError(rootErrorMessage(err)) },
                  );
                }}
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
    </div>
  );
}
