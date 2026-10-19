import { eq } from "drizzle-orm";
import type { SettingsUpdate } from "../../shared/schemas/settings";
import { DEFAULT_TAX_NOTES } from "../../shared/tax";
import type { SellerSnapshot } from "../../shared/types";
import type { DbOrTx } from "../db/client";
import { type Settings, settings } from "../db/schema";
import { taxStatusAt } from "./tax-status";

const SETTINGS_ID = 1;

const DEFAULTS = {
  id: SETTINGS_ID,
  country: "AT",
  paymentTermsDays: 14,
  offerValidityDays: 30,
  defaultOfferIntro: "Vielen Dank für Ihre Anfrage. Gerne unterbreiten wir Ihnen folgendes Angebot:",
  defaultOfferClosing: "Wir freuen uns auf Ihre Auftragserteilung.",
  defaultInvoiceIntro: "Vielen Dank für Ihren Auftrag. Wir erlauben uns, folgende Leistungen in Rechnung zu stellen:",
  defaultInvoiceClosing: "Bitte überweisen Sie den Rechnungsbetrag innerhalb der Zahlungsfrist auf das unten angeführte Konto.",
  defaultCreditNoteIntro: "Wir schreiben Ihnen folgende Beträge gut:",
  defaultCreditNoteClosing: "",
  ...DEFAULT_TAX_NOTES,
} satisfies Partial<typeof settings.$inferInsert>;

/**
 * Returns the singleton settings row, creating it with defaults on first access. `smallBusiness` and `vatBasis`
 * are the Steuerstatus valid today (services/tax-status.ts); figures for other dates must use loadTaxStatus().
 */
export function getSettings(db: DbOrTx): Settings {
  const row = db.select().from(settings).where(eq(settings.id, SETTINGS_ID)).get() ?? db.insert(settings).values(DEFAULTS).returning().get();
  return { ...row, ...taxStatusAt(db) };
}

/** Kleinunternehmer and Soll/Ist are not settings fields any more: they are dated (services/tax-status.ts). */
export type SettingsPatch = Partial<Omit<SettingsUpdate, "smallBusiness" | "vatBasis">> & { logoPath?: string | null };

export function updateSettings(db: DbOrTx, data: SettingsPatch): Settings {
  getSettings(db);
  if (Object.keys(data).length) db.update(settings).set(data).where(eq(settings.id, SETTINGS_ID)).run();
  return getSettings(db);
}

/**
 * PUT /api/settings may carry smallBusiness / vatBasis (clients send the GET object back): accepted only when equal
 * to the status valid today. A change → German message pointing to the Steuerstatus list (null = fine).
 */
export function settingsTaxStatusConflict(db: DbOrTx, body: { smallBusiness?: boolean; vatBasis?: "accrual" | "cash" }): string | null {
  const today = taxStatusAt(db);
  const changed = (body.smallBusiness !== undefined && body.smallBusiness !== today.smallBusiness) || (body.vatBasis !== undefined && body.vatBasis !== today.vatBasis);
  return changed
    ? "Kleinunternehmerregelung und Soll-/Istbesteuerung gelten ab einem Datum: bitte unter Einstellungen → Belege → Umsatzsteuer → Steuerstatus einen Eintrag ab dem gewünschten Tag anlegen (oder per POST /api/tax-status)."
    : null;
}

/** Seller data to freeze onto a document at finalize time. */
export function sellerSnapshot(s: Settings): SellerSnapshot {
  return {
    companyName: s.companyName,
    ownerName: s.ownerName,
    street: s.street,
    zip: s.zip,
    city: s.city,
    country: s.country,
    uid: s.uid,
    taxNumber: s.taxNumber,
    companyRegister: s.companyRegister,
    email: s.email,
    phone: s.phone,
    website: s.website,
    iban: s.iban,
    bic: s.bic,
    bankName: s.bankName,
    logoPath: s.logoPath,
  };
}
