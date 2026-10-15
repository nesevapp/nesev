import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, FileArchive, FileSpreadsheet, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import {
  type AccountingExportSettings,
  accountingExportSettingsSchema,
  BMD_ENCODINGS,
  DEFAULT_ACCOUNTING_EXPORT_SETTINGS,
  REVENUE_ACCOUNT_KEYS,
  REVENUE_ACCOUNT_LABELS,
} from "@shared/accounting-export";
import { EXPENSE_CATEGORIES, type ExpenseCategoryKey } from "@shared/expenses";
import { FormSection } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  accountingExportSettingsQuery,
  accountingExportSummaryQuery,
  apiErrorMessage,
  exportUrls,
  useUpdateAccountingExportSettings,
} from "@/sdk";
import { DownloadButton } from "./download-button";
import { useRangePicker } from "./range-picker";

const ENCODING_LABELS: Record<(typeof BMD_ENCODINGS)[number], string> = {
  "windows-1252": "Windows-1252 (ANSI, BMD-Standard)",
  "utf-8": "UTF-8",
};

/** "Steuerberatung" section: BMD bookings + generic CSV + receipts ZIP, and the account mapping. */
export function AccountantExport() {
  const { range, valid, controls } = useRangePicker("accounting");
  const [payments, setPayments] = useState(false);
  const params = { ...range, payments };
  const summary = useQuery({ ...accountingExportSummaryQuery(params), enabled: valid });
  const [showMapping, setShowMapping] = useState(false);
  const s = summary.data;
  const empty = s && s.bookings === 0;

  return (
    <FormSection
      title="Steuerberatung (BMD / RZL)"
      description="Buchungen für den Import in BMD NTCS, dieselben Belege als CSV ohne Kontonummern (RZL, Excel) und alle Rechnungen und Ausgabenbelege als ZIP."
    >
      {controls}

      <div className="flex items-center gap-2">
        <Switch id="accounting-payments" size="sm" checked={payments} onCheckedChange={setPayments} />
        <Label htmlFor="accounting-payments" className="text-sm font-normal">
          Bankzahlungen mitexportieren
        </Label>
        <span className="text-xs text-muted-foreground">(zugeordnete Kontobewegungen, gleichen die offenen Posten aus)</span>
      </div>

      <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm">
        {!valid ? (
          <span className="text-destructive">Das Enddatum liegt vor dem Startdatum.</span>
        ) : summary.isPending ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Wird geladen …
          </span>
        ) : summary.isError ? (
          <span className="text-destructive">{apiErrorMessage(summary.error)}</span>
        ) : empty ? (
          <span className="text-muted-foreground">Keine Belege in diesem Zeitraum.</span>
        ) : (
          s && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <Count n={s.invoices} one="Rechnung" many="Rechnungen" />
                <Count n={s.creditNotes} one="Gutschrift" many="Gutschriften" />
                <Count n={s.expenses} one="Ausgabe" many="Ausgaben" />
                {payments && <Count n={s.payments} one="Zahlung" many="Zahlungen" />}
                <span className="text-muted-foreground">
                  → <span className="font-medium text-foreground tabular">{s.bookings}</span> Buchungszeilen
                </span>
              </div>
              {(s.missingReceipts.length > 0 || s.warnings.length > 0) && (
                <ul className="space-y-1 text-xs text-amber-800">
                  {s.missingReceipts.length > 0 && (
                    <li className="flex gap-1.5">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      Ohne Beleg-Datei: {s.missingReceipts.join(", ")}
                    </li>
                  )}
                  {s.warnings.map((w) => (
                    <li key={w} className="flex gap-1.5">
                      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                      {w}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <DownloadButton href={exportUrls.accountingZip(params)} disabled={!valid} icon={FileArchive}>
          ZIP mit Buchungen und Belegen
        </DownloadButton>
        <DownloadButton href={exportUrls.accountingBmd(params)} disabled={!valid} icon={FileSpreadsheet} variant="outline">
          BMD-Buchungen (CSV)
        </DownloadButton>
        <DownloadButton href={exportUrls.accountingGeneric(params)} disabled={!valid} icon={FileSpreadsheet} variant="outline">
          CSV ohne Konten
        </DownloadButton>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        BMD-Format „Buchungsimport“ (Standardschnittstelle für Fremdsysteme): eine Zeile je Steuersatz bzw. Ausgabenposition,
        Konto = Erlös-/Aufwandskonto, Gegenkonto = Debitor/Kreditor, Betrag netto mit getrennter Steuer und BMD-Steuercode;
        Erlöse im Haben (negativ), Gutschriften und Ausgaben im Soll. Die Belege im ZIP heißen wie die Belegnummer (Spalte
        „extbelegnr“). <span className="text-foreground">Nach bestem Wissen umgesetzt, aber nicht gegen BMD getestet — den ersten Import bitte mit der Steuerberatung prüfen.</span>{" "}
        Ausgaben nach Belegdatum; Anlagegüter gehen aufs Anlagenkonto (AfA nicht enthalten).
      </p>

      <div>
        <button
          type="button"
          className="flex items-center gap-1 text-sm font-medium hover:underline"
          onClick={() => setShowMapping((v) => !v)}
          aria-expanded={showMapping}
        >
          <ChevronRight className={cn("size-4 transition-transform", showMapping && "rotate-90")} />
          Kontenzuordnung
        </button>
        {showMapping && <AccountMapping />}
      </div>
    </FormSection>
  );
}

function Count({ n, one, many }: { n: number; one: string; many: string }) {
  return (
    <span>
      <span className="font-medium tabular">{n}</span> {n === 1 ? one : many}
    </span>
  );
}

function AccountMapping() {
  const { data } = useQuery(accountingExportSettingsQuery);
  const update = useUpdateAccountingExportSettings();
  const [form, setForm] = useState<AccountingExportSettings | null>(null);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  if (!form || !data) {
    return (
      <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Wird geladen …
      </p>
    );
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(data);
  const isDefault = JSON.stringify(form) === JSON.stringify(DEFAULT_ACCOUNTING_EXPORT_SETTINGS);
  const set = (patch: Partial<AccountingExportSettings>) => setForm({ ...form, ...patch });

  const save = () => {
    const parsed = accountingExportSettingsSchema.safeParse(form);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Ungültige Eingabe");
      return;
    }
    update.mutate(parsed.data, {
      onSuccess: () => toast.success("Kontenzuordnung gespeichert"),
      onError: (err) => toast.error(apiErrorMessage(err)),
    });
  };

  return (
    <div className="mt-4 space-y-6">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Vorbelegt nach dem österreichischen Einheitskontenrahmen. Jede Kanzlei hat ihren eigenen Kontenplan — Nummern bitte mit
        der Steuerberatung abstimmen. Die Steuerkonten (Vorsteuer, USt) ergeben sich in BMD aus dem Steuercode.
      </p>

      <MappingGroup title="Erlöse">
        {REVENUE_ACCOUNT_KEYS.map((k) => (
          <AccountInput
            key={k}
            id={`rev-${k}`}
            label={REVENUE_ACCOUNT_LABELS[k]}
            value={form.revenueAccounts[k]}
            onChange={(v) => set({ revenueAccounts: { ...form.revenueAccounts, [k]: v } })}
          />
        ))}
      </MappingGroup>

      <MappingGroup title="Ausgaben je Kategorie">
        {EXPENSE_CATEGORIES.map((c) => (
          <AccountInput
            key={c.key}
            id={`exp-${c.key}`}
            label={c.label}
            value={form.expenseAccounts[c.key as ExpenseCategoryKey]}
            onChange={(v) => set({ expenseAccounts: { ...form.expenseAccounts, [c.key]: v } })}
          />
        ))}
      </MappingGroup>

      <MappingGroup title="Personen- und Bankkonten">
        <AccountInput id="debtor" label={form.debtorPerClient ? "Debitoren (Basis + Kundennr.)" : "Debitoren (Sammelkonto)"} value={form.debtorAccount} onChange={(v) => set({ debtorAccount: v })} />
        <div className="flex items-center gap-2 sm:col-span-2">
          <Switch id="debtor-per-client" size="sm" checked={form.debtorPerClient} onCheckedChange={(v) => set({ debtorPerClient: v })} />
          <Label htmlFor="debtor-per-client" className="text-xs font-normal text-muted-foreground">
            Eigenes Debitorenkonto je Kunde (z.B. 20000 + K-0007 → 20007)
          </Label>
        </div>
        <AccountInput id="creditor" label="Kreditoren (Sammelkonto)" value={form.creditorAccount} onChange={(v) => set({ creditorAccount: v })} />
        <AccountInput id="bank" label="Bank" value={form.bankAccount} onChange={(v) => set({ bankAccount: v })} />
      </MappingGroup>

      <MappingGroup title="Buchungssymbole und Datei">
        {(
          [
            ["invoice", "Rechnungen"],
            ["creditNote", "Gutschriften"],
            ["expense", "Ausgaben"],
            ["bank", "Bankzahlungen"],
          ] as const
        ).map(([k, label]) => (
          <AccountInput
            key={k}
            id={`sym-${k}`}
            label={label}
            value={form.symbols[k]}
            className="uppercase"
            numeric={false}
            onChange={(v) => set({ symbols: { ...form.symbols, [k]: v.toUpperCase() } })}
          />
        ))}
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="encoding" className="text-xs font-normal text-muted-foreground">
            Zeichensatz der BMD-Datei
          </Label>
          <Select value={form.encoding} onValueChange={(v) => set({ encoding: v as AccountingExportSettings["encoding"] })}>
            <SelectTrigger id="encoding" className="w-80">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BMD_ENCODINGS.map((e) => (
                <SelectItem key={e} value={e}>
                  {ENCODING_LABELS[e]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </MappingGroup>
      <p className="text-xs text-muted-foreground">
        Teilen sich Rechnungen und Gutschriften ein Buchungssymbol, bekommen Gutschriften eine 9 vor die Belegnummer, damit
        die Nummern im Belegkreis eindeutig bleiben.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={!dirty || update.isPending} onClick={save}>
          {update.isPending && <Loader2 className="animate-spin" />}
          Speichern
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={!dirty} onClick={() => setForm(data)}>
          Verwerfen
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={isDefault} onClick={() => setForm(DEFAULT_ACCOUNTING_EXPORT_SETTINGS)}>
          <RotateCcw /> Standardwerte
        </Button>
      </div>
    </div>
  );
}

function MappingGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h3>
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">{children}</div>
    </div>
  );
}

function AccountInput({
  id,
  label,
  value,
  onChange,
  className,
  numeric = true,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  className?: string;
  numeric?: boolean;
}) {
  const invalid = !/^[A-Za-z0-9]{1,9}$/.test(value.trim());
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="min-w-0 truncate text-sm font-normal" title={label}>
        {label}
      </Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid}
        inputMode={numeric ? "numeric" : "text"}
        className={cn("h-8 w-24 shrink-0 text-right tabular", className)}
      />
    </div>
  );
}
