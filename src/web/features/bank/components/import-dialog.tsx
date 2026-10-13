import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronRight, FileUp } from "lucide-react";
import { toast } from "sonner";
import { CSV_DATE_FORMATS, CSV_DELIMITERS, CSV_ENCODINGS, type CsvMapping } from "@shared/bank";
import { formatDate } from "@shared/dates";
import { formatCents } from "@shared/money";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  apiErrorMessage,
  type BankAccount,
  type BankImportPreview,
  csvPresetsQuery,
  useCommitBankImport,
  usePreviewBankImport,
  useUndoBankImport,
} from "@/sdk";
import { Amount } from "../format";

const FORMAT_LABELS: Record<string, string> = {
  camt053: "camt.053 (ISO 20022)",
  csv: "CSV",
  "george-json": "George JSON",
};

const DELIMITER_LABELS: Record<(typeof CSV_DELIMITERS)[number], string> = {
  ";": "Semikolon ;",
  ",": "Komma ,",
  "\t": "Tabulator",
  "|": "Senkrechter Strich |",
};
const ENCODING_LABELS: Record<(typeof CSV_ENCODINGS)[number], string> = {
  "utf-8": "UTF-8",
  "windows-1252": "Windows-1252 (ANSI)",
  "utf-16le": "UTF-16",
};

