import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 认证域 hooks（arch/02 §4：auth.login / logout / me） */

export function useMe() {
  const trpc = useTRPC();
  return useQuery(trpc.auth.me.queryOptions());
}

export function useLogin() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.auth.login.mutationOptions({
      onSuccess: () => {
        // 登录成功后使旧的（失败的）me 缓存失效，壳层守卫将取到真实会话
        void queryClient.invalidateQueries(trpc.auth.me.pathFilter());
      },
    }),
  );
}

export function useLogout() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.auth.logout.mutationOptions({
      onSuccess: () => {
        // 会话结束：清空全部业务缓存，避免跨账号数据残留（验收场景 4）
        queryClient.clear();
      },
    }),
  );
}

/** 自助改密：成功后全会话失效（含本会话），前端须引导重新登录 */
export function useChangePassword() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(
    trpc.auth.changePassword.mutationOptions({
      onSuccess: () => {
        queryClient.clear();
      },
    }),
  );
}
