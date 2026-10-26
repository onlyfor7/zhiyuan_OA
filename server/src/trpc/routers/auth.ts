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
});
