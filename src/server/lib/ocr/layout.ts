import type { OcrObservation } from "./helper";

/**
 * Reassembles OCR observations into reading-order text lines. Vision returns the left and right columns of a
 * receipt ("SUMME EUR" … "17,11") as separate observations; joining those that share a baseline keeps label
 * and amount on one line, which both the rule-based extractor and the model rely on.
 */
export function observationsToText(observations: readonly OcrObservation[]): string {
  const items = observations
    .filter((o) => o.text.trim())
    .map((o) => ({ text: o.text.trim(), x: o.box[0], cy: o.box[1] + o.box[3] / 2, h: o.box[3] }))
    .sort((a, b) => a.cy - b.cy || a.x - b.x);

  const rows: { cy: number; h: number; items: typeof items }[] = [];
  for (const it of items) {
    // same row when the vertical centers are within ~half a line height (tolerates slightly rotated scans)
    const row = rows.find((r) => Math.abs(r.cy - it.cy) < Math.min(r.h, it.h) * 0.6);
    if (row) {
      row.items.push(it);
      row.cy = (row.cy * (row.items.length - 1) + it.cy) / row.items.length;
    } else {
      rows.push({ cy: it.cy, h: it.h, items: [it] });
    }
  }
  return rows
    .sort((a, b) => a.cy - b.cy)
    .map((r) =>
      r.items
        .sort((a, b) => a.x - b.x)
        .map((i) => i.text)
        .join("   "),
    )
    .join("\n");
}

/** Mean OCR confidence (0..1), 0 without observations. */
export function meanConfidence(observations: readonly OcrObservation[]): number {
  if (!observations.length) return 0;
  return observations.reduce((s, o) => s + o.confidence, 0) / observations.length;
}
