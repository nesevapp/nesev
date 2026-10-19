// The seller's details every finalized document must carry (§ 11 Abs. 1 Z 1 UStG: name and address of the supplier).
// Finalizing freezes them into the document (sellerSnapshot), so finalize refuses to run without them
// (services/documents.ts, services/reminders.ts); the dashboard's onboarding card uses the same check.

export interface SellerFields {
  companyName: string;
  ownerName: string;
  street: string;
  zip: string;
  city: string;
}

/** German labels of the missing mandatory seller fields (empty = complete). */
export function missingSellerFields(s: SellerFields): string[] {
  const missing: string[] = [];
  if (!s.companyName.trim() && !s.ownerName.trim()) missing.push("Firmenname oder Inhaber:in");
  if (!s.street.trim()) missing.push("Straße");
  if (!s.zip.trim()) missing.push("PLZ");
  if (!s.city.trim()) missing.push("Ort");
  return missing;
}

export const SELLER_MISSING_PREFIX = "Unternehmensdaten fehlen";

export function sellerMissingMessage(missing: string[]): string {
  return `${SELLER_MISSING_PREFIX}: ${missing.join(", ")}. Name und Anschrift müssen auf jedem Beleg stehen (§ 11 UStG) – bitte unter Einstellungen → Unternehmen ergänzen.`;
}
