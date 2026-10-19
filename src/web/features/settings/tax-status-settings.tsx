import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { taxStatusInputSchema } from "@shared/schemas/tax-status";
import type { VatPeriod } from "@shared/tax-report";
import { formatValidFrom, TAX_STATUS_BEGINNING, VAT_BASIS_SHORT } from "@shared/tax-status";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  apiErrorMessage,
  type TaxStatusEntry,
  type TaxStatusInput,
  taxStatusQuery,
  useCreateTaxStatus,
  useDeleteTaxStatus,
  useUpdateTaxStatus,
} from "@/sdk";

/** First day of the UVA period after `today` (default date for a new entry). */
function nextPeriodStart(today: string, vatPeriod: VatPeriod): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const next = vatPeriod === "monthly" ? m + 1 : Math.floor((m - 1) / 3) * 3 + 4;
  return next > 12 ? `${y + 1}-01-01` : `${y}-${String(next).padStart(2, "0")}-01`;
}

/**
 * "Steuerstatus" in Einstellungen → Belege → Umsatzsteuer: Kleinunternehmer and Soll/Ist with valid-from dates
 * (rules in shared/tax-status.ts). Rendered inside the settings <form>: the dialog's own form stops its submit
 * event so it doesn't bubble (through the portal) into the settings form.
 */
