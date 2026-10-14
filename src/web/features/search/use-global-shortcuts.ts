import { useEffect, useRef, useState } from "react";
import { type AppPath, CREATE_ACTIONS, PAGES } from "./commands";

// Global keyboard shortcuts:
//   ⌘K / Ctrl+K  toggle the search palette (works everywhere, also while typing)
//   /            open the search palette
//   ?            shortcut overview
//   g <key>      go to a page, n <key> create something (keys in commands.ts)
// Single keys are ignored while typing (input, textarea, select, contenteditable), while a dialog or
// menu is open, with ⌘/Ctrl/Alt held, and when a page handler already handled the key (defaultPrevented).

export type ShortcutPrefix = "g" | "n";

const SEQUENCE_TIMEOUT_MS = 1500;

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])"))
  );
}

// closing Radix overlays stay in the DOM (data-state="closed") until their exit animation ends
const overlayOpen = () =>
  !!document.querySelector(
    ':is([role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]):not([data-state="closed"])',
  );

export interface GlobalShortcutHandlers {
  toggleSearch: () => void;
  openSearch: () => void;
  openHelp: () => void;
  navigate: (to: AppPath) => void;
}

/** Registers the global shortcuts; returns the pending sequence prefix ("g" / "n") for a hint. */
export function useGlobalShortcuts(handlers: GlobalShortcutHandlers): ShortcutPrefix | null {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [pending, setPending] = useState<ShortcutPrefix | null>(null);

  useEffect(() => {
    let prefix: ShortcutPrefix | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reset = () => {
      clearTimeout(timer);
      prefix = null;
      setPending(null);
    };

    const onKey = (e: KeyboardEvent) => {
      const h = handlersRef.current;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        reset();
        h.toggleSearch();
        return;
      }
      if (e.defaultPrevented || e.repeat || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target) || overlayOpen()) {
        reset();
        return;
      }

      if (prefix) {
        const list = prefix === "g" ? PAGES : CREATE_ACTIONS;
        reset();
        const cmd = list.find((c) => c.key === e.key.toLowerCase());
        if (cmd) {
          e.preventDefault();
          h.navigate(cmd.to);
        }
        return;
      }

      if (e.key === "?") {
        e.preventDefault();
        h.openHelp();
      } else if (e.key === "/") {
        // Pages may use "/" themselves (the bank list focuses its own search): let their window
        // listeners run first and only open the palette when nobody handled the key.
        setTimeout(() => {
          if (!e.defaultPrevented) h.openSearch();
        }, 0);
      } else if (!e.shiftKey && (e.key === "g" || e.key === "n")) {
        e.preventDefault();
        prefix = e.key;
        setPending(e.key);
        clearTimeout(timer);
        timer = setTimeout(reset, SEQUENCE_TIMEOUT_MS);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return pending;
}
