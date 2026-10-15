import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Page } from "@/components/page";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  isLinkTab,
  SETTINGS_LINK_TABS,
  SETTINGS_TAB_LABELS,
  SETTINGS_TABS,
  type SettingsAreaTab,
  type SettingsLinkTab,
  type SettingsTab,
} from "./settings-tabs";

// The settings area: /settings (tabs via ?tab=) plus /templates and /export, which keep their own routes but show
// the same header and tab bar, so the three feel like one place.

const LINK_TABS = Object.keys(SETTINGS_LINK_TABS) as SettingsLinkTab[];

/** Page frame of the settings area (title, description). */
export function SettingsAreaPage({ children }: { children: ReactNode }) {
  return (
    <Page
      title="Einstellungen"
      description="Unternehmensdaten, Belege, Mahnwesen, Prognose, Belegerkennung, Assistent, PDF-Vorlagen sowie Export & Backup."
    >
      {children}
    </Page>
  );
}

/**
 * Tab bar of the settings area; `children` render below it (inside the Tabs root, so TabsContent works).
 * Settings tabs call `onTabChange` (on /settings) or navigate to /settings?tab=…; the link tabs navigate to their page.
 * Manual activation: arrow keys only move focus, so stepping over a link tab doesn't leave the page.
 */
export function SettingsTabs({
  value,
  onTabChange,
  mark,
  children,
}: {
  value: SettingsAreaTab;
  onTabChange?: (tab: SettingsTab) => void;
  /** Extra content after a tab's label (e.g. an unsaved-changes dot). */
  mark?: (tab: SettingsTab) => ReactNode;
  children?: ReactNode;
}) {
  const navigate = useNavigate();
  const change = (next: string) => {
    if (isLinkTab(next)) void navigate({ to: SETTINGS_LINK_TABS[next].to });
    else if (onTabChange) onTabChange(next as SettingsTab);
    else void navigate({ to: "/settings", search: { tab: next === "unternehmen" ? undefined : (next as SettingsTab) } });
  };
  return (
    <Tabs value={value} onValueChange={change} activationMode="manual" className="gap-6">
      <TabsList variant="line" className="w-full flex-wrap justify-start border-b pb-1 group-data-[orientation=horizontal]/tabs:h-auto">
        {SETTINGS_TABS.map((t) => (
          <TabsTrigger key={t} value={t} className="flex-none px-3">
            {SETTINGS_TAB_LABELS[t]}
            {mark?.(t)}
          </TabsTrigger>
        ))}
        <span aria-hidden className="mx-1 h-4 w-px self-center bg-border" />
        {LINK_TABS.map((t) => (
          <TabsTrigger key={t} value={t} className="flex-none px-3">
            {SETTINGS_LINK_TABS[t].label}
          </TabsTrigger>
        ))}
      </TabsList>
      {children}
    </Tabs>
  );
}
