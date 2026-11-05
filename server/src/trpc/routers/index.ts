import { authRouter } from "./auth";
import { projectRouter } from "./project";
import { userRouter } from "./user";
import { clientRouter } from "./client";
import { matterRouter } from "./matter";
import { planRouter } from "./plan";
import { taskRouter } from "./task";
import { changeRouter } from "./change";
import { qualityRouter } from "./quality";
import { decisionRouter } from "./decision";
import { reportRouter } from "./report";
import { archiveRouter } from "./archive";
import { approvalRouter } from "./approval";
import { notificationRouter } from "./notification";
import { todoRouter } from "./todo";
import { dashboardRouter } from "./dashboard";
import { auditRouter } from "./audit";
import { meetingRouter } from "./meeting";
import { travelRouter } from "./travel";
import { budgetRouter } from "./budget";
import { fundingRouter } from "./funding";
import { expenseRouter } from "./expense";
import { timeRouter } from "./time";
import { searchRouter } from "./search";
import { adminRouter } from "./admin";
import { flowRouter } from "./flow";
import { receiptsRouter } from "./receipts";
import { genericRequestRouter } from "./generic-request";
import { orgRouter } from "./org";
import { crmRouter } from "./crm";
import { router } from "../trpc";

/** AppRouter：前端经 `import type { AppRouter } from "@lexflow/server"` 消费推断类型 */
export const appRouter = router({
  auth: authRouter,
  project: projectRouter,
  user: userRouter,
  client: clientRouter,
  matter: matterRouter,
  plan: planRouter,
  task: taskRouter,
  change: changeRouter,
  quality: qualityRouter,
  decision: decisionRouter,
  report: reportRouter,
  archive: archiveRouter,
  approval: approvalRouter,
  notification: notificationRouter,
  todo: todoRouter,
  dashboard: dashboardRouter,
  audit: auditRouter,
  meeting: meetingRouter,
  travel: travelRouter,
  budget: budgetRouter,
  funding: fundingRouter,
  expense: expenseRouter,
  time: timeRouter,
  search: searchRouter,
  admin: adminRouter,
  flow: flowRouter,
  receipts: receiptsRouter,
  genericRequest: genericRequestRouter,
  org: orgRouter,
  crm: crmRouter,
});

export type AppRouter = typeof appRouter;
