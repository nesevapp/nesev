import { Link, Outlet } from "@tanstack/react-router";
import { Logo } from "@/components/brand/logo";
import { ChatFab } from "@/features/chat/chat-fab";
import { ChatPanel } from "@/features/chat/chat-panel";
import { GlobalSearch } from "@/features/search/global-search";
import { SettingsNavLink, SidebarNav } from "./sidebar-nav";

export function AppShell() {
  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <Link to="/" className="flex h-14 shrink-0 items-center px-5 text-foreground" aria-label="nesev – Dashboard">
          <Logo className="h-[18px]" aria-hidden />
        </Link>
        <div className="shrink-0 px-3 pb-2">
          <GlobalSearch />
        </div>
        <SidebarNav />
        {/* outside the scrolling nav: always at the bottom, also in short windows */}
        <div className="shrink-0 border-t border-sidebar-border px-3 py-3">
          <SettingsNavLink />
        </div>
      </aside>
      {/* `relative`: absolutely positioned descendants (Radix Select/Switch/Checkbox render hidden native inputs with
          position:absolute) must resolve against main, not the viewport; otherwise they stretch the document, the
          window becomes scrollable and the whole shell, sidebar included, scrolls away. */}
      <main className="relative flex-1 overflow-y-auto">
        <Outlet />
      </main>
      <ChatPanel />
      <ChatFab />
    </div>
  );
}
