import type { Font, Template } from "@pdfme/common";
import { FONT_FILES, FONT_REGULAR } from "@shared/pdf/plugins";
import { renderPdf } from "@shared/pdf/render";
import type { PdfInput } from "@shared/pdf/variables";
import { fileUrl, pdfFontUrl } from "@/sdk";

let fontsPromise: Promise<Font> | null = null;

/** Same fonts as the server (served from /api/pdf/fonts), loaded once. */
export function loadFonts(): Promise<Font> {
  fontsPromise ??= Promise.all(
    Object.entries(FONT_FILES).map(async ([name, file]) => {
      const res = await fetch(pdfFontUrl(file));
      if (!res.ok) throw new Error(`Schrift ${file} konnte nicht geladen werden`);
      return [name, { data: await res.arrayBuffer(), fallback: name === FONT_REGULAR, subset: true }] as const;
    }),
  )
    .then((entries) => Object.fromEntries(entries))
    .catch((err) => {
      fontsPromise = null;
      throw err;
    });
  return fontsPromise;
}

/** Renders the template with sample data in the browser (same pipeline as the server) and opens it in a new tab. */
export async function openPreview(template: Template, input: PdfInput, basePdfPath: string | null) {
  // Open the tab synchronously so popup blockers allow it, then navigate once the PDF is ready.
  const tab = window.open("", "_blank");
  try {
    const [fonts, letterhead] = await Promise.all([
      loadFonts(),
      basePdfPath ? fetch(fileUrl(basePdfPath)).then((r) => (r.ok ? r.arrayBuffer() : null)) : null,
    ]);
    const bytes = await renderPdf({ template, input, fonts, letterhead, title: input.heading ?? "Vorschau" });
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }));
    if (tab) tab.location.href = url;
    else window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    tab?.close();
    throw err;
  }
}