const STATUS: Record<BankImportPreview["rows"][number]["status"], { label: string; className: string }> = {
  new: { label: "Neu", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  duplicate: { label: "Bereits importiert", className: "border-border text-muted-foreground" },
  foreign_currency: { label: "Fremdwährung", className: "border-amber-200 bg-amber-50 text-amber-700" },
  zero: { label: "Betrag 0", className: "border-border text-muted-foreground" },
};

const PREVIEW_LIMIT = 100;

/**
 * Upload → preview (format detection, duplicates, CSV column mapping) → import.
 * The file stays in the browser; every mapping change re-runs the server-side preview.
 */
export function ImportDialog({
  file,
  account,
  onClose,
}: {
  file: File | null;
  account: BankAccount | undefined;
  onClose: () => void;
}) {
  const previewMut = usePreviewBankImport();
  const commit = useCommitBankImport();
  const undo = useUndoBankImport();
  const [preview, setPreview] = useState<BankImportPreview | null>(null);
  const [mapping, setMapping] = useState<CsvMapping | null>(null);
  const [mappingOpen, setMappingOpen] = useState(false);
  const run = useRef(0);

  const load = (opts: { mapping?: CsvMapping | null; preset?: string | null }) => {
    if (!file || !account) return;
    const id = ++run.current;
    previewMut.mutate(
      { accountId: account.id, file, ...opts },
      {
        onSuccess: (p) => {
          if (id !== run.current) return;
          setPreview(p);
          setMapping(p.csv?.mapping ?? null);
        },
        onError: (err) => {
          if (id !== run.current) return;
          toast.error(apiErrorMessage(err));
          if (!preview) onClose();
        },
      },
    );
  };

  // new file → fresh preview with auto-detection
  useEffect(() => {
    setPreview(null);
    setMapping(null);
    setMappingOpen(false);
    load({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, account?.id]);

  // mapping edits → debounced re-preview
  const editTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const editMapping = (patch: Partial<CsvMapping>) => {
    if (!mapping) return;
    const next = { ...mapping, ...patch };
    setMapping(next);
    clearTimeout(editTimer.current);
    editTimer.current = setTimeout(() => load({ mapping: next }), 250);
  };

  const submit = () => {
    if (!file || !account) return;
    commit.mutate(
      { accountId: account.id, file, mapping: preview?.csv ? mapping : null },
      {
        onSuccess: (r) => {
          onClose();
          if (r.importedCount === 0) {
            toast.info("Keine neuen Buchungen – alles bereits importiert.");
            return;
          }
          const parts = [`${r.importedCount} ${r.importedCount === 1 ? "Buchung" : "Buchungen"} importiert`];
          if (r.autoMatched) parts.push(`${r.autoMatched} automatisch zugeordnet`);
          if (r.skippedCount) parts.push(`${r.skippedCount} übersprungen`);
          toast.success(parts.join(" · "), {
            duration: 10_000,
            action: r.import
              ? {
                  label: "Rückgängig",
                  onClick: () =>
                    undo.mutate(r.import!.id, {
                      onSuccess: (u) =>
                        toast.success(
                          u.kept ? `${u.deleted} entfernt, ${u.kept} zugeordnete behalten` : `Import rückgängig gemacht (${u.deleted})`,
                        ),
                      onError: (err) => toast.error(apiErrorMessage(err)),
                    }),
                }
              : undefined,
          });
        },
        onError: (err) => toast.error(apiErrorMessage(err)),
      },
    );
  };

  const p = preview;
  const loading = previewMut.isPending;

  return (
    <Dialog open={!!file} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUp className="size-4 text-muted-foreground" />
            Kontoauszug importieren
          </DialogTitle>
          <DialogDescription>
            {file?.name}
            {account && <> → {account.name}</>}
            {p && (
              <>
                {" · "}
                {FORMAT_LABELS[p.format] ?? p.format}
                {p.periodFrom && (
                  <span className="tabular">
                    {" · "}
                    {formatDate(p.periodFrom)} – {formatDate(p.periodTo)}
                  </span>
                )}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-6 overflow-y-auto px-6">
          {!p ? (
            <div className="py-16 text-center text-sm text-muted-foreground">Datei wird gelesen…</div>
          ) : (
            <div className={cn("grid gap-4 transition-opacity", loading && "opacity-60")}>
              <Counts preview={p} />

              {p.warnings.length > 0 && (
                <ul className="grid gap-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {p.warnings.map((w) => (
                    <li key={w} className="flex gap-2">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      {w}
                    </li>
                  ))}
                </ul>
              )}

              {p.csv && mapping && (
                <MappingEditor
                  preview={p}
                  mapping={mapping}
                  open={mappingOpen || p.counts.errors > 0 || p.counts.total === 0}
                  onToggle={() => setMappingOpen((o) => !o)}
                  onChange={editMapping}
                  onPreset={(preset) => load({ preset })}
                />
              )}

              {p.errors.length > 0 && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  <div className="font-medium">
                    {p.errors.length} {p.errors.length === 1 ? "Zeile" : "Zeilen"} nicht lesbar
                  </div>
                  <ul className="mt-1 text-xs">
                    {p.errors.slice(0, 5).map((e) => (
                      <li key={e.line}>
                        Zeile {e.line}: {e.message}
                      </li>
                    ))}
                    {p.errors.length > 5 && <li>…</li>}
                  </ul>
                </div>
              )}

              <PreviewTable preview={p} />
            </div>
          )}
        </div>

        <DialogFooter className="items-center">
          {p && p.closingBalanceCents !== null && (
            <span className="mr-auto text-xs text-muted-foreground tabular">
              Saldo laut Auszug: {formatCents(p.openingBalanceCents ?? 0)} → {formatCents(p.closingBalanceCents)}
            </span>
          )}
          <Button variant="outline" onClick={onClose}>
            Abbrechen
          </Button>
          <Button onClick={submit} disabled={!p || loading || commit.isPending || p.counts.new === 0}>
            {!p || p.counts.new > 0
              ? `${p?.counts.new ?? ""} ${p?.counts.new === 1 ? "Buchung" : "Buchungen"} importieren`
              : "Keine neuen Buchungen"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Counts({ preview: p }: { preview: BankImportPreview }) {
  const items: [string, React.ReactNode][] = [
    ["Neu", <span className="tabular font-medium">{p.counts.new}</span>],
    ["Bereits importiert", <span className="tabular">{p.counts.duplicate}</span>],
    ...(p.counts.skipped ? ([["Übersprungen", <span className="tabular">{p.counts.skipped}</span>]] as [string, React.ReactNode][]) : []),
    ["Eingänge (neu)", <Amount cents={p.inCents} />],
    ["Ausgänge (neu)", <Amount cents={p.outCents} />],
  ];
  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PreviewTable({ preview: p }: { preview: BankImportPreview }) {
  const rows = p.rows.slice(0, PREVIEW_LIMIT);
  const more = p.counts.total - rows.length;
  return (
    <div className="rounded-lg border">
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            <th className="w-24 px-3 py-2 text-left font-medium">Datum</th>
            <th className="w-48 px-3 py-2 text-left font-medium">Gegenpartei</th>
            <th className="px-3 py-2 text-left font-medium">Verwendungszweck</th>
            <th className="w-32 px-3 py-2 text-right font-medium">Betrag</th>
            <th className="w-36 px-3 py-2 text-left font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={cn("border-b last:border-0", r.status !== "new" && "text-muted-foreground")}>
              <td className="px-3 py-1.5 tabular">{formatDate(r.bookingDate)}</td>
              <td className="truncate px-3 py-1.5" title={r.counterpartyIban || undefined}>
                {r.counterpartyName || <span className="text-muted-foreground">–</span>}
              </td>
              <td className="truncate px-3 py-1.5" title={r.purpose}>
                {r.purpose}
              </td>
              <td className="px-3 py-1.5 text-right">
                <Amount cents={r.amountCents} />
                {r.currency !== "EUR" && <span className="ml-1 text-xs">{r.currency}</span>}
              </td>
              <td className="px-3 py-1.5">
                <span className={cn("inline-flex h-5 items-center rounded-full border px-2 text-xs", STATUS[r.status].className)}>
                  {STATUS[r.status].label}
                </span>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-3 py-10 text-center text-muted-foreground">
                Keine Buchungen erkannt – bitte die Spaltenzuordnung prüfen.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {more > 0 && <div className="border-t px-3 py-1.5 text-xs text-muted-foreground">… und {more} weitere</div>}
    </div>
  );
}

// ── CSV mapping ─────────────────────────────────────────────────────────────────

const NONE = "-";

function MappingEditor({
  preview,
  mapping,
  open,
  onToggle,
  onChange,
  onPreset,
}: {
  preview: BankImportPreview;
  mapping: CsvMapping;
  open: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<CsvMapping>) => void;
  onPreset: (preset: string) => void;
}) {
  const { data: presets = [] } = useQuery(csvPresetsQuery);
  const csv = preview.csv!;
  const preset = presets.find((x) => x.id === mapping.preset);
  const splitAmount = mapping.amount === null && (mapping.credit !== null || mapping.debit !== null);
  const sampleOf = (i: number) => csv.sample.find((r) => r[i]?.trim())?.[i] ?? "";

  const columnSelect = (label: string, value: number | null, set: (v: number | null) => void, required = false) => (
    <div className="grid min-w-0 gap-1">
      <Label className="text-xs text-muted-foreground">
        {label}
        {required && " *"}
      </Label>
      <Select value={value === null ? NONE : String(value)} onValueChange={(v) => set(v === NONE ? null : Number(v))}>
        <SelectTrigger size="sm" className="w-full min-w-0 overflow-hidden">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {!required && <SelectItem value={NONE}>–</SelectItem>}
          {csv.columns.map((c, i) => (
            <SelectItem key={i} value={String(i)}>
              <span className="truncate">
                {c}
                {sampleOf(i) && c !== sampleOf(i) && <span className="ml-1.5 text-muted-foreground">({sampleOf(i).slice(0, 24)})</span>}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  const setPurpose = (slot: number, v: number | null) => {
    const next = [...mapping.purpose];
    if (v === null) next.splice(slot, 1);
    else next[slot] = v;
    onChange({ purpose: next.filter((x, i, a) => x !== undefined && a.indexOf(x) === i) });
  };

  return (
    <div className="rounded-lg border">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50"
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        <span className="font-medium">Spaltenzuordnung</span>
        <span className="text-muted-foreground">
          {csv.usedSavedMapping
            ? "– gespeicherte Zuordnung dieses Kontos"
            : csv.detectedPreset
              ? `– erkannt: ${preset?.label ?? csv.detectedPreset}${preset && !preset.verified ? " (bitte prüfen)" : ""}`
              : "– automatisch erraten, bitte prüfen"}
        </span>
      </button>
      {open && (
        <div className="grid gap-4 border-t px-3 py-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
            <div className="col-span-2 grid min-w-0 gap-1">
              <Label className="text-xs text-muted-foreground">Vorlage</Label>
              <Select value={presets.some((x) => x.id === mapping.preset) ? mapping.preset : "generic"} onValueChange={onPreset}>
                <SelectTrigger size="sm" className="w-full min-w-0 overflow-hidden">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {presets.map((x) => (
                    <SelectItem key={x.id} value={x.id}>
                      {x.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <SmallSelect
              label="Trennzeichen"
              value={mapping.delimiter}
              options={CSV_DELIMITERS.map((d) => [d, DELIMITER_LABELS[d]])}
              onChange={(delimiter) => onChange({ delimiter })}
            />
            <SmallSelect
              label="Zeichensatz"
              value={mapping.encoding}
              options={CSV_ENCODINGS.map((e) => [e, ENCODING_LABELS[e]])}
              onChange={(encoding) => onChange({ encoding })}
            />
            <SmallSelect
              label="Dezimaltrennzeichen"
              value={mapping.decimal}
              options={[
                [",", "Komma (1.234,56)"],
                [".", "Punkt (1,234.56)"],
              ]}
              onChange={(decimal) => onChange({ decimal })}
            />
            <SmallSelect
              label="Datumsformat"
              value={mapping.dateFormat}
              options={CSV_DATE_FORMATS.map((f) => [f, f.replace(/D/g, "T").replace(/Y/g, "J")])}
              onChange={(dateFormat) => onChange({ dateFormat })}
            />
          </div>
          <div className="flex flex-wrap items-center gap-6 text-sm">
            <label className="flex items-center gap-2">
              <Switch checked={mapping.hasHeader} onCheckedChange={(hasHeader) => onChange({ hasHeader })} />
              Erste Zeile ist Kopfzeile
            </label>
            <label className="flex items-center gap-2">
              Zeilen am Anfang überspringen
              <Input
                type="number"
                min={0}
                max={50}
                value={mapping.skipRows}
                onChange={(e) => onChange({ skipRows: Math.max(0, Math.min(50, Number(e.target.value) || 0)) })}
                className="h-8 w-16 tabular"
              />
            </label>
            <label className="flex items-center gap-2">
              <Switch
                checked={splitAmount}
                onCheckedChange={(on) =>
                  onChange(
                    on
                      ? { amount: null, credit: mapping.amount, debit: null }
                      : { amount: mapping.credit ?? mapping.debit ?? 0, credit: null, debit: null },
                  )
                }
              />
              Getrennte Spalten für Soll / Haben
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {columnSelect("Buchungsdatum", mapping.bookingDate, (v) => onChange({ bookingDate: v ?? 0 }), true)}
            {columnSelect("Valutadatum", mapping.valueDate, (valueDate) => onChange({ valueDate }))}
            {splitAmount ? (
              <>
                {columnSelect("Haben (Eingang)", mapping.credit, (credit) => onChange({ credit }))}
                {columnSelect("Soll (Ausgang)", mapping.debit, (debit) => onChange({ debit }))}
              </>
            ) : (
              columnSelect("Betrag (mit Vorzeichen)", mapping.amount, (amount) => onChange({ amount }), true)
            )}
            {columnSelect("Name Gegenpartei", mapping.counterpartyName[0] ?? null, (v) =>
              onChange({ counterpartyName: v === null ? [] : [v, ...mapping.counterpartyName.slice(1).filter((x) => x !== v)] }),
            )}
            {columnSelect("IBAN Gegenpartei", mapping.counterpartyIban, (counterpartyIban) => onChange({ counterpartyIban }))}
            {columnSelect("Verwendungszweck", mapping.purpose[0] ?? null, (v) => setPurpose(0, v))}
            {columnSelect("Verwendungszweck 2", mapping.purpose[1] ?? null, (v) => setPurpose(1, v))}
            {columnSelect("Referenz", mapping.reference, (reference) => onChange({ reference }))}
            {columnSelect("Währung", mapping.currency, (currency) => onChange({ currency }))}
            {columnSelect("Gebühr (wird abgezogen)", mapping.fee, (fee) => onChange({ fee }))}
          </div>
          <p className="text-xs text-muted-foreground">Die Zuordnung wird beim Import für dieses Konto gespeichert.</p>
        </div>
      )}
    </div>
  );
}

function SmallSelect<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="grid min-w-0 gap-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={(v) => onChange(v as T)}>
        <SelectTrigger size="sm" className="w-full min-w-0 overflow-hidden">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([v, l]) => (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
