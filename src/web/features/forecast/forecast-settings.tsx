import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Wallet } from "lucide-react";
import { toast } from "sonner";
import { todayIso } from "@shared/dates";
import { formatCents } from "@shared/money";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CODECS, NumericInput } from "@/features/documents/components/numeric-input";
import { apiErrorMessage, forecastSettingsQuery, recurringExpensesQuery, useUpdateForecastSettings } from "@/sdk";

/** "Kontostand & Steuern": start balance, quarterly income tax prepayment and a link to the Fixkosten. */
export function ForecastSettingsPopover({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { data: settings } = useQuery(forecastSettingsQuery);
  const { data: fixed = [] } = useQuery(recurringExpensesQuery);
  const save = useUpdateForecastSettings();
  const [balance, setBalance] = useState<number | null>(null);
  const [date, setDate] = useState("");
  const [prepayment, setPrepayment] = useState(0);

  useEffect(() => {
    if (!open || !settings) return;
    setBalance(settings.cashBalanceCents);
    setDate(settings.cashBalanceDate ?? todayIso());
    setPrepayment(settings.incomeTaxPrepaymentCents);
  }, [open, settings]);

  const running = fixed.filter((r) => r.active && !r.ended);
  const monthly = running.reduce((s, r) => s + r.monthlyCents, 0);

  const submit = (clearBalance = false) => {
    const withBalance = !clearBalance && balance !== null && !!date;
    save.mutate(
      {
        cashBalanceCents: withBalance ? balance : null,
        cashBalanceDate: withBalance ? date : null,
        incomeTaxPrepaymentCents: prepayment,
      },
      {
        onSuccess: () => {
          toast.success("Prognose-Einstellungen gespeichert");
          onOpenChange(false);
        },
        onError: (err) => toast.error(apiErrorMessage(err)),
      },
    );
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Wallet />
          Kontostand &amp; Steuern
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-1.5">
            <div className="text-sm font-medium">Kontostand</div>
            <p className="text-xs text-muted-foreground">
              Ausgangspunkt für den erwarteten Kontostand. Zahlungen vor diesem Datum gelten als enthalten.
            </p>
            <div className="grid grid-cols-[1fr_140px] gap-2">
              <NumericInput
                aria-label="Kontostand in Euro"
                value={balance ?? 0}
                onChange={setBalance}
                codec={CODECS.money}
                placeholder="0,00"
              />
              <Input type="date" aria-label="Kontostand am" value={date} onChange={(e) => setDate(e.target.value)} className="tabular" />
            </div>
            {settings?.cashBalanceCents != null && (
              <button type="button" className="justify-self-start text-xs text-muted-foreground underline-offset-4 hover:underline" onClick={() => submit(true)}>
                Kontostand entfernen
              </button>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="fc-est" className="text-sm">
              ESt-Vorauszahlung pro Quartal
            </Label>
            <NumericInput id="fc-est" value={prepayment} min={0} onChange={setPrepayment} codec={CODECS.money} />
            <p className="text-xs text-muted-foreground">Laut Bescheid, fällig 15.2., 15.5., 15.8. und 15.11. – 0 = keine.</p>
          </div>
          <Link to="/fixed-costs" className="flex items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted/50">
            <span>
              Fixkosten
              <span className="block text-xs text-muted-foreground">
                {running.length ? `${running.length} aktiv · Ø ${formatCents(monthly)} pro Monat` : "Noch keine erfasst"}
              </span>
            </span>
            <ArrowRight className="size-4 text-muted-foreground" />
          </Link>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Abbrechen
            </Button>
            <Button type="submit" size="sm" disabled={save.isPending}>
              Speichern
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
