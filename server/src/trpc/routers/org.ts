import { z } from "zod";

import { authedMutation, authedProcedure, router } from "../trpc";
import * as service from "../../modules/org/org";

/** 组织管理域（arch/12 §9/§11）：org.manage=sysadmin 写、partner 只读穿透、其余同形 404（服务层门） */
export const orgRouter = router({
  company: router({
    get: authedProcedure.query(({ ctx }) => service.getCompany(ctx.db, ctx.user)),
    update: authedMutation
      .input(
        z.object({
          rowVersion: z.number().int().min(0),
          name: z.string().trim().min(1).max(200).optional(),
          creditCode: z.string().trim().max(50).optional(),
          address: z.string().trim().max(300).optional(),
          phone: z.string().trim().max(50).optional(),
          bankName: z.string().trim().max(100).optional(),
          bankAccount: z.string().trim().max(50).optional(),
        }),
      )
      .mutation(({ ctx, input }) => service.updateCompany(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  }),

  units: router({
    tree: authedProcedure.query(({ ctx }) => service.getUnitTree(ctx.db, ctx.user)),
    create: authedMutation
      .input(
        z.object({
          name: z.string().trim().min(1, "部门名称必填").max(100),
          parentId: z.uuid().nullable().optional(),
          sort: z.number().int().min(0).optional(),
        }),
      )
      .mutation(({ ctx, input }) => service.createUnit(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    update: authedMutation
      .input(
        z.object({
          id: z.uuid(),
          name: z.string().trim().min(1).max(100).optional(),
          sort: z.number().int().min(0).optional(),
        }),
      )
      .mutation(({ ctx, input }) => service.updateUnit(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    disable: authedMutation
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => service.disableUnit(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    move: authedMutation
      .input(
        z.object({
          id: z.uuid(),
          parentId: z.uuid().nullable(),
          sort: z.number().int().min(0),
        }),
      )
      .mutation(({ ctx, input }) => service.moveUnit(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  }),

  members: router({
    list: authedProcedure
      .input(
        z
          .object({
            cursor: z.string().max(300).optional(),
            limit: z.number().int().min(1).max(100).default(20),
            orgUnitId: z.uuid().optional(),
            keyword: z.string().trim().max(100).optional(),
          })
          .prefault({}),
      )
      .query(({ ctx, input }) => service.listMembers(ctx.db, ctx.user, input)),
    create: authedMutation
      .input(
        z.object({
          name: z.string().trim().min(1, "姓名必填").max(100),
          email: z.email("邮箱格式不正确"),
          orgUnitId: z.uuid().nullable().optional(),
          position: z.string().trim().max(100).optional(),
          employeeNo: z.string().trim().max(50).nullable().optional(),
          joinedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "入职日须为 YYYY-MM-DD").nullable().optional(),
          roleKey: z.string().min(1).max(50),
        }),
      )
      .mutation(({ ctx, input }) => service.createMember(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    update: authedMutation
      .input(
        z.object({
          id: z.uuid(),
          name: z.string().trim().min(1).max(100).optional(),
          orgUnitId: z.uuid().nullable().optional(),
          position: z.string().trim().max(100).optional(),
          employeeNo: z.string().trim().max(50).nullable().optional(),
          joinedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "入职日须为 YYYY-MM-DD").nullable().optional(),
          roleKeys: z.array(z.string().min(1).max(50)).optional(),
        }),
      )
      .mutation(({ ctx, input }) => service.updateMember(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
    setStatus: authedMutation
      .input(z.object({ id: z.uuid(), status: z.enum(["active", "disabled"]) }))
      .mutation(({ ctx, input }) => service.setMemberStatus(ctx.db, ctx.user, input, ctx.ip, ctx.session.id)),
  }),
});
