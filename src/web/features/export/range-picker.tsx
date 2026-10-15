import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatDate, toIsoDate } from "@shared/dates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ExportRange } from "@/sdk";

type Preset = "month" | "quarter" | "year" | "custom";
const PRESETS: { value: Preset; label: string }[] = [
  { value: "month", label: "Monat" },
  { value: "quarter", label: "Quartal" },
  { value: "year", label: "Jahr" },
  { value: "custom", label: "Benutzerdefiniert" },
];
const STEP_MONTHS: Record<Exclude<Preset, "custom">, number> = { month: 1, quarter: 3, year: 12 };

const monthName = (d: Date, style: "long" | "short" = "long") => d.toLocaleDateString("de-AT", { month: style });

/** Range for a preset around an anchor month. */
function presetRange(preset: Exclude<Preset, "custom">, anchor: Date): ExportRange & { label: string } {
  const y = anchor.getFullYear();
  const m = anchor.getMonth();
  if (preset === "month") {
    return { from: toIsoDate(new Date(y, m, 1)), to: toIsoDate(new Date(y, m + 1, 0)), label: `${monthName(anchor)} ${y}` };
  }
  if (preset === "quarter") {
    const q = Math.floor(m / 3);
    const start = new Date(y, q * 3, 1);
    const end = new Date(y, q * 3 + 3, 0);
    return {
      from: toIsoDate(start),
      to: toIsoDate(end),
      label: `Q${q + 1} ${y} · ${monthName(start, "short")} – ${monthName(end, "short")}`,
    };
  }
  return { from: `${y}-01-01`, to: `${y}-12-31`, label: String(y) };
}

/** Month/quarter/year/custom range selection: returns the range and its controls. */
export function useRangePicker(idPrefix: string, initial: Exclude<Preset, "custom"> = "quarter") {
  const [preset, setPreset] = useState<Preset>(initial);
  const [anchor, setAnchor] = useState(() => new Date());
  const [custom, setCustom] = useState<ExportRange>(() => presetRange("month", new Date()));

  const range: ExportRange & { label?: string } = preset === "custom" ? custom : presetRange(preset, anchor);
  const valid = !!range.from && !!range.to && range.from <= range.to;

  const step = (dir: -1 | 1) => {
    if (preset === "custom") return;
    setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + dir * STEP_MONTHS[preset], 1));
  };

  const controls = (
    <>
      <Tabs value={preset} onValueChange={(v) => setPreset(v as Preset)}>
        <TabsList>
          {PRESETS.map((p) => (
            <TabsTrigger key={p.value} value={p.value}>
              {p.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {preset === "custom" ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`${idPrefix}-from`}>Von</Label>
            <Input
              id={`${idPrefix}-from`}
              type="date"
              className="w-40"
              value={custom.from}
              onChange={(e) => setCustom((r) => ({ ...r, from: e.target.value }))}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${idPrefix}-to`}>Bis</Label>
            <Input
              id={`${idPrefix}-to`}
              type="date"
              className="w-40"
              value={custom.to}
              aria-invalid={!valid}
              onChange={(e) => setCustom((r) => ({ ...r, to: e.target.value }))}
            />
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" className="size-8" onClick={() => step(-1)} aria-label="Zurück">
            <ChevronLeft />
          </Button>
          <div className="min-w-48 text-center text-sm font-medium">{range.label}</div>
          <Button variant="outline" size="icon" className="size-8" onClick={() => step(1)} aria-label="Weiter">
            <ChevronRight />
          </Button>
          <span className="ml-2 text-sm text-muted-foreground tabular">
            {formatDate(range.from)} – {formatDate(range.to)}
          </span>
        </div>
      )}
    </>
  );

  return { range: { from: range.from, to: range.to }, valid, controls };
}
