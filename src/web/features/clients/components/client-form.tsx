import type { ReactNode } from "react";
import { type Control, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Building2, User } from "lucide-react";
import { COUNTRY_OPTIONS } from "@shared/countries";
import {
  type ClientCreate,
  type ClientFormValues,
  type ClientType,
  clientCreateSchema,
  formatClientNumber,
} from "@shared/schemas/client";
import { defaultTaxMode, isEuCountry, TAX_MODE_LABELS, TAX_MODES, type TaxMode } from "@shared/tax";
import { FormSection, NumberField, TextField, TextareaField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { type Client, nextClientNumberQuery, settingsQuery } from "@/sdk";
import { ClientEInvoiceSection } from "./client-einvoice-section";

export const EMPTY_CLIENT: ClientFormValues = {
  type: "company",
  name: "",
  contactPerson: "",
  street: "",
  addressExtra: "",
  zip: "",
  city: "",
  country: "AT",
  uid: "",
  email: "",
  phone: "",
  paymentTermsDays: null,
  defaultTaxMode: null,
  eInvoiceFormat: null,
  eInvoiceBuyerReference: "",
  eInvoiceSupplierId: "",
  notes: "",
};

export function clientToFormValues(c: Client): ClientFormValues {
  const { id: _id, archivedAt: _a, createdAt: _c, updatedAt: _u, ...values } = c;
  return values;
}

const TYPE_OPTIONS: { value: ClientType; label: string; icon: typeof Building2 }[] = [
  { value: "company", label: "Firma", icon: Building2 },
  { value: "person", label: "Privatperson", icon: User },
];

export function ClientForm({
  defaultValues,
  pending,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  defaultValues: ClientFormValues;
  pending: boolean;
  submitLabel: string;
  onSubmit: (values: ClientCreate) => void;
  onCancel: () => void;
}) {
  const form = useForm<ClientFormValues, unknown, ClientCreate>({
    resolver: zodResolver(clientCreateSchema),
    defaultValues,
  });
  const { control } = form;
  const [type, country, uid, taxMode] = useWatch({ control, name: ["type", "country", "uid", "defaultTaxMode"] });
  const isNew = defaultValues.number === undefined;
  const nextNumber = useQuery({ ...nextClientNumberQuery, enabled: isNew });
  const settings = useQuery(settingsQuery);

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="max-w-4xl">
        <FormSection title="Stammdaten">
          <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
            <FormField
              control={control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Kundentyp</FormLabel>
                  <div role="radiogroup" className="grid h-9 grid-cols-2 rounded-md border bg-muted/40 p-0.5">
                    {TYPE_OPTIONS.map(({ value, label, icon: Icon }) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={field.value === value}
                        onClick={() => field.onChange(value)}
                        className={cn(
                          "flex items-center justify-center gap-2 rounded-[5px] text-sm text-muted-foreground transition-colors",
                          field.value === value && "bg-background font-medium text-foreground shadow-xs",
                        )}
                      >
                        <Icon className="size-4 opacity-70" strokeWidth={1.75} />
                        {label}
                      </button>
                    ))}
                  </div>
                </FormItem>
              )}
            />
            <FormField
              control={control}
              name="number"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Kundennummer</FormLabel>
                  <div className="relative">
                    <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
                      K-
                    </span>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        className="tabular pl-[1.625rem]"
                        placeholder={nextNumber.data ? formatClientNumber(nextNumber.data.number).slice(2) : "auto"}
                        name={field.name}
                        ref={field.ref}
                        onBlur={field.onBlur}
                        value={field.value ?? ""}
                        onChange={(e) => field.onChange(e.target.value === "" ? undefined : Number(e.target.value))}
                      />
                    </FormControl>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <TextField control={control} name="name" label={type === "company" ? "Firmenname" : "Name"} autoFocus={isNew} />
          {type === "company" && <TextField control={control} name="contactPerson" label="Ansprechpartner:in" />}
        </FormSection>

        <FormSection title="Adresse">
          <TextField control={control} name="street" label="Straße" />
          <TextField control={control} name="addressExtra" label="Adresszusatz" placeholder="z. B. Stiege, Top, c/o" />
          <div className="grid gap-4 sm:grid-cols-[120px_1fr_200px]">
            <TextField control={control} name="zip" label="PLZ" />
            <TextField control={control} name="city" label="Ort" />
            <CountryField control={control} />
          </div>
        </FormSection>

        <FormSection title="Kontakt">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField control={control} name="email" label="E-Mail" type="email" />
            <TextField control={control} name="phone" label="Telefon" />
          </div>
        </FormSection>

        <FormSection
          title="Steuer & Zahlung"
          description="Vorbelegung für neue Belege. Im Beleg selbst weiterhin änderbar."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              control={control}
              name="uid"
              label="UID-Nummer"
              className="content-start"
              placeholder={type === "company" ? "z. B. DE123456789" : undefined}
              description={uidHint(country ?? "AT", uid ?? "", taxMode)}
            />
            <NumberField
              control={control}
              name="paymentTermsDays"
              label="Zahlungsziel"
              className="content-start"
              suffix="Tage"
              min={0}
              placeholder={settings.data ? String(settings.data.paymentTermsDays) : undefined}
              description="Leer = Standard aus den Einstellungen."
            />
          </div>
          <TaxModeField control={control} smallBusiness={settings.data?.smallBusiness ?? false} />
        </FormSection>

        <ClientEInvoiceSection control={control} />

        <FormSection title="Notizen" description="Intern, erscheint nicht auf Belegen.">
          <TextareaField control={control} name="notes" label="Notizen" rows={4} />
        </FormSection>

        <div className="sticky bottom-0 -mx-8 -mb-8 flex justify-end gap-2 border-t bg-background/90 pl-8 pr-[calc(2rem+var(--fab-space,0px))] py-3 backdrop-blur">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Abbrechen
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? "Speichern…" : submitLabel}
          </Button>
        </div>
      </form>
    </Form>
  );
}

