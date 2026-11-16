import { z } from "zod";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as service from "../../modules/forms/forms";

/** 自定义表单域（arch/14 §4；迭代 20 工单 §3）：管理门 sysadmin/partner 在 service 层 */
export const formsRouter = router({
  create: authedMutation
    .input(
      z.object({
        name: z.string().trim().min(1, "表单名称必填").max(200),
        description: z.string().trim().max(2000).optional(),
        icon: z.string().trim().max(50).nullable().optional(),
        groupName: z.string().trim().max(50).optional(),
        visibility: z
          .object({
            mode: z.enum(["all", "roles", "users"]),
            roleKeys: z.array(z.string().min(1).max(50)).optional(),
            userIds: z.array(z.uuid()).optional(),
          })
          .optional(),
        formSchema: z.unknown().optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.createForm(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  updateDraft: authedMutation
    .input(
      z.object({
        id: z.uuid(),
        rowVersion: z.number().int().min(0),
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().max(2000).optional(),
        icon: z.string().trim().max(50).nullable().optional(),
        groupName: z.string().trim().max(50).optional(),
        visibility: z
          .object({
            mode: z.enum(["all", "roles", "users"]),
            roleKeys: z.array(z.string().min(1).max(50)).optional(),
            userIds: z.array(z.uuid()).optional(),
          })
          .optional(),
        formSchema: z.unknown().optional(),
      }),
    )
    .mutation(({ ctx, input }) => service.updateFormDraft(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  publish: authedMutation
    .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => service.publishForm(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  disable: authedMutation
    .input(z.object({ id: z.uuid(), rowVersion: z.number().int().min(0) }))
    .mutation(({ ctx, input }) => service.disableForm(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  delete: authedMutation
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) => service.deleteForm(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  list: authedProcedure.query(({ ctx }) => service.listForms(ctx.db, ctx.user)),
  getById: authedProcedure.input(z.object({ id: z.uuid() })).query(({ ctx, input }) => service.getFormById(ctx.db, ctx.user, input.id)),
  /** 发起入口公开读（登录可读）：按 visibility 过滤 */
  listPublic: authedProcedure.query(({ ctx }) => service.listPublicForms(ctx.db, ctx.user)),
});
