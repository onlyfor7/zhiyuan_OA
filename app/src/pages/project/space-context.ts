import { useParams } from "react-router";

/** 项目空间路由参数（各页签共用） */
export function useSpaceParams(): { projectId: string } {
  const { projectId } = useParams();
  if (!projectId) throw new Error("缺少项目 ID");
  return { projectId };
}
