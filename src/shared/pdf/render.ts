import type { Font, Schema, Template } from "@pdfme/common";
import { generate } from "@pdfme/generator";
import { PDFDocument } from "@pdfme/pdf-lib";
import { PDF_PLUGINS } from "./plugins";
import { bandOf, isBlankBasePdf } from "./layout";
import { PDF_VARIABLES, type PdfInput } from "./variables";

export { isBlankBasePdf } from "./layout";

const VARIABLE_NAMES = new Set(PDF_VARIABLES.map((v) => v.name));

/**
 * Templates are edited with all elements on page 1 (the Designer cannot edit static schemas).
 * Before generating, elements lying completely inside the top or bottom page margin (basePdf.padding)
 * become static schemas, i.e. they repeat on every page (logo, footer, page numbers).
 * pdfme renders static schemas from their `content`, so bound (non read-only) ones get their input value.
 * Non read-only elements that are not bound to a variable (e.g. a text or image added from the palette)
 * render their designed content, like in the Designer, instead of an empty input value.
 */
export function prepareTemplate(template: Template, input: PdfInput = {}): Template {
  const isBound = (s: Schema) => !s.readOnly && (VARIABLE_NAMES.has(s.name) || s.name in input);
  const [first = [], ...rest] = template.schemas;
  const page = first.map((s): Schema => (s.readOnly || isBound(s) ? s : { ...s, readOnly: true }));
  const basePdf = template.basePdf;
  if (!isBlankBasePdf(basePdf)) return { ...template, schemas: [page, ...rest] };

  const inBand = (s: Schema) => bandOf(s, basePdf) !== "body";
  const toStatic = (s: Schema): Schema => (s.readOnly ? s : { ...s, content: input[s.name] ?? "" });
  const staticSchema = [...(basePdf.staticSchema ?? []), ...page.filter(inBand).map(toStatic)];
  return {
    ...template,
    basePdf: { ...basePdf, staticSchema },
    schemas: [page.filter((s) => !inBand(s)), ...rest],
  };
}

export interface RenderPdfOptions {
  template: Template;
  input: PdfInput;
  fonts: Font;
  /** Letterhead PDF: page 1 goes under the first page, page 2 (if any) under all following pages. */
  letterhead?: Uint8Array | ArrayBuffer | null;
  title?: string;
  author?: string;
}

/** Shared render pipeline (server + browser preview): pdfme generate, then optional letterhead underlay. */
export async function renderPdf({ template, input, fonts, letterhead, title = "", author = "" }: RenderPdfOptions) {
  const bytes = await generate({
    template: prepareTemplate(template, input),
    inputs: [input],
    plugins: PDF_PLUGINS,
    options: { font: fonts, lang: "de", title, author, creator: "nesev", producer: "nesev" },
  });
  if (!letterhead) return bytes;
  return applyLetterhead(bytes, letterhead, { title, author });
}

async function applyLetterhead(
  content: Uint8Array,
  letterhead: Uint8Array | ArrayBuffer,
  meta: { title: string; author: string },
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const lhDoc = await PDFDocument.load(letterhead);
  const contentDoc = await PDFDocument.load(content);
  const lhPages = await out.embedPdf(lhDoc, lhDoc.getPageIndices().slice(0, 2));
  const pages = await out.embedPdf(contentDoc, contentDoc.getPageIndices());
  pages.forEach((embedded, i) => {
    const { width, height } = embedded;
    const page = out.addPage([width, height]);
    const lh = lhPages[i === 0 ? 0 : lhPages.length - 1];
    if (lh) page.drawPage(lh, { x: 0, y: 0, width, height });
    page.drawPage(embedded, { x: 0, y: 0, width, height });
  });
  out.setTitle(meta.title);
  out.setAuthor(meta.author);
  out.setCreator("nesev");
  out.setProducer("nesev");
  out.setLanguage("de");
  return out.save();
}
