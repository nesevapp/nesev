import { partialWithoutDefaults, z } from "./zod";
import { TAX_MODES } from "../tax";
import { EINVOICE_FORMATS } from "../einvoice";

const text = (max = 500) => z.string().trim().max(max);

export const CLIENT_TYPES = ["company", "person"] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

export const clientCreateSchema = z.object({
  /** customer number; omit to auto-assign */
  number: z.number().int().positive().optional(),
  type: z.enum(CLIENT_TYPES),
  name: text(200).min(1, "Name ist erforderlich"),
  contactPerson: text(200).default(""),
  street: text().default(""),
  addressExtra: text().default(""),
  zip: text(20).default(""),
  city: text().default(""),
  country: z.string().trim().length(2).toUpperCase().default("AT"),
  uid: text(30).default(""),
  email: z.union([z.literal(""), z.email("Ungültige E-Mail-Adresse")]).default(""),
  phone: text(50).default(""),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().default(null),
  defaultTaxMode: z.enum(TAX_MODES).nullable().default(null),
  /** null = PDF only */
  eInvoiceFormat: z.enum(EINVOICE_FORMATS).nullable().default(null),
  /** Leitweg-ID (XRechnung) / Auftragsreferenz (ebInterface) */
  eInvoiceBuyerReference: text(200).default(""),
  /** our supplier number at the client (ebInterface) */
  eInvoiceSupplierId: text(100).default(""),
  notes: z.string().max(5000).default(""),
});

/** omitted fields stay unchanged */
export const clientUpdateSchema = partialWithoutDefaults(clientCreateSchema);

export type ClientCreate = z.infer<typeof clientCreateSchema>;
export type ClientUpdate = z.infer<typeof clientUpdateSchema>;
export type ClientFormValues = z.input<typeof clientCreateSchema>;

/** Display form of a client number: 12 → "K-0012". */
export function formatClientNumber(n: number): string {
  return `K-${String(n).padStart(4, "0")}`;
}

/** "K-0012", "k12", "0012" or "12" → 12; anything else → null. */
export function parseClientNumber(input: string): number | null {
  const m = /^(?:k-?)?0*(\d{1,9})$/i.exec(input.trim());
  return m ? Number(m[1]) : null;
}

export const CLIENT_ARCHIVED_FILTERS = ["active", "archived", "all"] as const;

export const clientListQuerySchema = z.object({
  /** matches name, contact person, number, email, city */
  q: z.string().trim().max(200).optional(),
  archived: z.enum(CLIENT_ARCHIVED_FILTERS).default("active"),
  /** ISO alpha-2 */
  country: z.string().trim().length(2).toUpperCase().optional(),
});

export const clientPickerQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ClientListQuery = z.input<typeof clientListQuerySchema>;
