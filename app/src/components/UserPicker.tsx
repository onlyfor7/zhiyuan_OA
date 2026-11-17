import { useState } from "react";

import { useUserList } from "../api/reference";

/**
 * 用户选择器（user.list 参照端点，arch/02 §4.1 v1.2）：
 * 关键词即时过滤 + 下拉选择，显示姓名/邮箱/部门。
 */
export function UserPicker({
  value,
  onChange,
  placeholder = "搜索姓名、邮箱或部门",
  /** O-20-5-1：initiator_choice scope=users 时限定可选成员 */
  restrictToIds,
}: {
  value: string;
  onChange: (userId: string) => void;
  placeholder?: string;
  restrictToIds?: string[];
}) {
  const [keyword, setKeyword] = useState("");
  const users = useUserList(keyword);
  const items = (users.data?.items ?? []).filter((u) => !restrictToIds || restrictToIds.includes(u.id));
  const selected = items.find((u) => u.id === value) ?? (users.data?.items ?? []).find((u) => u.id === value);

  return (
    <div className="user-picker">
      <div className="inline-search">
        <input
          value={keyword}
          placeholder={placeholder}
          aria-label="搜索用户"
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>
      <select
        value={value}
        aria-label="选择用户"
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{selected ? selected.name : "选择用户"}</option>
        {items
          .filter((u) => u.id !== value)
          .map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} · {u.email}
              {u.orgUnitName ? ` · ${u.orgUnitName}` : ""}
            </option>
          ))}
      </select>
      {users.isPending ? <small className="picker-note">加载中…</small> : null}
    </div>
  );
}
