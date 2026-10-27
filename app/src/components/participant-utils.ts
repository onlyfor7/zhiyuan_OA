/** 参与人草稿与 meeting.create/update 入参的互转（ParticipantsEditor 配套） */

export interface ParticipantDraft {
  key: string;
  kind: "user" | "external";
  userId: string;
  externalName: string;
  externalOrg: string;
  role: "required" | "optional";
}

export function emptyParticipant(): ParticipantDraft {
  return {
    key: crypto.randomUUID(),
    kind: "user",
    userId: "",
    externalName: "",
    externalOrg: "",
    role: "required",
  };
}

/** 草稿 → meeting.create/update 的 participants 入参 */
export function toParticipantInput(value: ParticipantDraft[]) {
  return value
    .filter((p) => (p.kind === "user" ? !!p.userId : !!p.externalName.trim()))
    .map((p) =>
      p.kind === "user"
        ? { userId: p.userId, role: p.role }
        : {
            externalName: p.externalName.trim(),
            externalOrg: p.externalOrg.trim() || undefined,
            role: p.role,
          },
    );
}

/** 会议参与人 → 草稿（编辑回填用） */
export function fromMeetingParticipants(
  participants: {
    userId: string | null;
    externalName: string | null;
    externalOrg: string | null;
    role: string;
  }[],
): ParticipantDraft[] {
  return participants.map((p) => ({
    key: crypto.randomUUID(),
    kind: p.userId ? "user" : "external",
    userId: p.userId ?? "",
    externalName: p.externalName ?? "",
    externalOrg: p.externalOrg ?? "",
    role: p.role === "optional" ? "optional" : "required",
  }));
}
