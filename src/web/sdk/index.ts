// The frontend's only way to talk to the API. Features import from "@/sdk" (or "@/sdk/<resource>").
// Each resource module exports `<resource>Api` (plain async functions), its response/input types,
// query options and mutation hooks. Query keys live in keys.ts, cross-resource invalidation in invalidate.ts.
export { apiErrorMessage } from "./client";
export { keys } from "./keys";
export { useInvalidate, type Change } from "./invalidate";
export * from "./files";
export * from "./pdf";
export * from "./settings";
export * from "./units";
export * from "./clients";
export * from "./articles";
export * from "./documents";
export * from "./templates";
export * from "./reminders";
export * from "./recurring";
export * from "./forecast";
export * from "./dashboard";
export * from "./export";
export * from "./expenses";
export * from "./receipts";
export * from "./bank";
export * from "./tax";
