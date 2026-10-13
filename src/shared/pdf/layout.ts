import type { Schema, Template } from "@pdfme/common";

// Page structure of a template, shared by the render pipeline and the Designer outline.
// Everything is designed on page 1. pdfme lays the body out by Y position only: an element that
// grows (items table, expanding text) pushes everything below it down. The order of the schema
// array only decides which element is drawn on top, so "reordering" means changing Y positions.

const EPS = 0.01;
/** Body elements closer than this (mm) to the one above form one section (e.g. totals, rule and gross total). */
const SECTION_GAP = 1.5;

interface BlankBasePdf {
  width: number;
  height: number;
  padding: [number, number, number, number];
  staticSchema?: Schema[];
}

export function isBlankBasePdf(basePdf: unknown): basePdf is BlankBasePdf {
  const b = basePdf as Partial<BlankBasePdf> | null;
  return !!b && typeof b === "object" && typeof b.width === "number" && Array.isArray(b.padding);
}

export type Band = "header" | "body" | "footer";

/** Elements lying completely inside the top or bottom page margin repeat on every page. */
export function bandOf(s: Schema, basePdf: unknown): Band {
  if (!isBlankBasePdf(basePdf)) return "body";
  const [top, , bottom] = basePdf.padding;
  if (s.position.y + s.height <= top + EPS) return "header";
  if (s.position.y >= basePdf.height - bottom - EPS) return "footer";
  return "body";
}

export interface TemplateOutline {
  header: Schema[];
  /** Body elements grouped into vertically separate sections, top to bottom. */
  sections: Schema[][];
  footer: Schema[];
}

const byPosition = (a: Schema, b: Schema) => a.position.y - b.position.y || a.position.x - b.position.x;
const bottomOf = (s: Schema) => s.position.y + s.height;

/** Outline of page 1: header band, body sections in reading order, footer band. */
export function outlineTemplate(template: Template): TemplateOutline {
  const outline: TemplateOutline = { header: [], sections: [], footer: [] };
  let sectionEnd = -Infinity;
  for (const s of [...(template.schemas[0] ?? [])].sort(byPosition)) {
    const band = bandOf(s, template.basePdf);
    if (band !== "body") {
      outline[band].push(s);
      continue;
    }
    // Close elements join the section above. A table always starts its own section (unless overlapping),
    // because its height changes with the content and the gap above it says nothing.
    const current = outline.sections.at(-1);
    const gap = s.position.y - sectionEnd;
    if (current && (gap < -EPS || (gap <= SECTION_GAP + EPS && s.type !== "table"))) {
      current.push(s);
      sectionEnd = Math.max(sectionEnd, bottomOf(s));
    } else {
      outline.sections.push([s]);
      sectionEnd = bottomOf(s);
    }
  }
  return outline;
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Swaps body section `index` with its neighbour above (-1) or below (+1). Each section keeps the spacing above it,
 * so the sections around the pair stay where they are and a moved section never sticks to its new neighbour.
 * Returns the template unchanged if there is no neighbour.
 */
export function moveSection(template: Template, index: number, direction: -1 | 1): Template {
  const { sections } = outlineTemplate(template);
  const other = index + direction;
  if (!sections[index] || !sections[other]) return template;
  const upperIndex = Math.min(index, other);
  const [upper, lower] = [sections[upperIndex]!, sections[upperIndex + 1]!];
  const top = (sec: Schema[]) => Math.min(...sec.map((s) => s.position.y));
  const bottom = (sec: Schema[]) => Math.max(...sec.map(bottomOf));
  const gapBetween = top(lower) - bottom(upper);
  const prev = sections[upperIndex - 1];
  // The topmost section has no spacing of its own: the lower one takes its place, the gap stays in between.
  const [start, gapAboveUpper] = prev ? [bottom(prev), top(upper) - bottom(prev)] : [top(upper), gapBetween];
  const lowerTop = prev ? start + gapBetween : start;
  const upperTop = lowerTop + bottom(lower) - top(lower) + gapAboveUpper;

  const shifts = new Map<Schema, number>();
  for (const s of lower) shifts.set(s, lowerTop - top(lower));
  for (const s of upper) shifts.set(s, upperTop - top(upper));

  const [first = [], ...rest] = template.schemas;
  const moved = first.map((s) => {
    const dy = shifts.get(s);
    return dy ? { ...s, position: { ...s.position, y: round(s.position.y + dy) } } : s;
  });
  return { ...template, schemas: [moved, ...rest] };
}

/** Y for a newly added body element: below the last body section, as long as it fits above the footer. */
export function nextFreeY(template: Template, height: number): number {
  const { sections } = outlineTemplate(template);
  const basePdf = template.basePdf;
  const [top, , bottom] = isBlankBasePdf(basePdf) ? basePdf.padding : [20, 0, 20];
  const pageHeight = isBlankBasePdf(basePdf) ? basePdf.height : 297;
  const last = sections.at(-1);
  const y = last ? Math.max(...last.map(bottomOf)) + 4 : top + 10;
  return round(Math.min(y, pageHeight - bottom - height));
}
