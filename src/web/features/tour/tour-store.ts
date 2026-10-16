import { useSyncExternalStore } from "react";

// State of the guided tour: open or not. It starts by itself once per browser (the "seen" flag lives in
// localStorage, best effort) and can be restarted from the sidebar, the command palette and the empty dashboard.

const STORAGE_KEY = "nesev.tour";

let open = false;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (open === next) return;
  open = next;
  for (const l of listeners) l();
}

export const tour = {
  start: () => set(true),
  /** Closes the tour and remembers it as seen. */
  close: () => {
    set(false);
    try {
      localStorage.setItem(STORAGE_KEY, "seen");
    } catch {
      // storage unavailable: the tour may start again on the next visit
    }
  },
};

export function tourSeen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "seen";
  } catch {
    // no storage: don't push the tour on every visit
    return true;
  }
}

export function useTourOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
  );
}

/** Event the sidebar listens for: open the collapsible group with this title. */
export const SIDEBAR_OPEN_EVENT = "nesev:sidebar-open";
