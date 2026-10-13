import { eq } from "drizzle-orm";
import type { SettingsUpdate } from "../../shared/schemas/settings";
import { DEFAULT_TAX_NOTES } from "../../shared/tax";
import type { SellerSnapshot } from "../../shared/types";
import type { DbOrTx } from "../db/client";
import { type Settings, settings } from "../db/schema";

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

/** Returns the singleton settings row, creating it with defaults on first access. */
export function getSettings(db: DbOrTx): Settings {
  const row = db.select().from(settings).where(eq(settings.id, SETTINGS_ID)).get();
  if (row) return row;
  return db.insert(settings).values(DEFAULTS).returning().get();
}

export function updateSettings(db: DbOrTx, data: Partial<SettingsUpdate> & { logoPath?: string | null }): Settings {
  getSettings(db);
  return db.update(settings).set(data).where(eq(settings.id, SETTINGS_ID)).returning().get();
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
