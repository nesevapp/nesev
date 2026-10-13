import { z } from "zod";

/** Units offered in the line-item "Einheit" dropdown until the user customises the list in settings. */
export const DEFAULT_UNITS = ["Std.", "Stk.", "Tag", "Woche", "Monat", "Jahr", "Pauschal", "km"];

export const unitsSchema = z
  .array(z.string().trim().min(1, "Einheit darf nicht leer sein").max(20, "Maximal 20 Zeichen"))
  .max(50, "Maximal 50 Einheiten")
  .refine((units) => new Set(units).size === units.length, "Einheiten müssen eindeutig sein");
