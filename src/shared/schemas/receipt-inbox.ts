import { z } from "./zod";

/** Belege-Eingang: ids of inbox items (convert / dismiss). */
export const inboxIdsSchema = z.object({ ids: z.array(z.number().int().positive()).min(1).max(100) });
export type InboxIdsInput = z.infer<typeof inboxIdsSchema>;

/** Folder setting; "" turns the inbox folder off. "~" is expanded on the server. */
export const inboxFolderSchema = z.object({ path: z.string().trim().max(1000) });
export type InboxFolderInput = z.infer<typeof inboxFolderSchema>;

export const inboxListQuerySchema = z.object({ status: z.enum(["new", "all"]).optional() });
