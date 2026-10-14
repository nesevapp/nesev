import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { todayIso } from "@shared/dates";
import { formatCents } from "@shared/money";
import { FormSection } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CODECS, NumericInput } from "@/features/documents/components/numeric-input";
import { apiErrorMessage, forecastSettingsQuery, recurringExpensesQuery, useUpdateForecastSettings } from "@/sdk";

/**
 * "Zahlungsprognose" section on the settings page: the same three values as the forecast page's
 * "Kontostand & Steuern" popover (start balance + date, quarterly ESt-Vorauszahlung).
 */
export function ForecastSettingsSection() {
  const { data: settings } = useQuery(forecastSettingsQuery);
  const { data: fixed = [] } = useQuery(recurringExpensesQuery);
  const save = useUpdateForecastSettings();
  const [balance, setBalance] = useState<number | null>(null);
  const [date, setDate] = useState("");
  const [prepayment, setPrepayment] = useState(0);

  const reset = () => {
    if (!settings) return;
    setBalance(settings.cashBalanceCents);
    setDate(settings.cashBalanceDate ?? "");
    setPrepayment(settings.incomeTaxPrepaymentCents);
  };
  useEffect(reset, [settings]);

  const dirty =
    !!settings &&
    (balance !== settings.cashBalanceCents ||
      (date || null) !== settings.cashBalanceDate ||
      prepayment !== settings.incomeTaxPrepaymentCents);

  const running = fixed.filter((r) => r.active && !r.ended);
  const monthly = running.reduce((s, r) => s + r.monthlyCents, 0);

  const submit = (clearBalance = false) => {
    const withBalance = !clearBalance && balance !== null;
    save.mutate(
      {
        cashBalanceCents: withBalance ? balance : null,
        cashBalanceDate: withBalance ? date || todayIso() : null,
        incomeTaxPrepaymentCents: prepayment,
      },
      {
        onSuccess: () => toast.success("Prognose-Einstellungen gespeichert"),
        onError: (err) => toast.error(apiErrorMessage(err)),
      },
    );
  };

  return (
    <div id="prognose" className="max-w-4xl scroll-mt-8 border-t pt-8">
      <FormSection
        title="Zahlungsprognose"
        description="Ausgangspunkt für den erwarteten Kontostand und Steuer-Vorauszahlungen in der Zahlungsprognose. Auch direkt in der Prognose unter „Kontostand & Steuern“ änderbar."
      >
        <div className="grid gap-1.5">
          <Label className="text-sm">Kontostand</Label>
          <div className="grid max-w-md grid-cols-[1fr_160px] gap-2">
            <NumericInput
              aria-label="Kontostand in Euro"
              value={balance ?? 0}
              onChange={setBalance}
              codec={CODECS.money}
              placeholder="0,00"
            />
            <Input
              type="date"
              aria-label="Kontostand am"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="tabular"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Zahlungen vor diesem Datum gelten als enthalten. Ohne Kontostand zeigt die Prognose nur den kumulierten Saldo.
            {settings?.cashBalanceCents != null && (
              <>
                {" "}
                <button type="button" className="underline-offset-4 hover:underline" onClick={() => submit(true)}>
                  Kontostand entfernen
                </button>
              </>
            )}
          </p>
        </div>
        <div className="grid max-w-md gap-1.5">
          <Label htmlFor="settings-est" className="text-sm">
            ESt-Vorauszahlung pro Quartal
          </Label>
          <NumericInput id="settings-est" value={prepayment} min={0} onChange={setPrepayment} codec={CODECS.money} />
          <p className="text-xs text-muted-foreground">Laut Bescheid, fällig 15.2., 15.5., 15.8. und 15.11. – 0 = keine.</p>
        </div>
        <Link
          to="/fixed-costs"
          className="flex max-w-md items-center justify-between rounded-md border px-3 py-2 text-sm hover:bg-muted/50"
        >
          <span>
            Fixkosten
            <span className="block text-xs text-muted-foreground">
              {running.length ? `${running.length} aktiv · Ø ${formatCents(monthly)} pro Monat` : "Noch keine erfasst"}
            </span>
          </span>
          <ArrowRight className="size-4 text-muted-foreground" />
        </Link>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={!dirty} onClick={reset}>
            Verwerfen
          </Button>
          <Button type="button" disabled={!dirty || save.isPending} onClick={() => submit()}>
            Prognose speichern
          </Button>
        </div>
      </FormSection>
    </div>
  );
}
