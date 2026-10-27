import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ChevronRight, MapPin, Plus } from "lucide-react";

import { useTravelList } from "../api/travel";
import { useRail } from "../components/shell-rail";
import { TRAVEL_STATUS_LABEL } from "../lib/labels";
import type { RouterOutputs } from "../lib/trpc";

type TravelItem = RouterOutputs["travel"]["list"]["items"][number];

function TravelRail() {
  return (
    <aside className="context-rail">
      <div className="context-heading">
        <span className="section-label">TRAVEL</span>
        <h2>出差中心</h2>
      </div>
      <div className="context-section">
        <div className="section-label">TIMELINE</div>
        <h2>行程 — 申请 — 费用</h2>
        <p className="context-note">
          关键字段变更须走变更重审（前后值留痕）；完成 ≠ 费用已批准，预计费用绝不写预算台账（TRV-004）。
        </p>
      </div>
      <div className="assurance">
        <MapPin size={16} />
        <span>借款出差触发项目负责人+财务会签；超阈值两步升级。</span>
      </div>
    </aside>
  );
}

/** 出差中心：列表/筛选（arch/05 §5） */
export default function TravelPage() {
  useRail(TravelRail);
  const [params] = useSearchParams();
  const projectId = params.get("projectId") ?? undefined;
  const [mine, setMine] = useState(true);
  const [status, setStatus] = useState("");
  const list = useTravelList(projectId ? { projectId } : mine ? { mine: true } : {});
  const filtered = list.data?.items.filter((t) => !status || t.status === status);

  if (list.isPending) return <p className="list-note">正在加载出差单…</p>;
  if (list.isError) throw list.error;

  return (
    <div className="screen travel-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">TRAVEL CENTER</span>
          <h1>出差中心</h1>
          <p>{projectId ? "项目内全部出差单" : "我申请与我相关的出差单"}；按申请人/负责人/审批人/财务范围过滤。</p>
        </div>
        <Link to={`/travel/new${projectId ? `?projectId=${projectId}` : ""}`} className="primary-action">
          <Plus size={15} />
          新建出差申请
        </Link>
      </div>
      <div className="quality-toolbar">
        <div className="audit-tabs inline-tabs">
          <button className={mine && !projectId ? "active" : ""} onClick={() => setMine(true)}>
            我的
          </button>
          <button className={!mine || projectId ? "active" : ""} onClick={() => setMine(false)}>
            全部
          </button>
        </div>
        <select value={status} aria-label="出差状态" onChange={(e) => setStatus(e.target.value)}>
          <option value="">全部状态</option>
          <option value="draft">草稿</option>
          <option value="pending_approval">审批中</option>
          <option value="approved">已批准</option>
          <option value="in_progress">出差中</option>
          <option value="completed">已完成</option>
          <option value="rejected">已驳回</option>
          <option value="cancelled">已取消</option>
          <option value="closed">已关闭</option>
        </select>
        <span>{filtered?.length ?? 0} 单</span>
      </div>
      <div className="report-list">
        {filtered?.length === 0 ? (
          <div className="empty-state">
            <MapPin size={24} />
            <strong>没有匹配的出差单</strong>
            <p>调整筛选，或新建出差申请。</p>
          </div>
        ) : (
          filtered?.map((t: TravelItem) => (
            <Link className={`report-row travel-row status-${t.status}`} key={t.id} to={`/travel/${t.id}`}>
              <div>
                <strong>
                  {t.destination} · {t.reason.slice(0, 30)}
                  {t.borrow ? <em className="mark-duesoon">借款</em> : null}
                </strong>
                <small>
                  {t.code} · {t.startOn} ~ {t.endOn}
                  {t.estimatedCostCents != null ? ` · 预计 ${(t.estimatedCostCents / 100).toFixed(2)} 元` : ""}
                </small>
              </div>
              <span className={`badge badge-travel-${t.status}`}>{TRAVEL_STATUS_LABEL[t.status]}</span>
              <span className="text-action">
                查看
                <ChevronRight size={14} />
              </span>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
