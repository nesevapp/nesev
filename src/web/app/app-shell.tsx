import { useEffect, useState } from "react";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { Logo } from "@/components/brand/logo";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { ChatFab } from "@/features/chat/chat-fab";
import { ChatPanel } from "@/features/chat/chat-panel";
import { GlobalSearch } from "@/features/search/global-search";
import { Tour } from "@/features/tour/tour";
import { useTourOpen } from "@/features/tour/tour-store";
import { cn } from "@/lib/utils";
import { DocumentTitle } from "./document-title";
import { SettingsNavLink, SidebarNav, TourButton } from "./sidebar-nav";

// From md up the sidebar is a fixed column; below it hides behind a menu button in a slim top bar and opens as a
// sheet from the left. GlobalSearch (which also owns ⌘K, ? and the g/n shortcuts) is mounted exactly once: in the
// sidebar on desktop, in the always-present top bar on small screens, so the shortcuts work with the sheet closed.

const DESKTOP_QUERY = "(min-width: 48rem)";

function useIsDesktop() {
  const [desktop, setDesktop] = useState(() => typeof window === "undefined" || window.matchMedia(DESKTOP_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => setDesktop(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return desktop;
}

function SidebarBody({ search }: { search: boolean }) {
  return (
    <>
      <Link to="/" className="flex h-14 shrink-0 items-center px-5 text-foreground" aria-label="nesev – Dashboard">
        <Logo className="h-[18px]" aria-hidden />
      </Link>
      {search && (
        <div className="shrink-0 px-3 pb-2" data-tour="search">
          <GlobalSearch />
        </div>
      )}
      <SidebarNav />
      {/* outside the scrolling nav: always at the bottom, also in short windows */}
      <div className="flex shrink-0 items-center gap-1 border-t border-sidebar-border px-3 py-3" data-tour="settings">
        <div className="min-w-0 flex-1">
          <SettingsNavLink />
        </div>
        <TourButton />
      </div>
    </>
  );
}

const SIDEBAR_CLASS = "flex flex-col border-sidebar-border bg-sidebar text-sidebar-foreground";

function MobileSidebar() {
  const [open, setOpen] = useState(false);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const tourOpen = useTourOpen();
  // close on navigation, and when the tour starts (its button sits in the sheet; the tour points at the menu button)
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (tourOpen) setOpen(false);
  }, [tourOpen]);

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-sidebar-border bg-sidebar px-2 text-sidebar-foreground">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Menü öffnen"
          aria-expanded={open}
          data-tour="menu"
          className="grid size-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <Menu className="size-5" strokeWidth={1.75} />
        </button>
        <Link to="/" className="flex shrink-0 items-center px-1 text-foreground" aria-label="nesev – Dashboard">
          <Logo className="h-4" aria-hidden />
        </Link>
        <div className="ml-auto w-full max-w-64 min-w-0" data-tour="search">
          <GlobalSearch />
        </div>
      </header>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className={cn(SIDEBAR_CLASS, "w-64 max-w-[85vw] gap-0 p-0")}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Alle Bereiche von nesev</SheetDescription>
          <SidebarBody search={false} />
        </SheetContent>
      </Sheet>
    </>
  );
}

export function AppShell() {
  const desktop = useIsDesktop();
  return (
    <div className="flex h-dvh overflow-hidden">
      <DocumentTitle />
      {desktop && (
        <aside className={cn(SIDEBAR_CLASS, "w-56 shrink-0 border-r")}>
          <SidebarBody search />
        </aside>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {!desktop && <MobileSidebar />}
        {/* `relative`: absolutely positioned descendants (Radix Select/Switch/Checkbox render hidden native inputs with
            position:absolute) must resolve against main, not the viewport; otherwise they stretch the document, the
            window becomes scrollable and the whole shell, sidebar included, scrolls away. */}
        <main className="relative min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <ChatPanel />
      <ChatFab />
      <Tour />
    </div>
  );
}
