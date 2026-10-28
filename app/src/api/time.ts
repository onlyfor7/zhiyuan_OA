import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import { useTRPC, type RouterInputs } from "../lib/trpc";

/** time_entries 行（myPeriod 包裹结构 {period, entries}） */
export interface TimeEntryRow {
  id: string;
  periodId: string;
  userId: string;
  projectId: string | null;
  taskId: string | null;
  meetingId: string | null;
  travelId: string | null;
  activityType: RouterInputs["time"]["saveEntries"]["entries"][number]["activityType"];
  workDate: string;
  durationMinutes: number;
  description: string | null;
  billable: boolean;
  source: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  rowVersion: number;
}

export interface TimesheetPeriodRow {
  id: string;
  code: string;
  userId: string;
  periodType: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  approverId: string | null;
  submittedAt: string | null;
  approvedAt: string | null;
  returnedNote: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  lockReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  rowVersion: number;
}

export interface MyPeriodOutput {
  period: TimesheetPeriodRow | null;
  entries: TimeEntryRow[];
}

/** 工时域 hooks（arch/07 §6：time.*；saveEntries 覆盖式全量） */

export function useMyPeriod(periodStart?: string) {
  const trpc = useTRPC();
  return useQuery(
    trpc.time.myPeriod.queryOptions({ periodStart: periodStart ?? "" }),
  ) as UseQueryResult<MyPeriodOutput>;
}

export function useValidatePeriod(periodId: string | null, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.time.validate.queryOptions({ periodId: periodId ?? "" }, { enabled: !!periodId && enabled }),
  );
}

export function useTimeMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.time.pathFilter());
    void queryClient.invalidateQueries(trpc.todo.pathFilter());
    void queryClient.invalidateQueries(trpc.notification.pathFilter());
    void queryClient.invalidateQueries(trpc.dashboard.pathFilter());
    void queryClient.invalidateQueries(trpc.report.pathFilter());
    void queryClient.invalidateQueries(trpc.approval.pathFilter());
  };
  const saveEntries = useMutation(trpc.time.saveEntries.mutationOptions({ onSuccess: invalidate }));
  const submit = useMutation(trpc.time.submit.mutationOptions({ onSuccess: invalidate }));
  const withdraw = useMutation(trpc.time.withdraw.mutationOptions({ onSuccess: invalidate }));
  const copyDay = useMutation(trpc.time.copyDay.mutationOptions({ onSuccess: invalidate }));
  const prefillFromMeeting = useMutation(
    trpc.time.prefillFromMeeting.mutationOptions({ onSuccess: invalidate }),
  );
  const prefillFromTravel = useMutation(
    trpc.time.prefillFromTravel.mutationOptions({ onSuccess: invalidate }),
  );
  const lock = useMutation(trpc.time.lock.mutationOptions({ onSuccess: invalidate }));
  const unlock = useMutation(trpc.time.unlock.mutationOptions({ onSuccess: invalidate }));
  return {
    saveEntries,
    submit,
    withdraw,
    copyDay,
    prefillFromMeeting,
    prefillFromTravel,
    lock,
    unlock,
  };
}

type StatsInput = {
  from?: string;
  to?: string;
  statuses?: string[];
  projectId?: string;
};

export function useTimeStatsByUser(input: StatsInput, enabled = true) {
  const trpc = useTRPC();
  return useQuery(trpc.time.stats.byUser.queryOptions(input, { enabled }));
}
export function useTimeStatsByProject(input: StatsInput, enabled = true) {
  const trpc = useTRPC();
  return useQuery(trpc.time.stats.byProject.queryOptions(input, { enabled }));
}
export function useTimeStatsByTask(input: StatsInput, enabled = true) {
  const trpc = useTRPC();
  return useQuery(trpc.time.stats.byTask.queryOptions(input, { enabled }));
}
export function useTimeStatsByActivity(input: StatsInput, enabled = true) {
  const trpc = useTRPC();
  return useQuery(trpc.time.stats.byActivity.queryOptions(input, { enabled }));
}
export function useMyTimeSummary(input: { from?: string; to?: string }) {
  const trpc = useTRPC();
  return useQuery(trpc.time.stats.mySummary.queryOptions(input));
}
export function useTimeExportCsv(input: StatsInput) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return () =>
    queryClient.fetchQuery(
      trpc.time.stats.exportCsv.queryOptions(input),
    );
}

export type TimeEntryInput = RouterInputs["time"]["saveEntries"]["entries"][number];
