import { useUserList } from "../../api/reference";

/** CRM 页共用：user.list 参照端点映射 ownerId → 真名（打回①：禁 uuid 截断直渲） */
export function useUserNameMap() {
  const users = useUserList("");
  const items = users.data?.items ?? [];
  return (id: string | null | undefined) => {
    if (!id) return "—";
    return items.find((u) => u.id === id)?.name ?? "—";
  };
}
