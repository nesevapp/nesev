import type { Control } from "react-hook-form";
import type { DocumentFormData, DocumentFormValues } from "@shared/schemas/document";
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import type { Client } from "@/sdk";

const LABELS = {
  ebinterface: "Auftragsreferenz",
  xrechnung: "Leitweg-ID",
  zugferd: "Bestell-/Auftragsreferenz",
} as const;

/** Document editor: buyer/order reference for the e-invoice, shown when the client receives one. */
export function BuyerReferenceField({
  control,
  client,
}: {
  control: Control<DocumentFormValues, unknown, DocumentFormData>;
  client: Client;
}) {
  if (!client.eInvoiceFormat) return null;
  const fallback = client.eInvoiceBuyerReference.trim();
  return (
    <FormField
      control={control}
      name="buyerReference"
      render={({ field }) => (
        <FormItem>
          <FormLabel>{LABELS[client.eInvoiceFormat!]}</FormLabel>
          <FormControl>
            <Input {...field} placeholder={fallback || "Bestell-/Auftragsreferenz"} />
          </FormControl>
          <FormDescription>
            Für die E-Rechnung. {fallback ? `Leer = Vorgabe des Kunden (${fallback}).` : "Beim Kunden ist keine Vorgabe hinterlegt."}
          </FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
