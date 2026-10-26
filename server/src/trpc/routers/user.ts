import { eq } from "drizzle-orm";
import { z } from "zod";

import { ERROR_CODE, PERMISSION } from "@lexflow/shared";

import { projectMembers, users } from "../../db/schema";
import { BusinessError } from "../../lib/errors";
import { can } from "../../services/access";
import { authedProcedure, router } from "../trpc";

/** 用户域（arch/02 §4 冻结契约：user.listProjectMembers） */
export const userRouter = router({
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
