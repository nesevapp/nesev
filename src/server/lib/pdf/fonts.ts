import { join } from "node:path";
import type { Font } from "@pdfme/common";
import { FONT_FILES, FONT_REGULAR } from "../../../shared/pdf/plugins";
import { FONTS_DIR } from "../app-files";

/** Bundled fonts (Inter, SIL OFL), also served to the browser at /api/pdf/fonts/<file>. */
export { FONTS_DIR };

let cached: Promise<Font> | null = null;

/** pdfme font map with Inter as fallback font; loaded once per process. */
export function loadPdfFonts(): Promise<Font> {
  cached ??= (async () => {
    const entries = await Promise.all(
      Object.entries(FONT_FILES).map(async ([name, file]) => {
        const data = new Uint8Array(await Bun.file(join(FONTS_DIR, file)).arrayBuffer());
        return [name, { data, fallback: name === FONT_REGULAR, subset: true }] as const;
      }),
    );
    return Object.fromEntries(entries);
  })();
  return cached;
}
