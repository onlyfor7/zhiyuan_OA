import { eq } from "drizzle-orm";
import { z } from "zod";

import { ERROR_CODE, PERMISSION } from "@lexflow/shared";

import { projectMembers, users } from "../../db/schema";
import { BusinessError } from "../../lib/errors";
import { can } from "../../services/access";
import * as reference from "../../modules/governance/reference";
import { authedProcedure, router } from "../trpc";

/** 用户域（arch/02 §4：user.listProjectMembers；§4.1 v1.2：user.list 参照目录） */
export const userRouter = router({
  list: authedProcedure
    .input(
      z
        .object({
          keyword: z.string().trim().max(100).optional(),
          cursor: z.string().max(300).optional(),
          limit: z.number().int().min(1).max(100).default(20),
        })
        .prefault({}),
    )
    .query(({ ctx, input }) => reference.listUsers(ctx.db, ctx.user, input)),

  listProjectMembers: authedProcedure
    .input(z.object({ projectId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      // 需项目可见权；无权限与不存在统一 NOT_FOUND 形态（arch/03 §5）
      const allowed = await can(ctx.db, ctx.user, PERMISSION.PROJECT_READ, {
        type: "project",
        projectId: input.projectId,
      });
      if (!allowed) {
        throw new BusinessError(ERROR_CODE.ACCESS_DENIED_OR_GONE, "项目不存在或无权访问");
      }

      return ctx.db
        .select({
          userId: projectMembers.userId,
          name: users.name,
          projectRole: projectMembers.projectRole,
        })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.userId))
        .where(eq(projectMembers.projectId, input.projectId));
    }),
});
