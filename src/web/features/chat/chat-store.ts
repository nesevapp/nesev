import { useSyncExternalStore } from "react";

// Panel state shared by the floating button, the ⌘J shortcut and the panel itself: open/closed and the
// selected conversation, persisted per browser in localStorage (best effort).

interface ChatUiState {
  open: boolean;
  conversationId: number | null;
}

const STORAGE_KEY = "nesev.chat";

function load(): ChatUiState {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<ChatUiState> | null;
    return {
      open: raw?.open === true,
      conversationId: typeof raw?.conversationId === "number" ? raw.conversationId : null,
    };
  } catch {
    return { open: false, conversationId: null };
  }
}

let state = load();
const listeners = new Set<() => void>();

function set(patch: Partial<ChatUiState>) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage unavailable: state just isn't remembered
  }
  for (const l of listeners) l();
}

let returnFocus: HTMLElement | null = null;

/** The element to focus when the panel closes; set by openers that hide while the panel is open. */
export const returnFocusTarget = (): HTMLElement | null => returnFocus;

export const chatUi = {
  setOpen: (open: boolean, returnFocusTo?: HTMLElement) => {
    if (open && !state.open) returnFocus = returnFocusTo ?? null;
    set({ open });
  },
  toggle: () => {
    if (!state.open) returnFocus = null;
    set({ open: !state.open });
  },
  select: (conversationId: number | null) => set({ conversationId }),
};

export function useChatUi(): ChatUiState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

// What the (possibly hidden) panel is doing, for the floating button's status dot. Not persisted.

export interface ChatActivity {
  /** A reply is streaming. */
  busy: boolean;
  /** The assistant waits for a confirmation. */
  pending: boolean;
}

let activity: ChatActivity = { busy: false, pending: false };
const activityListeners = new Set<() => void>();

export function setChatActivity(next: ChatActivity) {
  if (next.busy === activity.busy && next.pending === activity.pending) return;
  activity = next;
  for (const l of activityListeners) l();
}

export function useChatActivity(): ChatActivity {
  return useSyncExternalStore(
    (l) => {
      activityListeners.add(l);
      return () => activityListeners.delete(l);
    },
    () => activity,
  );
}
