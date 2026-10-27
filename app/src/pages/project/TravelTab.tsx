import { Link } from "react-router";
import { ChevronRight, MapPin } from "lucide-react";

import { useTravelList } from "../../api/travel";
import { TRAVEL_STATUS_LABEL } from "../../lib/labels";
import { useSpaceParams } from "./space-context";

/** 项目空间·出差页签（迭代 2 接入真实数据） */
export default function TravelTab() {
  const { projectId } = useSpaceParams();
  const travels = useTravelList({ projectId });

  if (travels.isPending) return <p className="list-note">正在加载出差单…</p>;
  if (travels.isError) throw travels.error;

  return (
    <div className="space-tab-body">
      <div className="quality-toolbar">
        <span className="toolbar-hint">关键字段变更须走变更重审；完成 ≠ 费用已批准</span>
        <Link to={`/travel/new?projectId=${projectId}`} className="primary-action">
          新建出差申请
        </Link>
        <Link to={`/travel?projectId=${projectId}`} className="secondary-action">
          出差中心
          <ChevronRight size={14} />
        </Link>
      </div>
      <div className="report-list">
        {travels.data.items.length === 0 ? (
          <div className="empty-state">
            <MapPin size={24} />
            <strong>暂无出差单</strong>
          </div>
        ) : (
          travels.data.items.map((t) => (
            <Link className="report-row travel-row" key={t.id} to={`/travel/${t.id}`}>
              <div>
                <strong>
                  {t.destination} · {t.reason.slice(0, 30)}
                  {t.borrow ? <em className="mark-duesoon">借款</em> : null}
                </strong>
                <small>
                  {t.code} · {t.startOn} ~ {t.endOn}
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
