import { Link, Outlet } from "@tanstack/react-router";
import {
  Archive,
  Calculator,
  CalendarClock,
  HardDrive,
  BellRing,
  FileText,
  Landmark,
  LayoutDashboard,
  LayoutTemplate,
  LineChart,
  type LucideIcon,
  Receipt,
  ReceiptEuro,
  ReceiptText,
  Package,
  Repeat,
  Settings,
  Users,
} from "lucide-react";

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
    | "/articles"
    | "/templates"
    | "/export"
    | "/settings";
  label: string;
  icon: LucideIcon;
}

const NAV: { title?: string; items: NavItem[] }[] = [
  {
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard },
      { to: "/forecast", label: "Zahlungsprognose", icon: LineChart },
    ],
  },
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
      { to: "/expenses", label: "Ausgaben", icon: ReceiptEuro },
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
  {
    title: "Konfiguration",
    items: [
      { to: "/templates", label: "PDF-Vorlagen", icon: LayoutTemplate },
      { to: "/export", label: "Export & Backup", icon: Archive },
      { to: "/settings", label: "Einstellungen", icon: Settings },
    ],
  },
];

export function AppShell() {
  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="flex w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="flex h-14 items-center gap-2 px-5">
          <div className="grid size-6 place-items-center rounded-md bg-primary text-[11px] font-semibold text-primary-foreground">
            n
          </div>
          <span className="text-sm font-semibold tracking-tight text-foreground">nesev</span>
        </div>
        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-2">
          {NAV.map((group, i) => (
            <div key={i}>
              {group.title && (
                <div className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">
                  {group.title}
                </div>
              )}
              <ul className="space-y-0.5">
                {group.items.map(({ to, label, icon: Icon }) => (
                  <li key={to}>
                    <Link
                      to={to}
                      activeOptions={{ exact: to === "/" }}
                      className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                      activeProps={{ className: "bg-sidebar-accent font-medium text-sidebar-accent-foreground" }}
                    >
                      <Icon className="size-4 opacity-70" strokeWidth={1.75} />
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
