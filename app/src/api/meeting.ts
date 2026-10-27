import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 会议域 hooks（arch/05 §5：meeting.* 与嵌套 meeting.minutes/action/extra） */

export function useMeetingList(input: {
  projectId?: string;
  mine?: boolean;
  status?: "planned" | "completed" | "cancelled";
}) {
  const trpc = useTRPC();
  return useQuery(trpc.meeting.list.queryOptions({ limit: 50, ...input }));
}

export function useMeeting(id: string | null) {
  const trpc = useTRPC();
  return useQuery(trpc.meeting.getById.queryOptions({ id: id ?? "" }, { enabled: !!id }));
}

export function useMeetingMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.meeting.pathFilter());
    void queryClient.invalidateQueries(trpc.todo.pathFilter());
    void queryClient.invalidateQueries(trpc.notification.pathFilter());
    void queryClient.invalidateQueries(trpc.dashboard.pathFilter());
    void queryClient.invalidateQueries(trpc.archive.pathFilter());
  };
  const create = useMutation(trpc.meeting.create.mutationOptions({ onSuccess: invalidate }));
  const update = useMutation(trpc.meeting.update.mutationOptions({ onSuccess: invalidate }));
  const transition = useMutation(trpc.meeting.transition.mutationOptions({ onSuccess: invalidate }));
  const recordAttendance = useMutation(
    trpc.meeting.recordAttendance.mutationOptions({ onSuccess: invalidate }),
  );
  return { create, update, transition, recordAttendance };
}

export function useMinutesVersions(meetingId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.meeting.minutes.versions.queryOptions({ meetingId }));
}

export function useMinutesMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.meeting.pathFilter());
    void queryClient.invalidateQueries(trpc.todo.pathFilter());
    void queryClient.invalidateQueries(trpc.notification.pathFilter());
    void queryClient.invalidateQueries(trpc.archive.pathFilter());
  };
  const saveDraft = useMutation(trpc.meeting.minutes.saveDraft.mutationOptions({ onSuccess: invalidate }));
  const submitConfirm = useMutation(
    trpc.meeting.minutes.submitConfirm.mutationOptions({ onSuccess: invalidate }),
  );
  const confirm = useMutation(trpc.meeting.minutes.confirm.mutationOptions({ onSuccess: invalidate }));
  return { saveDraft, submitConfirm, confirm };
}

export function useActionItems(meetingId: string | null) {
  const trpc = useTRPC();
  return useQuery(
    trpc.meeting.action.list.queryOptions({ meetingId: meetingId ?? "" }, { enabled: !!meetingId }),
  );
}

export function useActionMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.meeting.pathFilter());
    void queryClient.invalidateQueries(trpc.task.pathFilter());
    void queryClient.invalidateQueries(trpc.todo.pathFilter());
  };
  const addItem = useMutation(trpc.meeting.action.addItem.mutationOptions({ onSuccess: invalidate }));
  const convertToTask = useMutation(
    trpc.meeting.action.convertToTask.mutationOptions({ onSuccess: invalidate }),
  );
  return { addItem, convertToTask };
}

/** 分歧转决策（extra.escalateToDecision） */
export function useEscalateToDecision() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.meeting.extra.escalateToDecision.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries(trpc.meeting.pathFilter()),
    }),
  );
}

/** 会议工时预填建议（只算不存；cancelled/none_required 返回 null） */
export function useMeetingTimePrefill(meetingId: string | null, enabled: boolean) {
  const trpc = useTRPC();
  return useQuery(
    trpc.meeting.extra.timePrefillSuggestion.queryOptions(
      { meetingId: meetingId ?? "" },
      { enabled: !!meetingId && enabled },
    ),
  );
}
