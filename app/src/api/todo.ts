import { useQuery } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 统一待办 hooks（arch/04 §5 todo.mine：任务/审批/复核/周报确认/授权 五源并集） */

export function useTodoMine() {
  const trpc = useTRPC();
  return useQuery(trpc.todo.mine.queryOptions({}));
}
