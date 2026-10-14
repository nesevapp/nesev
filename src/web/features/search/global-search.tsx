import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useState } from "react";
import { CommandPalette } from "./command-palette";
import { Kbd, modKey } from "./kbd";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { useGlobalShortcuts } from "./use-global-shortcuts";

/** Sidebar search button plus the command palette, the shortcut overview and the global shortcuts. */
export function GlobalSearch() {
  const navigate = useNavigate();
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const pending = useGlobalShortcuts({
    toggleSearch: () => {
      setHelpOpen(false);
      setSearchOpen((o) => !o);
    },
    openSearch: () => setSearchOpen(true),
    openHelp: () => setHelpOpen(true),
    navigate: (to) => void navigate({ to }),
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setSearchOpen(true)}
        className="flex w-full items-center gap-2 rounded-md border border-sidebar-border bg-background px-2 py-1.5 text-sm text-muted-foreground shadow-xs transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <Search className="size-4 opacity-70" strokeWidth={1.75} />
        <span className="flex-1 text-left">Suchen …</span>
        <span className="flex gap-0.5">
          <Kbd>{modKey}</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>
      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} onShowShortcuts={() => setHelpOpen(true)} />
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
      {pending && (
        <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex items-center gap-1.5 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-muted-foreground shadow-md">
          <Kbd>{pending}</Kbd>
          {pending === "g" ? "Gehe zu …" : "Neu …"}
          <span className="opacity-70">(? für Übersicht)</span>
        </div>
      )}
    </>
  );
}
