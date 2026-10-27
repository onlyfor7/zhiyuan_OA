import { useState } from "react";
import { X } from "lucide-react";

import { UserPicker } from "./UserPicker";
import type { ParticipantDraft } from "./participant-utils";
import { emptyParticipant } from "./participant-utils";

/** 参与人编辑器：内部用户（user.list）/外部参与人（最小信息，不建账号）恰一非空 */
export function ParticipantsEditor({
  value,
  onChange,
}: {
  value: ParticipantDraft[];
  onChange: (next: ParticipantDraft[]) => void;
}) {
  const [kindChoice, setKindChoice] = useState<Record<string, "user" | "external">>({});
  const update = (key: string, patch: Partial<ParticipantDraft>) =>
    onChange(value.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  return (
    <div className="participants-editor">
      {value.map((p) => {
        const kind = kindChoice[p.key] ?? p.kind;
        return (
          <div className="participant-row" key={p.key}>
            <div className="role-switch">
              <button
                type="button"
                className={kind === "user" ? "tool-toggle active" : "tool-toggle"}
                onClick={() => {
                  setKindChoice((prev) => ({ ...prev, [p.key]: "user" }));
                  update(p.key, { kind: "user", externalName: "" });
                }}
              >
                内部
              </button>
              <button
                type="button"
                className={kind === "external" ? "tool-toggle active" : "tool-toggle"}
                onClick={() => {
                  setKindChoice((prev) => ({ ...prev, [p.key]: "external" }));
                  update(p.key, { kind: "external", userId: "" });
                }}
              >
                外部
              </button>
            </div>
            {kind === "user" ? (
              <UserPicker
                value={p.userId}
                onChange={(userId) => update(p.key, { userId })}
                placeholder="搜索参会人"
              />
            ) : (
              <div className="external-fields">
                <input
                  value={p.externalName}
                  placeholder="外部参与人姓名 *"
                  aria-label="外部参与人姓名"
                  onChange={(e) => update(p.key, { externalName: e.target.value })}
                />
                <input
                  value={p.externalOrg}
                  placeholder="单位（选填）"
                  aria-label="外部参与人单位"
                  onChange={(e) => update(p.key, { externalOrg: e.target.value })}
                />
              </div>
            )}
            <select
              value={p.role}
              aria-label="参与角色"
              onChange={(e) => update(p.key, { role: e.target.value as "required" | "optional" })}
            >
              <option value="required">必需参加</option>
              <option value="optional">可选参加</option>
            </select>
            <button
              type="button"
              className="icon-button"
              aria-label="删除参与人"
              onClick={() => onChange(value.filter((x) => x.key !== p.key))}
            >
              <X size={15} />
            </button>
          </div>
        );
      })}
      <button type="button" className="secondary-action" onClick={() => onChange([...value, emptyParticipant()])}>
        添加参与人
      </button>
    </div>
  );
}
