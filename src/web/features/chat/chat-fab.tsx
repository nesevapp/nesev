import { useEffect, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd, modKey } from "@/features/search/kbd";
import { cn } from "@/lib/utils";
import { chatStatusQuery } from "@/sdk";
import { chatUi, useChatActivity, useChatUi } from "./chat-store";

// Round button at the bottom right that opens the assistant panel. It sits above the height of the sticky
// save/action bars (BAR), so it never covers "Speichern"; the toaster stacks its toasts above it (app-toaster.tsx).
// Hidden while the panel is open, when the assistant is disabled in the settings and on the full-screen template
// designer, whose side panel reaches the bottom edge (⌘J still works everywhere).

export const FAB_BOTTOM = 64 + 16;
export const FAB_SIZE = 44;
export const FAB_RIGHT = 16;

function useFabVisible(): boolean {
  const { open } = useChatUi();
  const status = useQuery(chatStatusQuery());
  const designer = useRouterState({ select: (s) => /^\/templates\/\d+/.test(s.location.pathname) });
  return !open && !designer && status.data?.enabled === true;
}

// published for the toaster, which renders outside the router
let shown = false;
const shownListeners = new Set<() => void>();

/** Whether the floating button is on screen (the toaster keeps clear of it). */
export function useChatFabShown(): boolean {
  return useSyncExternalStore(
    (l) => {
      shownListeners.add(l);
      return () => shownListeners.delete(l);
    },
    () => shown,
  );
}

export function ChatFab() {
  const visible = useFabVisible();
  useEffect(() => {
    shown = visible;
    for (const l of shownListeners) l();
  }, [visible]);
  const { busy, pending } = useChatActivity();
  const hint = pending ? "wartet auf Bestätigung" : busy ? "antwortet …" : null;
  return (
    // stays mounted while hidden: closing the panel gives the focus back to it
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          hidden={!visible}
          onClick={(e) => chatUi.setOpen(true, e.currentTarget)}
          aria-label={hint ? `Assistent öffnen (${hint})` : "Assistent öffnen"}
          style={{ bottom: FAB_BOTTOM, right: FAB_RIGHT, width: FAB_SIZE, height: FAB_SIZE }}
          className={cn(
            "fixed z-40 grid place-items-center rounded-full bg-primary text-primary-foreground shadow-lg ring-1 ring-foreground/10 transition-[transform,background-color] hover:scale-105 hover:bg-primary/90 focus-visible:ring-4 focus-visible:ring-ring/50 focus-visible:outline-none active:scale-95",
            "animate-in fade-in-0 zoom-in-75 duration-150 motion-reduce:animate-none motion-reduce:transition-none",
          )}
        >
          <Sparkles className="size-5" strokeWidth={1.75} />
          {hint && (
            <span
              aria-hidden
              className={cn(
                "absolute top-0 right-0 size-3 rounded-full ring-2 ring-background",
                pending ? "bg-warning-solid" : "animate-pulse bg-success-solid motion-reduce:animate-none",
              )}
            />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" sideOffset={8} className="flex items-center gap-2">
        <span>Assistent{hint && ` ${hint}`}</span>
        <span className="flex gap-0.5">
          <Kbd className="border-background/20 bg-background/15 text-background">{modKey}</Kbd>
          <Kbd className="border-background/20 bg-background/15 text-background">J</Kbd>
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
