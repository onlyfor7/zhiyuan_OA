import { z } from "zod";

import { CONFIDENTIALITY_LEVEL } from "@lexflow/shared";

import { authedMutation, authedProcedure, router } from "../trpc";
import { storageOrphansDryRun, storageOrphansPurge } from "../../modules/admin/storage";
import * as admin from "../../modules/admin/admin";

export const adminRouter = router({
  storageOrphans: authedProcedure
    .input(z.object({}).prefault({}))
    .query(({ ctx }) => storageOrphansDryRun(ctx.db, ctx.user, ctx.ip, ctx.session.id)),

  storageOrphansPurge: authedMutation
    .input(z.object({}).prefault({}))
    .mutation(({ ctx }) => storageOrphansPurge(ctx.db, ctx.user, ctx.ip, ctx.session.id)),

  /* ===== B 域（arch/09 §4：admin.config 门 + 审计，service 内强制） ===== */

  userList: authedProcedure.query(({ ctx }) => admin.userList(ctx.db, ctx.user)),

  createUser: authedMutation
    .input(
      z.object({
        email: z.email("邮箱格式不正确"),
        name: z.string().trim().min(1, "姓名必填").max(100),
        orgUnitId: z.uuid().optional(),
        roleKey: z.string().min(1).max(50),
      }),
    )
    .mutation(({ ctx, input }) => admin.createUser(ctx.db, ctx.user, { ...input, ip: ctx.ip, sessionId: ctx.session.id })),

  disableUser: authedMutation
    .input(z.object({ userId: z.uuid() }))
    .mutation(({ ctx, input }) => admin.setUserStatus(ctx.db, ctx.user, { ...input, status: "disabled", ip: ctx.ip, sessionId: ctx.session.id })),

  enableUser: authedMutation
    .input(z.object({ userId: z.uuid() }))
    .mutation(({ ctx, input }) => admin.setUserStatus(ctx.db, ctx.user, { ...input, status: "active", ip: ctx.ip, sessionId: ctx.session.id })),

  assignRole: authedMutation
    .input(z.object({ userId: z.uuid(), roleKey: z.string().min(1).max(50) }))
    .mutation(({ ctx, input }) => admin.assignRole(ctx.db, ctx.user, { ...input, assign: true, ip: ctx.ip, sessionId: ctx.session.id })),

  unassignRole: authedMutation
    .input(z.object({ userId: z.uuid(), roleKey: z.string().min(1).max(50) }))
    .mutation(({ ctx, input }) => admin.assignRole(ctx.db, ctx.user, { ...input, assign: false, ip: ctx.ip, sessionId: ctx.session.id })),

  createClient: authedMutation
    .input(
      z.object({
        name: z.string().trim().min(1, "客户名必填").max(200),
        confidentialityLevel: z.enum(CONFIDENTIALITY_LEVEL).optional(),
      }),
    )
    .mutation(({ ctx, input }) => admin.createClient(ctx.db, ctx.user, { ...input, ip: ctx.ip, sessionId: ctx.session.id })),

  setClientDisabled: authedMutation
    .input(z.object({ clientId: z.uuid(), disabled: z.boolean() }))
    .mutation(({ ctx, input }) => admin.setClientDisabled(ctx.db, ctx.user, { ...input, ip: ctx.ip, sessionId: ctx.session.id })),

  createMatter: authedMutation
    .input(
      z.object({
        clientId: z.uuid(),
        name: z.string().trim().min(1, "事项名必填").max(200),
        type: z.string().max(50).optional(),
      }),
    )
    .mutation(({ ctx, input }) => admin.createMatter(ctx.db, ctx.user, { ...input, ip: ctx.ip, sessionId: ctx.session.id })),

  setMatterDisabled: authedMutation
    .input(z.object({ matterId: z.uuid(), disabled: z.boolean() }))
    .mutation(({ ctx, input }) => admin.setMatterDisabled(ctx.db, ctx.user, { ...input, ip: ctx.ip, sessionId: ctx.session.id })),

  updateTemplate: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        name: z.string().trim().min(1).max(100).optional(),
        description: z.string().max(500).optional(),
        structureJson: z.record(z.string(), z.unknown()),
      }),
    )
    .mutation(({ ctx, input }) => admin.updateTemplate(ctx.db, ctx.user, { ...input, ip: ctx.ip, sessionId: ctx.session.id })),

  getConfig: authedProcedure
    .input(z.object({ key: z.string().min(1).max(100) }))
    .query(({ ctx, input }) => admin.getConfig(ctx.db, ctx.user, input)),

  setConfig: authedMutation
    .input(z.object({ key: z.string().min(1).max(100), value: z.record(z.string(), z.unknown()) }))
    .mutation(({ ctx, input }) => admin.setConfig(ctx.db, ctx.user, { ...input, ip: ctx.ip, sessionId: ctx.session.id })),
});
