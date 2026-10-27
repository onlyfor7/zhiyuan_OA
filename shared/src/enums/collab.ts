/** 迭代 2 会议与出差域枚举（arch/05 §2.1，冻结；会议/纪要/出差状态机在 state-machines.ts） */

export const PARTICIPANT_ROLE = ["required", "optional"] as const;
export type ParticipantRole = (typeof PARTICIPANT_ROLE)[number];

export const ATTENDANCE_STATUS = ["planned", "attended", "absent", "excused"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUS)[number];

/** 行动项：open → converted 不可逆（arch/05 §3） */
export const ACTION_ITEM_STATUS = ["open", "converted"] as const;
export type ActionItemStatus = (typeof ACTION_ITEM_STATUS)[number];

export const SEGMENT_TYPE = ["transport", "accommodation", "client_site", "other"] as const;
export type SegmentType = (typeof SEGMENT_TYPE)[number];

/** 出差事件流（travel_events 只追加，arch/05 §2.1） */
export const TRAVEL_EVENT_ACTION = [
  "create",
  "submit",
  "approve",
  "reject",
  "withdraw",
  "change_submit",
  "change_approved",
  "depart",
  "complete",
  "close",
  "cancel",
] as const;
export type TravelEventAction = (typeof TRAVEL_EVENT_ACTION)[number];
