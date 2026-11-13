import { useEffect, useState } from "react";

import { useMe } from "../../api/auth";
import { useMemberList, useOrgMutations, useUnitTree } from "../../api/org";
import { FormDialog } from "../../components/FormDialog";
import { ListSkeleton } from "../../components/feedback";
import { UserPicker } from "../../components/UserPicker";
import { GLOBAL_ROLE_LABEL } from "../../lib/labels";
import { fieldErrorsOf } from "../../lib/trpc";
import { rootErrorMessage } from "../../lib/form";
import { toast } from "sonner";

type MemberItem = {
  id: string;
  name: string;
  email: string;
  status: string;
  orgUnitId: string | null;
  orgUnitName: string | null;
  position: string | null;
  employeeNo: string | null;
  joinedAt: string | null;
  roles: string[];
  /** 直属主管与汇报链（18-02c：list 返回 managerId/managerName/managerChain） */
  managerId: string | null;
  managerName: string | null;
  managerChain: Array<{ id: string; name: string }>;
};

/** F3 多页签 Dialog：新建/编辑员工（基本/岗位与角色/账号与安全，页签校验红点） */
function MemberDialog({ member, onClose }: { member: MemberItem | null; onClose: () => void }) {
  const tree = useUnitTree();
  const mutations = useOrgMutations();
  const [tab, setTab] = useState(0);
  const [name, setName] = useState(member?.name ?? "");
  const [email, setEmail] = useState("");
  const [employeeNo, setEmployeeNo] = useState(member?.employeeNo ?? "");
  const [joinedAt, setJoinedAt] = useState(member?.joinedAt ?? "");
  const [orgUnitId, setOrgUnitId] = useState(member?.orgUnitId ?? "");
  const [position, setPosition] = useState(member?.position ?? "");
  const [roleKeys, setRoleKeys] = useState<string[]>(member?.roles ?? ["member"]);
  /** 直属主管（arch/13 §3.2：写 org.members.update；18-02c 起 list 带回 managerId 预填，不可成环/本人/停用由服务端 fieldErrors 落位） */
  const [managerId, setManagerId] = useState(member?.managerId ?? "");
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Record<number, boolean>>({});
  const [created, setCreated] = useState<{ email: string; initialPassword: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invalid = (i: number) =>
    (i === 0 && (!name.trim() || (!member && !email.trim()))) ||
    (i === 1 && roleKeys.length === 0);
  const tabs = ["基本信息", "岗位与角色", "账号与安全"];

  const save = () => {
    setError(null);
    setFieldErr({});
    setDirty({ 0: true, 1: true });
    if (invalid(0) || invalid(1)) return;
    if (member) {
      mutations.updateMember.mutate(
        {
          id: member.id,
          name: name.trim(),
          orgUnitId: orgUnitId || null,
          position: position.trim() || undefined,
          employeeNo: employeeNo.trim() || null,
          joinedAt: joinedAt || null,
          roleKeys,
          ...(managerId ? { managerId } : {}),
        },
        {
          onSuccess: () => {
            toast.success("员工信息已更新");
            onClose();
          },
          onError: (err) => {
            const fe = fieldErrorsOf(err);
            const mgr = fe?.managerId?.[0];
            if (mgr) setFieldErr({ managerId: mgr });
            else setError(rootErrorMessage(err));
          },
        },
      );
    } else {
      mutations.createMember.mutate(
        {
          name: name.trim(),
          email: email.trim(),
          orgUnitId: orgUnitId || null,
          position: position.trim() || undefined,
          employeeNo: employeeNo.trim() || null,
          joinedAt: joinedAt || null,
          roleKey: roleKeys[0],
        },
        {
          onSuccess: (r) => {
            setCreated({ email: r.email, initialPassword: (r as { initialPassword: string }).initialPassword });
          },
          onError: (err) => setError(rootErrorMessage(err)),
        },
      );
    }
  };

  if (created) {
    return (
      <FormDialog title="员工已创建" eyebrow="ORG · 初始口令仅展示一次" onClose={onClose}>
        <p className="context-note">
          <strong>{created.email}</strong> 初始口令：<code className="mono"> {created.initialPassword}</code>
        </p>
        <p className="context-note">请立即转交并要求首次登录改密（mustChangePassword 强制）。</p>
        <div className="drawer-actions">
          <button className="primary-action" onClick={onClose}>
            我已保存
          </button>
        </div>
      </FormDialog>
    );
  }

  return (
    <FormDialog title={member ? `编辑员工 · ${member.name}` : "新建员工"} eyebrow="ORG · F3 多页签" onClose={onClose} wide>
      <div className="p9a-wizard-tabs" role="tablist">
        {tabs.map((t, i) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === i}
            className={tab === i ? "active" : ""}
            onClick={() => setTab(i)}
          >
            {t}
            {dirty[i] && invalid(i) ? <i className="p9a-badge-dot" aria-label="该页签有未过校验" /> : null}
          </button>
        ))}
      </div>
      <div className="p9a-wizard-body">
        {tab === 0 ? (
          <>
            <label className="form-field">
              <span>姓名 *</span>
              <input value={name} onChange={(e) => { setName(e.target.value); setDirty((d) => ({ ...d, 0: true })); }} />
              {dirty[0] && !name.trim() ? <em className="ux-err">姓名必填</em> : null}
            </label>
            {member ? null : (
              <label className="form-field">
                <span>邮箱 *</span>
                <input value={email} onChange={(e) => { setEmail(e.target.value); setDirty((d) => ({ ...d, 0: true })); }} placeholder="name@lexflow.demo" />
                {dirty[0] && !email.trim() ? <em className="ux-err">邮箱必填</em> : null}
              </label>
            )}
            <div className="owner-line">
              <label className="form-field">
                <span>工号</span>
                <input value={employeeNo} onChange={(e) => setEmployeeNo(e.target.value)} placeholder="EMP-0001" />
              </label>
              <label className="form-field">
                <span>入职日期</span>
                <input type="date" value={joinedAt ?? ""} onChange={(e) => setJoinedAt(e.target.value)} />
              </label>
            </div>
          </>
        ) : null}
        {tab === 1 ? (
          <>
            <label className="form-field">
              <span>部门</span>
              <select value={orgUnitId} onChange={(e) => setOrgUnitId(e.target.value)}>
                <option value="">未分配</option>
                {(tree.data ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="form-field">
              <span>职位</span>
              <input value={position} onChange={(e) => setPosition(e.target.value)} placeholder="如 资深律师" />
            </label>
            {member ? (
              <div className="form-field">
                <span>直属主管（销售线数据范围/审批解析依据；不可选本人）</span>
                <UserPicker value={managerId} onChange={(v) => { setManagerId(v); setFieldErr({}); }} placeholder="搜索并选择新主管" />
  {fieldErr.managerId ? <em className="ux-err" role="alert">{fieldErr.managerId}</em> : null}
                {member ? (
                  <small className="context-note" style={{ marginTop: 4, display: "block" }}>
                    当前直属主管：{member.managerName ?? "未配置"}
                    {member.managerChain && member.managerChain.length > 0 ? (
                      <> · 汇报链：{member.managerChain.map((m) => m.name).join(" → ")}</>
                    ) : null}
                    ；调整即写入，成环/停用/本人由服务端校验并在此落位。
                  </small>
                ) : null}
              </div>
            ) : null}
            <span className="section-label">角色（多选）</span>
            <div className="org-role-grid">
              {Object.entries(GLOBAL_ROLE_LABEL).map(([key, label]) => (
                <label key={key} className="check-field">
                  <input
                    type="checkbox"
                    checked={roleKeys.includes(key)}
                    onChange={(e) => {
                      setRoleKeys((rs) => (e.target.checked ? [...rs, key] : rs.filter((r) => r !== key)));
                      setDirty((d) => ({ ...d, 1: true }));
                    }}
                  />
                  {label}
                </label>
              ))}
            </div>
            {dirty[1] && roleKeys.length === 0 ? <em className="ux-err">至少选择一个角色</em> : null}
          </>
        ) : null}
        {tab === 2 ? (
          <p className="context-note">
            {member
              ? "账号安全：初始口令生命周期由创建动作下发；自助改密在头像菜单「修改密码」。停用/启用在行尾操作（即时失效全部会话）。"
              : "创建后系统生成一次性初始随机口令并展示一次；新用户首次登录将被强制改密。"}
          </p>
        ) : null}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="drawer-actions">
        <button className="secondary-action" onClick={onClose}>
          取消
        </button>
        <button className="primary-action" disabled={mutations.createMember.isPending || mutations.updateMember.isPending} onClick={save}>
          {member ? "保存" : "创建员工"}
        </button>
      </div>
    </FormDialog>
  );
}

/** 治理→组织管理·员工信息（arch/12 §9：T-A 列表——工号/部门/职位/角色徽标/状态；M5 行尾浮现；F3 新建/编辑；分页条） */
export default function OrgMembersPage() {
  const me = useMe();
  const mutations = useOrgMutations();
  const canEdit = (me.data?.globalRoles ?? []).includes("sysadmin");
  const [keyword, setKeyword] = useState("");
  const [debounced, setDebounced] = useState("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const [dialog, setDialog] = useState<{ open: boolean; member: MemberItem | null }>({ open: false, member: null });
  const [disableTarget, setDisableTarget] = useState<MemberItem | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(keyword.trim()), 300);
    return () => window.clearTimeout(t);
  }, [keyword]);

  const list = useMemberList({ keyword: debounced || undefined, cursor });

  if (list.isPending) return <ListSkeleton rows={6} />;
  if (list.isError) throw list.error;
  const items = (list.data?.items ?? []) as MemberItem[];

  return (
    <div className="screen org-members-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">ORG · MEMBERS</span>
          <h1>员工信息</h1>
          <p>员工名录（users 增岗位列）；新建/编辑走 F3 多页签，行尾动作 hover 浮现（M5）。</p>
        </div>
        {canEdit ? (
          <button className="primary-action" onClick={() => setDialog({ open: true, member: null })}>
            新建员工
          </button>
        ) : null}
      </div>
      <div className="quality-toolbar p9a-ta-filter" style={{ borderBottom: "1px solid var(--line)" }}>
        <input value={keyword} placeholder="搜索姓名/邮箱/工号" aria-label="搜索员工" onChange={(e) => { setKeyword(e.target.value); setCursor(undefined); setCursorStack([]); }} />
      </div>
      <div className="p9a-ta-table" style={{ display: "grid", gridTemplateRows: "40px minmax(0, 1fr)" }}>
        <div className="p9a-ta-head p9a-ta-row" style={{ gridTemplateColumns: "1.2fr 100px 130px 1fr 1.6fr 80px 110px" }}>
          <span>姓名</span><span>工号</span><span>部门</span><span>职位</span><span>角色</span><span>状态</span><span />
        </div>
        <div className="p9a-ta-body">
          {items.map((m) => (
            <div className="p9a-ta-row org-member-row" key={m.id} style={{ gridTemplateColumns: "1.2fr 100px 130px 1fr 1.6fr 80px 110px" }}>
              <div>
                <strong>{m.name}</strong>
                <small className="mono" style={{ color: "var(--muted)" }}>{m.email}</small>
              </div>
              <span className="mono">{m.employeeNo ?? "—"}</span>
              <span>{m.orgUnitName ?? "未分配"}</span>
              <span>{m.position ?? "—"}</span>
              <span>
                {m.roles.slice(0, 3).map((r) => (
                  <span key={r} className="p9a-role-badge" style={{ marginRight: 4 }}>{GLOBAL_ROLE_LABEL[r] ?? r}</span>
                ))}
              </span>
              <span className={m.status === "active" ? "grant-status" : "log-denied"}>{m.status === "active" ? "在职" : "已停用"}</span>
              <span className="p9a-row-actions">
                {canEdit ? (
                  <>
                    <button className="text-action" onClick={() => setDialog({ open: true, member: m })}>
                      编辑
                    </button>
                    <button className="text-action" onClick={() => setDisableTarget(m)}>
                      {m.status === "active" ? "停用" : "启用"}
                    </button>
                  </>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="p9a-ta-pager">
        <span>共 {items.length} 条 · 每页 20</span>
        <div className="row-ops">
          <button className="secondary-action" disabled={cursorStack.length === 0} onClick={() => { const prev = [...cursorStack]; const c = prev.pop(); setCursorStack(prev); setCursor(c); }}>
            上一页
          </button>
          <button
            className="secondary-action"
            disabled={!list.data?.nextCursor}
            onClick={() => {
              if (!list.data?.nextCursor) return;
              setCursorStack((s) => [...s, cursor ?? ""]);
              setCursor(list.data.nextCursor ?? undefined);
            }}
          >
            下一页
          </button>
        </div>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {dialog.open ? <MemberDialog member={dialog.member} onClose={() => setDialog({ open: false, member: null })} /> : null}
      {disableTarget ? (
        <FormDialog
          title={`${disableTarget.status === "active" ? "停用" : "启用"}员工 · ${disableTarget.name}`}
          eyebrow="ORG · 高危确认"
          onClose={() => setDisableTarget(null)}
        >
          <p className="context-note">
            {disableTarget.status === "active" ? "停用后其全部会话立即失效；该操作写入审计。" : "启用后该用户可重新登录。"}
          </p>
          <div className="drawer-actions">
            <button className="secondary-action" onClick={() => setDisableTarget(null)}>
              取消
            </button>
            <button
              className="danger-action"
              disabled={mutations.setMemberStatus.isPending}
              onClick={() => {
                setError(null);
                mutations.setMemberStatus.mutate(
                  { id: disableTarget.id, status: disableTarget.status === "active" ? "disabled" : "active" },
                  {
                    onSuccess: () => {
                      toast.success(disableTarget.status === "active" ? "已停用" : "已启用");
                      setDisableTarget(null);
                    },
                    onError: (err) => {
                      setError(rootErrorMessage(err));
                      setDisableTarget(null);
                    },
                  },
                );
              }}
            >
              确认
            </button>
          </div>
        </FormDialog>
      ) : null}
    </div>
  );
}
