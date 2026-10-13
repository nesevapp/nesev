import type { Plugins } from "@pdfme/common";
import { barcodes, ellipse, image, line, list, multiVariableText, rectangle, svg, table, text } from "@pdfme/schemas";

/** pdfme plugins shared by the server generator, the browser preview and the Designer (keys are Designer labels). */
export const PDF_PLUGINS: Plugins = {
  Text: text,
  "Text mit Variablen": multiVariableText,
  Tabelle: table,
  Liste: list,
  Bild: image,
  SVG: svg,
  "QR-Code": barcodes.qrcode,
  Linie: line,
  Rechteck: rectangle,
  Ellipse: ellipse,
};

/** Font names used in templates. Regular is the fallback; the files live in src/server/assets/fonts. */
export const FONT_REGULAR = "Inter";
export const FONT_BOLD = "Inter SemiBold";
export const FONT_FILES = { [FONT_REGULAR]: "Inter-Regular.ttf", [FONT_BOLD]: "Inter-SemiBold.ttf" } as const;
