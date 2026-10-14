import { useSyncExternalStore } from "react";

// Panel state shared by the sidebar button, the ⌘J shortcut and the panel itself: open/closed and the
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

export const chatUi = {
  setOpen: (open: boolean) => set({ open }),
  toggle: () => set({ open: !state.open }),
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
