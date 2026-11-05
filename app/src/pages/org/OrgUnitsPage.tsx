import { useState } from "react";
import { Building2, Plus } from "lucide-react";

import { useMe } from "../../api/auth";
import { useMemberList, useOrgMutations, useUnitTree } from "../../api/org";
import { FormDialog } from "../../components/FormDialog";
import { DomainIconBlock } from "../../lib/DomainIconBlock";
import { ListSkeleton } from "../../components/feedback";
import { rootErrorMessage } from "../../lib/form";
import { toast } from "sonner";

type UnitNode = {
  id: string;
  name: string;
  parentId: string | null;
  sort: number;
  memberCount: number;
  children: UnitNode[];
  status?: string;
};

/** 治理→组织管理·部门维护（arch/12 §9：T-D 主从——左树新建/改名/停用/拖拽调父级排序＋右详情；操作走 FormDialog） */
export default function OrgUnitsPage() {
  const me = useMe();
  const tree = useUnitTree();
  const mutations = useOrgMutations();
  const canEdit = (me.data?.globalRoles ?? []).includes("sysadmin");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: "create"; parentId: string | null }
    | { kind: "rename"; unit: UnitNode }
    | { kind: "disable"; unit: UnitNode }
    | null
  >(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const flat = new Map<string, UnitNode>();
  const walk = (nodes: UnitNode[]) => nodes.forEach((n) => { flat.set(n.id, n); walk(n.children); });
  if (tree.data) walk(tree.data as UnitNode[]);
  const selected = selectedId ? flat.get(selectedId) ?? null : null;
  const members = useMemberList({ orgUnitId: selected?.id ?? undefined }, !!selected);

  if (tree.isPending) return <ListSkeleton rows={5} />;
  if (tree.isError) throw tree.error;

  const doMove = (id: string, parentId: string | null, sort: number) => {
    setError(null);
    mutations.moveUnit.mutate(
      { id, parentId, sort },
      {
        onSuccess: () => toast.success("部门已移动（父级/排序已落库）"),
        onError: (err) => setError(rootErrorMessage(err)),
      },
    );
  };

  const renderNode = (node: UnitNode, depth: number) => (
    <div key={node.id}>
      <div
        className={`org-tree-row ${selectedId === node.id ? "active" : ""}`}
        style={{ paddingLeft: 10 + depth * 16 }}
        draggable={canEdit}
        onDragStart={() => setDragId(node.id)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (!dragId || dragId === node.id) return;
          doMove(dragId, node.id, node.children.length);
          setDragId(null);
        }}
      >
        <button className="org-tree-label" onClick={() => setSelectedId(node.id)}>
          <DomainIconBlock domain="org" size={22} iconSize={13} />
          <span>{node.name}</span>
          <span className="count-badge neutral">{node.memberCount}</span>
        </button>
        {canEdit ? (
          <span className="org-tree-ops">
            <button className="text-action" onClick={() => { setDialog({ kind: "create", parentId: node.id }); setName(""); }}>
              <Plus size={13} /> 子部门
            </button>
            <button
              className="text-action"
              onClick={() => {
                setDialog({ kind: "rename", unit: node });
                setName(node.name);
              }}
            >
              改名
            </button>
            <button className="text-action" onClick={() => setDialog({ kind: "disable", unit: node })}>
              停用
            </button>
          </span>
        ) : null}
      </div>
      {node.children.map((c) => renderNode(c, depth + 1))}
    </div>
  );

  return (
    <div className="screen org-units-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">ORG · UNITS</span>
          <h1>部门维护</h1>
          <p>T-D 主从：左侧部门树（拖拽到目标节点=调整为其子部门），右侧部门详情与成员。</p>
        </div>
        {canEdit ? (
          <button
            className="primary-action"
            onClick={() => {
              setDialog({ kind: "create", parentId: null });
              setName("");
            }}
          >
            <Building2 size={15} />
            新建一级部门
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="org-td">
        <aside
          className="org-tree"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (!dragId) return;
            doMove(dragId, null, (tree.data as UnitNode[]).length);
            setDragId(null);
          }}
        >
          <span className="section-label">部门树 · 拖到节点=设为子级 · 拖到空白=移到一级</span>
          <div className="org-tree-list">{(tree.data as UnitNode[]).map((n) => renderNode(n, 0))}</div>
          {canEdit ? <p className="context-note">排序：同级按 sort 升序；move 落点同事务写排序（服务端防环）。</p> : <p className="context-note">只读视图（partner 穿透）。</p>}
        </aside>
        <section className="org-detail">
          {selected ? (
            <>
              <div className="section-heading">
                <div>
                  <span className="section-label">DEPARTMENT</span>
                  <h2>{selected.name}</h2>
                </div>
                <span className="count-badge neutral">{selected.memberCount} 名成员</span>
              </div>
              {members.isPending ? (
                <ListSkeleton rows={3} />
              ) : (members.data?.items.length ?? 0) === 0 ? (
                <p className="list-note">该部门暂无成员。</p>
              ) : (
                <div className="report-list">
                  {members.data!.items.map((m) => (
                    <div className="report-row" key={m.id}>
                      <div>
                        <strong>{m.name}</strong>
                        <small>
                          {m.employeeNo ?? "—"} · {m.position ?? "职位未设置"} · {m.email}
                        </small>
                      </div>
                      <span className={m.status === "active" ? "grant-status" : "log-denied"}>{m.status === "active" ? "在职" : "已停用"}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="list-note">选择左侧部门查看成员详情。</p>
          )}
        </section>
      </div>

      {dialog?.kind === "create" ? (
        <FormDialog title={dialog.parentId ? "新建子部门" : "新建一级部门"} eyebrow="ORG · 创建走弹窗" onClose={() => setDialog(null)}>
          <label className="form-field">
            <span>部门名称 *</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <div className="drawer-actions">
            <button className="secondary-action" onClick={() => setDialog(null)}>取消</button>
            <button
              className="primary-action"
              disabled={!name.trim() || mutations.createUnit.isPending}
              onClick={() => {
                setError(null);
                mutations.createUnit.mutate(
                  { name: name.trim(), parentId: dialog.parentId },
                  { onSuccess: () => { toast.success("部门已创建"); setDialog(null); }, onError: (err) => setError(rootErrorMessage(err)) },
                );
              }}
            >
              创建
            </button>
          </div>
        </FormDialog>
      ) : null}
      {dialog?.kind === "rename" ? (
        <FormDialog title={`改名 · ${dialog.unit.name}`} eyebrow="ORG · 走弹窗" onClose={() => setDialog(null)}>
          <label className="form-field">
            <span>新名称 *</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <div className="drawer-actions">
            <button className="secondary-action" onClick={() => setDialog(null)}>取消</button>
            <button
              className="primary-action"
              disabled={!name.trim() || mutations.updateUnit.isPending}
              onClick={() => {
                setError(null);
                mutations.updateUnit.mutate(
                  { id: dialog.unit.id, name: name.trim() },
                  { onSuccess: () => { toast.success("已改名"); setDialog(null); }, onError: (err) => setError(rootErrorMessage(err)) },
                );
              }}
            >
              保存
            </button>
          </div>
        </FormDialog>
      ) : null}
      {dialog?.kind === "disable" ? (
        <FormDialog title={`停用部门 · ${dialog.unit.name}`} eyebrow="ORG · 高危确认" onClose={() => setDialog(null)}>
          <p className="context-note">
            停用后该部门从参照端点消失；有成员或子部门时将被服务端拦截（409）。
          </p>
          <div className="drawer-actions">
            <button className="secondary-action" onClick={() => setDialog(null)}>取消</button>
            <button
              className="danger-action"
              disabled={mutations.disableUnit.isPending}
              onClick={() => {
                setError(null);
                mutations.disableUnit.mutate(
                  { id: dialog.unit.id },
                  { onSuccess: () => { toast.success("部门已停用"); setDialog(null); }, onError: (err) => { setError(rootErrorMessage(err)); setDialog(null); } },
                );
              }}
            >
              确认停用
            </button>
          </div>
        </FormDialog>
      ) : null}
    </div>
  );
}
