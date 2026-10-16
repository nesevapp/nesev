import { type ComponentType, useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  BellRing,
  Calculator,
  CalendarClock,
  ChevronRight,
  CircleHelp,
  FileText,
  HardDrive,
  Landmark,
  LayoutDashboard,
  LineChart,
  type LucideIcon,
  Package,
  Receipt,
  ReceiptEuro,
  ReceiptText,
  Repeat,
  Settings,
  Users,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { InboxNavBadge } from "@/features/expenses/inbox/inbox-badge";
import { SIDEBAR_OPEN_EVENT, tour } from "@/features/tour/tour-store";
import { cn } from "@/lib/utils";

// Sidebar navigation: the first group is always visible; the titled groups collapse. The group of the current page
// opens on every navigation, the others open/close by hand (remembered per browser, best effort). A closed group
// shows its items' badges on its header. Settings (incl. PDF-Vorlagen and Export) is one entry at the bottom.

interface NavItem {
  to:
    | "/"
    | "/forecast"
    | "/offers"
    | "/invoices"
    | "/credit-notes"
    | "/reminders"
    | "/recurring"
    | "/expenses"
    | "/fixed-costs"
    | "/assets"
    | "/bank"
    | "/tax"
    | "/clients"
    | "/articles";
  label: string;
  icon: LucideIcon;
  /** Count next to the label; renders nothing when there is nothing to show. */
  badge?: ComponentType;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const TOP: NavItem[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/forecast", label: "Zahlungsprognose", icon: LineChart },
];

const GROUPS: NavGroup[] = [
  {
    title: "Belege",
    items: [
      { to: "/offers", label: "Angebote", icon: FileText },
      { to: "/invoices", label: "Rechnungen", icon: Receipt },
      { to: "/credit-notes", label: "Gutschriften", icon: ReceiptText },
      { to: "/reminders", label: "Mahnungen", icon: BellRing },
      { to: "/recurring", label: "Serienrechnungen", icon: Repeat },
    ],
  },
  {
    title: "Finanzen",
    items: [
      { to: "/expenses", label: "Ausgaben", icon: ReceiptEuro, badge: InboxNavBadge },
      { to: "/fixed-costs", label: "Fixkosten", icon: CalendarClock },
      { to: "/assets", label: "Anlagen", icon: HardDrive },
      { to: "/bank", label: "Bank", icon: Landmark },
      { to: "/tax", label: "Steuern", icon: Calculator },
    ],
  },
  {
    title: "Stammdaten",
    items: [
      { to: "/clients", label: "Kunden", icon: Users },
      { to: "/articles", label: "Artikel", icon: Package },
    ],
  },
];

/** Paths shown as "Einstellungen" (the settings area, incl. the template designer). */
const SETTINGS_PATHS = ["/settings", "/templates", "/export"];

const STORAGE_KEY = "nesev.sidebar";

const under = (path: string, to: string) => path === to || path.startsWith(`${to}/`);

function loadOpen(): Record<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function saveOpen(open: Record<string, boolean>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(open));
  } catch {
    // storage unavailable: the open groups just aren't remembered
  }
}

const usePathname = () => useRouterState({ select: (s) => s.location.pathname });

export function SidebarNav() {
  const path = usePathname();
  const activeGroup = GROUPS.find((g) => g.items.some((i) => under(path, i.to)))?.title;
  const [open, setOpen] = useState(loadOpen);

  const update = (title: string, value: boolean) =>
    setOpen((prev) => {
      if (prev[title] === value) return prev;
      const next = { ...prev, [title]: value };
      saveOpen(next);
      return next;
    });

  // every navigation opens the group of the new page
  useEffect(() => {
    if (activeGroup) update(activeGroup, true);
  }, [path, activeGroup]);

  // the guided tour opens the group it points at
  useEffect(() => {
    const onOpen = (e: Event) => update((e as CustomEvent<string>).detail, true);
    window.addEventListener(SIDEBAR_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(SIDEBAR_OPEN_EVENT, onOpen);
  }, []);

  return (
    <nav aria-label="Hauptnavigation" className="flex-1 space-y-4 overflow-y-auto px-3 py-2">
      <ul className="space-y-0.5" data-tour="overview">
        {TOP.map((item) => (
          <NavLink key={item.to} item={item} />
        ))}
      </ul>
      {GROUPS.map((group) => (
        <CollapsibleGroup
          key={group.title}
          group={group}
          open={!!open[group.title]}
          containsActive={group.title === activeGroup}
          onToggle={() => update(group.title, !open[group.title])}
        />
      ))}
    </nav>
  );
}

function CollapsibleGroup({
  group,
  open,
  containsActive,
  onToggle,
}: {
  group: NavGroup;
  open: boolean;
  containsActive: boolean;
  onToggle: () => void;
}) {
  const id = `nav-group-${group.title.toLowerCase()}`;
  const badges = group.items.filter((i) => i.badge);
  return (
    <div data-tour={`group-${group.title}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className={cn(
          "group/header flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
          // closed while it holds the current page: the header stands in for the hidden active item
          !open && containsActive && "text-sidebar-accent-foreground",
        )}
      >
        <span className="flex-1 text-left">{group.title}</span>
        {!open && (
          <span className="flex items-center gap-1 normal-case tracking-normal">
            {badges.map(({ to, badge: Badge }) => Badge && <Badge key={to} />)}
          </span>
        )}
        <ChevronRight
          aria-hidden
          className={cn("size-3.5 opacity-60 transition-transform duration-150 motion-reduce:transition-none", open && "rotate-90")}
          strokeWidth={2}
        />
      </button>
      {/* grid-rows 0fr → 1fr animates the height without measuring; `inert` keeps hidden links out of the tab order */}
      <div
        id={id}
        inert={!open}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-150 ease-out motion-reduce:transition-none",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <ul className="min-h-0 space-y-0.5 overflow-hidden pt-0.5">
          {group.items.map((item) => (
            <NavLink key={item.to} item={item} />
          ))}
        </ul>
      </div>
    </div>
  );
}

const LINK_CLASS =
  "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";
const ACTIVE_CLASS = "bg-sidebar-accent font-medium text-sidebar-accent-foreground";

function NavLink({ item: { to, label, icon: Icon, badge: Badge } }: { item: NavItem }) {
  return (
    <li>
      <Link to={to} activeOptions={{ exact: to === "/" }} className={LINK_CLASS} activeProps={{ className: ACTIVE_CLASS }}>
        <Icon className="size-4 opacity-70" strokeWidth={1.75} />
        {label}
        {Badge && <Badge />}
      </Link>
    </li>
  );
}

/** "Einstellungen" at the bottom of the sidebar; active anywhere in the settings area. */
export function SettingsNavLink() {
  const path = usePathname();
  const active = SETTINGS_PATHS.some((p) => under(path, p));
  return (
    <Link to="/settings" aria-current={active ? "page" : undefined} className={cn(LINK_CLASS, active && ACTIVE_CLASS)}>
      <Settings className="size-4 opacity-70" strokeWidth={1.75} />
      Einstellungen
    </Link>
  );
}

/** Restarts the guided tour; next to "Einstellungen". */
export function TourButton() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={tour.start}
          aria-label="Rundgang starten"
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <CircleHelp className="size-4" strokeWidth={1.75} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">Rundgang durch nesev</TooltipContent>
    </Tooltip>
  );
}
