import { authRouter } from "./auth";
import { projectRouter } from "./project";
import { userRouter } from "./user";
import { router } from "../trpc";

/** AppRouter：前端经 `import type { AppRouter } from "@lexflow/server"` 消费推断类型 */
export const appRouter = router({
  auth: authRouter,
  project: projectRouter,
  user: userRouter,
});

export type AppRouter = typeof appRouter;
