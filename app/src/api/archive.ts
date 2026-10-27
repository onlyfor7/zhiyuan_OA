import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useTRPC } from "../lib/trpc";

/** 档案域 hooks（arch/04 §5 archive.*；文件上传走 Hono 原生路由） */

export function useArchiveTree(projectId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.archive.tree.queryOptions({ projectId }));
}

export function useDirectoryItems(directoryId: string | null) {
  const trpc = useTRPC();
  return useQuery(
    trpc.archive.directoryItems.queryOptions(
      { directoryId: directoryId ?? "", limit: 100 },
      { enabled: !!directoryId },
    ),
  );
}

export function useGrantList() {
  const trpc = useTRPC();
  return useQuery(trpc.archive.grantList.queryOptions());
}

export function useArchiveMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries(trpc.archive.pathFilter());
    void queryClient.invalidateQueries(trpc.approval.pathFilter());
    void queryClient.invalidateQueries(trpc.todo.pathFilter());
  };
  const link = useMutation(trpc.archive.link.mutationOptions({ onSuccess: invalidate }));
  const grantApply = useMutation(trpc.archive.grantApply.mutationOptions({ onSuccess: invalidate }));
  const grantRevoke = useMutation(trpc.archive.grantRevoke.mutationOptions({ onSuccess: invalidate }));
  return { link, grantApply, grantRevoke };
}

export interface UploadResult {
  fileVersionId: string;
  fileObjectId: string;
  sha256: string;
  sizeBytes: number;
}

/** 受控上传（Hono 原生 multipart，arch/02 §4 + D2 幂等键） */
export async function uploadProjectFile(
  file: File,
  sourceType: string,
  sourceId: string,
  idempotencyKey: string,
): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", file);
  form.append("sourceType", sourceType);
  form.append("sourceId", sourceId);
  form.append("idempotencyKey", idempotencyKey);
  const res = await fetch("/files/upload", { method: "POST", body: form });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `上传失败（${res.status}）`);
  }
  return (await res.json()) as UploadResult;
}

export function fileDownloadUrl(fileVersionId: string) {
  return `/files/${fileVersionId}/download`;
}

export function filePreviewUrl(fileVersionId: string) {
  return `/files/${fileVersionId}/preview`;
}
