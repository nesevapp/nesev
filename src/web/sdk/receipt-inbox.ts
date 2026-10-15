import { queryOptions, useMutation } from "@tanstack/react-query";
import type { InboxFolderInput } from "@shared/schemas/receipt-inbox";
import { parseResponse, receiptInbox } from "./client";
import { useInvalidate } from "./invalidate";
import { keys } from "./keys";

// Belege-Eingang: receipts picked up from the inbox folder or dropped on the inbox page.

export const receiptInboxApi = {
  list: (status: "new" | "all" = "new") => parseResponse(receiptInbox.index.$get({ query: { status } })),
  count: () => parseResponse(receiptInbox.count.$get()),
  status: () => parseResponse(receiptInbox.status.$get()),
  /** "Jetzt prüfen" */
  scan: () => parseResponse(receiptInbox.scan.$post()),
  setFolder: (json: InboxFolderInput) => parseResponse(receiptInbox.folder.$put({ json })),
  upload: (files: File[]) => parseResponse(receiptInbox.upload.$post({ form: { files } })),
  /** One expense draft per item (the file becomes its receipt). */
  convert: (ids: number[]) => parseResponse(receiptInbox.convert.$post({ json: { ids } })),
  dismiss: (ids: number[]) => parseResponse(receiptInbox.dismiss.$post({ json: { ids } })),
};

export type InboxItem = Awaited<ReturnType<typeof receiptInboxApi.list>>[number];
export type InboxStatus = Awaited<ReturnType<typeof receiptInboxApi.status>>;
export type InboxUploadResult = Awaited<ReturnType<typeof receiptInboxApi.upload>>;
export type InboxFolderSettingInput = InboxFolderInput;

/** Polled: the server picks files up from the folder in the background. */
export const inboxItemsQuery = (status: "new" | "all" = "new") =>
  queryOptions({ queryKey: keys.receiptInbox.list(status), queryFn: () => receiptInboxApi.list(status), refetchInterval: 30_000 });

export const inboxCountQuery = queryOptions({
  queryKey: keys.receiptInbox.count,
  queryFn: () => receiptInboxApi.count(),
  refetchInterval: 60_000,
});

export const inboxStatusQuery = queryOptions({
  queryKey: keys.receiptInbox.status,
  queryFn: () => receiptInboxApi.status(),
  refetchInterval: 60_000,
});

export function useScanInbox() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: () => receiptInboxApi.scan(), onSuccess: () => void invalidate("receiptInbox") });
}

export function useSetInboxFolder() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (json: InboxFolderInput) => receiptInboxApi.setFolder(json),
    onSuccess: () => void invalidate("receiptInboxFolder"),
  });
}

export function useUploadToInbox() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (files: File[]) => receiptInboxApi.upload(files), onSuccess: () => void invalidate("receiptInbox") });
}

export function useConvertInboxItems() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (ids: number[]) => receiptInboxApi.convert(ids),
    onSuccess: () => void invalidate("receiptInboxConvert"),
  });
}

export function useDismissInboxItems() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (ids: number[]) => receiptInboxApi.dismiss(ids), onSuccess: () => void invalidate("receiptInbox") });
}
