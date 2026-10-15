import type { SettingsFormValues } from "@shared/schemas/settings";
import { z } from "@shared/schemas/zod";

// Tabs of the settings page (`/settings?tab=…`). The main settings form spans "unternehmen" and "belege";
// the other tabs hold their own sections with their own save buttons.

export const SETTINGS_TABS = ["unternehmen", "belege", "mahnwesen", "finanzen", "belegerkennung", "assistent", "darstellung"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = {
  unternehmen: "Unternehmen",
  belege: "Belege",
  mahnwesen: "Mahnwesen",
  finanzen: "Finanzen",
  belegerkennung: "Belegerkennung",
  assistent: "Assistent",
  darstellung: "Darstellung",
};

/** Tabs of the settings area that are pages of their own (they keep their URLs: search, shortcuts and the assistant link there). */
export const SETTINGS_LINK_TABS = {
  vorlagen: { label: "PDF-Vorlagen", to: "/templates" },
  export: { label: "Export & Backup", to: "/export" },
} as const;
export type SettingsLinkTab = keyof typeof SETTINGS_LINK_TABS;
export type SettingsAreaTab = SettingsTab | SettingsLinkTab;

export const isLinkTab = (tab: string): tab is SettingsLinkTab => tab in SETTINGS_LINK_TABS;

export const settingsSearch = z.object({ tab: z.enum(SETTINGS_TABS).optional().catch(undefined) });

/** Old section anchors (`/settings#assistent`) → the tab that now holds the section. */
export const HASH_TABS: Record<string, SettingsTab> = {
  einheiten: "belege",
  mahnwesen: "mahnwesen",
  prognose: "finanzen",
  belegerkennung: "belegerkennung",
  assistent: "assistent",
};

/** Tabs whose fields belong to the main settings form (one save bar for both). */
export const FORM_TABS: SettingsTab[] = ["unternehmen", "belege"];

const BELEGE_FIELDS = new Set<keyof SettingsFormValues>([
  "paymentTermsDays",
  "offerValidityDays",
  "smallBusiness",
  "vatBasis",
  "vatPeriod",
  "taxNoteReverseCharge",
  "taxNoteThirdCountry",
  "taxNoteSmallBusiness",
  "defaultOfferIntro",
  "defaultOfferClosing",
  "defaultInvoiceIntro",
  "defaultInvoiceClosing",
  "defaultCreditNoteIntro",
  "defaultCreditNoteClosing",
]);

/** Tab of a main-form field. */
export const fieldTab = (name: string): SettingsTab =>
  BELEGE_FIELDS.has(name as keyof SettingsFormValues) ? "belege" : "unternehmen";

/** Form tabs that contain any of the given field names, in tab order. */
export const tabsOfFields = (names: string[]): SettingsTab[] =>
  FORM_TABS.filter((t) => names.some((n) => fieldTab(n) === t));
