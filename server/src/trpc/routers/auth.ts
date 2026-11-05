import { z } from "zod";

import { env } from "../../env";
import { buildMe, login, logout } from "../../modules/auth/service";
import { SESSION_COOKIE } from "../../modules/auth/session";
import { anonMutation, authedProcedure, router } from "../trpc";

/**
 * 认证域（arch/02 §4 冻结契约：auth.login / logout / me）。
 * Set-Cookie 写入 ctx.resHeaders（@hono/trpc-server 只透传 tRPC Response 的头）；
 * HttpOnly + SameSite=Lax + Path=/（arch/00 §4；开发期不要求 Secure）。
 */

function setSessionCookie(resHeaders: Headers, token: string): void {
  resHeaders.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${env.SESSION_TTL_HOURS * 3600}`,
  );
}

function clearSessionCookie(resHeaders: Headers): void {
  resHeaders.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

export const authRouter = router({
  login: anonMutation
    .input(
      z.object({
        email: z.email("邮箱格式不正确"),
        password: z.string().min(1, "请输入密码"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await login(ctx.db, {
        email: input.email,
        password: input.password,
        ip: ctx.ip,
      });
      setSessionCookie(ctx.resHeaders, result.sessionToken);
      // N1（arch/04 §7）：登录成功 resolver 显式回填身份——变更类中间件的审计行
      // 在 next() 之后读取 ctx.user/ctx.session，此处赋值使 auth.login 审计行带 actor 与 session
      ctx.session = { id: result.sessionId, tokenHash: result.tokenHash };
      ctx.user = {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        orgUnitId: null,
        position: result.user.position,
        globalRoles: [],
        projectRoles: new Map(),
      };
      return { user: result.user };
    }),

  logout: anonMutation.mutation(async ({ ctx }) => {
    if (ctx.session) {
      await logout(ctx.db, ctx.session.tokenHash);
    }
    clearSessionCookie(ctx.resHeaders);
    return { ok: true as const };
  }),

  me: authedProcedure.query(async ({ ctx }) => {
    return buildMe(ctx.db, ctx.user);
  }),

  /** 自助改密（arch/09 §4.2）：验旧口令 + 全会话失效 + 审计（service 内强制） */
  changePassword: anonMutation
    .input(
      z.object({
        oldPassword: z.string().min(1, "原口令必填"),
        newPassword: z.string().min(8, "新口令至少 8 位").max(100),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { changePassword } = await import("../../modules/admin/admin");
      return changePassword(ctx.db, ctx.user!, {
        oldPassword: input.oldPassword,
        newPassword: input.newPassword,
        ip: ctx.ip,
        sessionId: ctx.session?.id ?? null,
      });
    }),
});