export function TaxStatusSettings({ vatPeriod }: { vatPeriod: VatPeriod }) {
  const { data } = useQuery(taxStatusQuery);
  const [editing, setEditing] = useState<{ entry?: TaxStatusEntry; values: TaxStatusInput } | null>(null);
  const [deleting, setDeleting] = useState<TaxStatusEntry | null>(null);
  const remove = useDeleteTaxStatus();

  if (!data) return null;
  const periods = data.periods;
  // the entry valid today: the last one starting on or before today
  const currentId = [...periods].reverse().find((p) => p.validFrom <= data.today)?.id ?? periods[0]?.id;

  const startNew = () =>
    setEditing({
      values: {
        validFrom: nextPeriodStart(data.today, vatPeriod),
        smallBusiness: !data.current.smallBusiness,
        vatBasis: data.current.vatBasis,
        note: "",
      },
    });

  return (
    <div id="steuerstatus" className="grid scroll-mt-8 gap-3">
      <div>
        <h3 className="text-sm font-medium">Steuerstatus</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Kleinunternehmerregelung und Besteuerungsart gelten jeweils ab einem Datum bis zum nächsten Eintrag. Ein neuer
          Eintrag wirkt nur ab seinem Datum: frühere, bereits gemeldete Zeiträume (UVA, Einnahmen-Ausgaben-Rechnung)
          bleiben unverändert. Beispiel: bis 2025 Kleinunternehmer, ab 01.01.2026 regelbesteuert → neuer Eintrag ab
          01.01.2026.
        </p>
      </div>
      <ul className="divide-y rounded-lg border">
        {periods.map((p) => (
          <li key={p.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            <div className="flex min-w-0 flex-1 flex-col gap-x-3 sm:flex-row">
              <span className="shrink-0 font-medium tabular sm:w-32">{formatValidFrom(p.validFrom)}</span>
              <span className="min-w-0">
                {p.smallBusiness ? "Kleinunternehmer" : "Regelbesteuert"} · {VAT_BASIS_SHORT[p.vatBasis]}-Besteuerung
                {p.note && <span className="text-muted-foreground"> · {p.note}</span>}
              </span>
            </div>
            {p.id === currentId && (
              <Badge variant="secondary" className="shrink-0">
                gilt heute
              </Badge>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => setEditing({ entry: p, values: { validFrom: p.validFrom, smallBusiness: p.smallBusiness, vatBasis: p.vatBasis, note: p.note } })}
              aria-label={`Steuerstatus ${formatValidFrom(p.validFrom)} bearbeiten`}
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={p.validFrom === TAX_STATUS_BEGINNING}
              title={p.validFrom === TAX_STATUS_BEGINNING ? "Der erste Eintrag gilt von Beginn an und kann nicht gelöscht werden" : undefined}
              onClick={() => setDeleting(p)}
              aria-label={`Steuerstatus ${formatValidFrom(p.validFrom)} löschen`}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </li>
        ))}
      </ul>
      <div>
        <Button type="button" variant="outline" onClick={startNew}>
          <Plus className="size-4" /> Änderung ab Datum
        </Button>
      </div>

      {editing && (
        <TaxStatusDialog
          entry={editing.entry}
          initial={editing.values}
          today={data.today}
          vatPeriod={vatPeriod}
          onClose={() => setEditing(null)}
        />
      )}

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Steuerstatus {deleting ? formatValidFrom(deleting.validFrom) : ""} löschen?</AlertDialogTitle>
            <AlertDialogDescription>
              Ab diesem Datum gilt dann wieder der vorherige Eintrag. Liegt das Datum in der Vergangenheit, ändern sich die
              Zahlen (UVA, Einnahmen-Ausgaben-Rechnung) ab dann.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                deleting &&
                remove.mutate(deleting.id, {
                  onSuccess: () => toast.success("Steuerstatus gelöscht"),
                  onError: (err) => toast.error(apiErrorMessage(err)),
                })
              }
            >
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function TaxStatusDialog({
  entry,
  initial,
  today,
  vatPeriod,
  onClose,
}: {
  entry?: TaxStatusEntry;
  initial: TaxStatusInput;
  today: string;
  vatPeriod: VatPeriod;
  onClose: () => void;
}) {
  const [v, setV] = useState<TaxStatusInput>(initial);
  const create = useCreateTaxStatus();
  const update = useUpdateTaxStatus();
  const pending = create.isPending || update.isPending;
  const isFirst = entry?.validFrom === TAX_STATUS_BEGINNING;
  // editing an entry that already applies changes figures of the past (possibly filed periods)
  const touchesPast = !!entry && entry.validFrom <= today;
  const set = (patch: Partial<TaxStatusInput>) => setV({ ...v, ...patch });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation(); // don't submit the settings form around the portal
    const parsed = taxStatusInputSchema.safeParse(v);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Ungültige Eingabe");
      return;
    }
    const done = {
      onSuccess: () => {
        toast.success("Steuerstatus gespeichert");
        onClose();
      },
      onError: (err: unknown) => toast.error(apiErrorMessage(err)),
    };
    if (entry) update.mutate({ id: entry.id, json: parsed.data }, done);
    else create.mutate(parsed.data, done);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{entry ? "Steuerstatus bearbeiten" : "Steuerstatus ändern ab"}</DialogTitle>
          <DialogDescription>
            Gilt ab dem Datum bis zum nächsten Eintrag. Ein Wechsel der Besteuerungsart ist nur mit Beginn eines
            UVA-Zeitraums möglich ({vatPeriod === "monthly" ? "Monatserster" : "1.1., 1.4., 1.7. oder 1.10."}), in der Regel ab 1. Jänner.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-1.5">
            <Label htmlFor="ts-from">Gültig ab</Label>
            {isFirst ? (
              <p id="ts-from" className="text-sm text-muted-foreground">
                von Beginn an (bis zum nächsten Eintrag)
              </p>
            ) : (
              <Input id="ts-from" type="date" value={v.validFrom} onChange={(e) => set({ validFrom: e.target.value })} className="tabular" required />
            )}
          </div>
          <div className="flex items-start justify-between gap-6 rounded-lg border p-4">
            <div className="space-y-1">
              <Label htmlFor="ts-ku">Kleinunternehmerregelung</Label>
              <p className="text-sm text-muted-foreground">Belege ab diesem Tag ohne Umsatzsteuer (§ 6 Abs. 1 Z 27 UStG), kein Vorsteuerabzug.</p>
            </div>
            <Switch id="ts-ku" checked={v.smallBusiness} onCheckedChange={(smallBusiness) => set({ smallBusiness })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ts-basis">Besteuerungsart</Label>
            <Select value={v.vatBasis} onValueChange={(x) => set({ vatBasis: x as TaxStatusInput["vatBasis"] })}>
              <SelectTrigger id="ts-basis" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="accrual">Soll (nach Rechnungsdatum)</SelectItem>
                <SelectItem value="cash">Ist (nach Zahlungseingang)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Wer sonstige Leistungen erbringt (z.B. Freiberufler, Dienstleister), ist in Österreich meist Ist-besteuert, sofern
              nicht zur Sollbesteuerung optiert wurde. Bestimmt, welches Datum in der UVA zählt; Rechnungen und Ausgaben
              behalten die Besteuerungsart ihres Belegdatums.
            </p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ts-note">Notiz</Label>
            <Input id="ts-note" value={v.note} onChange={(e) => set({ note: e.target.value })} placeholder="z. B. Umsatzgrenze 2025 überschritten" maxLength={500} />
          </div>
          {touchesPast && (
            <p className="rounded-md border border-warning-border bg-warning-muted px-3 py-2 text-sm text-warning">
              Dieser Eintrag gilt bereits{isFirst ? "" : ` seit ${formatValidFrom(entry.validFrom).replace("ab ", "")}`}: Eine Änderung
              ändert auch die Zahlen bereits vergangener (womöglich gemeldeter) Zeiträume. Für eine Änderung ab heute oder
              später besser einen neuen Eintrag anlegen.
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Abbrechen
            </Button>
            <Button type="submit" disabled={pending}>
              Speichern
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