function CountryField({ control }: { control: Control<ClientFormValues> }) {
  return (
    <FormField
      control={control}
      name="country"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Land</FormLabel>
          <Select value={field.value} onValueChange={field.onChange}>
            <FormControl>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              {COUNTRY_OPTIONS.map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function uidHint(country: string, uid: string, mode: TaxMode | null | undefined): ReactNode {
  if (mode === "EU_REVERSE_CHARGE" && !uid.trim()) return <span className="text-destructive">Für Reverse Charge erforderlich.</span>;
  if (country !== "AT" && isEuCountry(country) && !uid.trim()) return "Ohne UID: Abrechnung mit AT-USt. (B2C).";
  return undefined;
}

const AUTO = "auto";

function TaxModeField({ control, smallBusiness }: { control: Control<ClientFormValues>; smallBusiness: boolean }) {
  const [country = "AT", uid = ""] = useWatch({ control, name: ["country", "uid"] });
  // Derived without the small-business override: that's a global setting, shown separately below.
  const derived = defaultTaxMode({ country, uid }, { smallBusiness: false });

  return (
    <FormField
      control={control}
      name="defaultTaxMode"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Steuermodus</FormLabel>
          <Select value={field.value ?? AUTO} onValueChange={(v) => field.onChange(v === AUTO ? null : v)}>
            <FormControl>
              <SelectTrigger className="w-full sm:w-1/2">
                <SelectValue />
              </SelectTrigger>
            </FormControl>
            <SelectContent>
              <SelectItem value={AUTO}>
                Automatisch <span className="text-muted-foreground">({TAX_MODE_LABELS[derived]})</span>
              </SelectItem>
              <SelectSeparator />
              {TAX_MODES.map((m) => (
                <SelectItem key={m} value={m}>
                  {TAX_MODE_LABELS[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <FormDescription>
            {smallBusiness
              ? "Kleinunternehmerregelung ist aktiv – neue Belege sind unabhängig davon umsatzsteuerfrei."
              : "Automatisch: aus Land und UID abgeleitet."}
          </FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
