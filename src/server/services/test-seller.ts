import type { DbOrTx } from "../db/client";
import { updateSettings } from "./settings";

/** Complete seller name and address: finalizing refuses to run without them (shared/seller.ts). For tests. */
export const TEST_SELLER = { companyName: "Muster e.U.", street: "Musterstraße 1", zip: "1010", city: "Wien" };

export function seedSeller(db: DbOrTx): void {
  updateSettings(db, TEST_SELLER);
}
