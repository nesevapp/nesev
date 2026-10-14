import type { SearchResultType } from "@/sdk";

// Recently opened palette entries (results and pages), per browser. Storage can be unavailable
// (private mode, blocked site data), so every access is guarded and failures just mean "no recents".

const STORAGE_KEY = "nesev.search.recent";
const MAX_RECENT = 8;

export interface RecentEntry {
  /** result type, or "page" / "action" for static commands */
  kind: SearchResultType | "page" | "action";
  /** unique per entry: "invoice:12", "page:bank" */
  id: string;
  label: string;
  sublabel: string;
  path: string;
}

export function loadRecent(): RecentEntry[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as RecentEntry[]).filter((e) => e && typeof e.path === "string").slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function pushRecent(entry: RecentEntry): void {
  try {
    const next = [entry, ...loadRecent().filter((e) => e.id !== entry.id)].slice(0, MAX_RECENT);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore: recents are a convenience
  }
}

export function clearRecent(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
