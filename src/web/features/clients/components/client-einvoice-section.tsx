import { type Control, useWatch } from "react-hook-form";
import { EINVOICE_FORMAT_LABELS, EINVOICE_FORMATS } from "@shared/einvoice";
import type { ClientFormValues } from "@shared/schemas/client";
import { FormSection, TextField } from "@/components/form-fields";
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";

const NONE = "none";

const REFERENCE_LABEL = {
  ebinterface: { label: "Auftragsreferenz", placeholder: "z. B. 4500012345", hint: "Beim Bund Pflicht (Bestellnummer bzw. Einkäufergruppe)." },
  xrechnung: { label: "Leitweg-ID", placeholder: "z. B. 04011000-1234512345-06", hint: "Pflicht für XRechnung an öffentliche Auftraggeber." },
  zugferd: { label: "Käuferreferenz", placeholder: "optional", hint: "Optional, z. B. Bestellnummer oder Kostenstelle." },
} as const;

/** Client form section: e-invoice format and routing data (default for the client's invoices). */
export function ClientEInvoiceSection({ control }: { control: Control<ClientFormValues> }) {
  const format = useWatch({ control, name: "eInvoiceFormat" });
  const ref = format ? REFERENCE_LABEL[format] : null;

  return (
    <FormSection title="E-Rechnung" description="Strukturierte Rechnung zusätzlich zum PDF, z. B. für den Bund oder deutsche Behörden.">
      <FormField
        control={control}
        name="eInvoiceFormat"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Format</FormLabel>
            <Select value={field.value ?? NONE} onValueChange={(v) => field.onChange(v === NONE ? null : v)}>
              <FormControl>
                <SelectTrigger className="w-full sm:w-1/2">
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value={NONE}>Keine (nur PDF)</SelectItem>
                <SelectSeparator />
                {EINVOICE_FORMATS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {EINVOICE_FORMAT_LABELS[f]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormDescription>Wird beim Herunterladen der E-Rechnung vorausgewählt.</FormDescription>
            <FormMessage />
          </FormItem>
        )}
      />
      {ref && (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            control={control}
            name="eInvoiceBuyerReference"
            label={ref.label}
            className="content-start"
            placeholder={ref.placeholder}
            description={`${ref.hint} Im Beleg überschreibbar.`}
          />
          {format === "ebinterface" && (
            <TextField
              control={control}
              name="eInvoiceSupplierId"
              label="Lieferantennummer"
              className="content-start"
              description="Unsere Lieferantennummer beim Kunden (beim Bund Pflicht)."
            />
          )}
        </div>
      )}
    </FormSection>
  );
}
