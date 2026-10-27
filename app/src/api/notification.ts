import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 通知域 hooks（arch/04 §5 notification.*） */

export function useNotifications(unreadOnly: boolean) {
  const trpc = useTRPC();
  return useQuery(trpc.notification.listMine.queryOptions({ limit: 50, unreadOnly }));
}

export function useUnreadCount() {
  const trpc = useTRPC();
  return useQuery(trpc.notification.unreadCount.queryOptions());
}

export function useNotificationMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.notification.pathFilter());
  };
  const markRead = useMutation(trpc.notification.markRead.mutationOptions({ onSuccess: invalidate }));
  const markHandled = useMutation(
    trpc.notification.markHandled.mutationOptions({ onSuccess: invalidate }),
  );
  return { markRead, markHandled };
}
