import { z } from "zod";

// German validation messages for all shared schemas. Import `z` from here, not from "zod".
z.config(z.locales.de());

export { z };
