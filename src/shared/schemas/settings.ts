import { z } from "./zod";

const text = (max = 500) => z.string().trim().max(max);
const longText = () => z.string().max(5000);

/** Editable settings fields (PUT /api/settings body, settings form values). */
export const settingsUpdateSchema = z.object({
  companyName: text(200),
  ownerName: text(200),
  street: text(),
  zip: text(20),
  city: text(),
  country: z.string().trim().length(2).toUpperCase(),
  uid: text(30),
  taxNumber: text(50),
  companyRegister: text(100),
  email: z.union([z.literal(""), z.email("Ungültige E-Mail-Adresse")]),
  phone: text(50),
  website: text(200),
  iban: text(40).transform((v) => v.replace(/\s+/g, "").toUpperCase()),
  bic: text(15).transform((v) => v.toUpperCase()),
  bankName: text(200),
  paymentTermsDays: z.number().int().min(0).max(365),
  offerValidityDays: z.number().int().min(0).max(365),
  defaultOfferIntro: longText(),
  defaultOfferClosing: longText(),
  defaultInvoiceIntro: longText(),
  defaultInvoiceClosing: longText(),
  defaultCreditNoteIntro: longText(),
  defaultCreditNoteClosing: longText(),
  taxNoteReverseCharge: longText(),
  taxNoteThirdCountry: longText(),
  taxNoteSmallBusiness: longText(),
  vatPeriod: z.enum(["monthly", "quarterly"]),
  /** payment QR code (EPC/GiroCode) on invoices */
  paymentQr: z.boolean().default(true),
  /** receipt inbox folder (absolute path); "" = off. Omitted = unchanged: the settings form doesn't carry it, the
   *  Belege-Eingang block saves it via PUT /api/receipt-inbox/folder (validated). */
  receiptInboxPath: text(1000).optional(),
  /** Read-only here: Kleinunternehmer and Soll/Ist are dated (PUT/POST /api/tax-status). Accepted only when equal to
   *  the status valid today, so clients that send the whole GET /api/settings object back keep working. */
  smallBusiness: z.boolean().optional(),
  vatBasis: z.enum(["accrual", "cash"]).optional(),
});

export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;
export type SettingsFormValues = z.input<typeof settingsUpdateSchema>;
