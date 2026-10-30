export type Persona = "sysadmin" | "partner" | "member";

export const PERSONA_LABEL: Record<Persona, string> = { sysadmin: "系统管理员", partner: "合伙人", member: "项目成员" };
