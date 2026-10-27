import { useState } from "react";
import { UserMinus } from "lucide-react";

import { useMemberMutations, useProjectMembers } from "../../api/project";
import { PROJECT_ROLE_LABEL } from "../../lib/labels";
import { rootErrorMessage } from "../../lib/form";
import { useSpaceParams } from "./space-context";

const ROLE_OPTIONS = ["manager", "member", "key_member"];

/** 项目空间·成员权限页签：成员列表/角色调整/移除（服务端 project.manage 强制；无 user.list 契约，新增成员选择器暂停——STATUS 待裁定） */
export default function MembersTab() {
  const { projectId } = useSpaceParams();
  const members = useProjectMembers(projectId);
  const mutations = useMemberMutations();
  const [error, setError] = useState<string | null>(null);

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
      <section className="member-add pending-contract">
        <span className="section-label">ADD MEMBER</span>
        <h2>新增成员</h2>
        <p className="context-note">
          成员新增需要用户目录查询契约（user.list），已在 STATUS「偏差与仲裁」登记待架构裁定；补齐前此入口暂停，避免硬编码或猜测用户标识。
        </p>
      </section>
    </div>
  );
}
