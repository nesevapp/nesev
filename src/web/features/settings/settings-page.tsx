import { useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ImageUp, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { COUNTRY_OPTIONS } from "@shared/countries";
import { type SettingsFormValues, type SettingsUpdate, settingsUpdateSchema } from "@shared/schemas/settings";
import { Page } from "@/components/page";
import { FormSection, NumberField, SwitchField, TextField, TextareaField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReminderSettingsSection } from "@/features/reminders/reminder-settings";
import { ReceiptSettingsSection } from "@/features/receipts/receipt-settings";
import {
  apiErrorMessage,
  fileUrl,
  type Settings,
  settingsQuery,
  useDeleteLogo,
  useUpdateSettings,
  useUploadLogo,
} from "@/sdk";
import { UnitSettingsSection } from "./unit-settings";

function toFormValues(s: Settings): SettingsFormValues {
  const { id: _id, logoPath: _logo, createdAt: _c, updatedAt: _u, ...values } = s;
  return values;
}

export function SettingsPage() {
  const { data } = useSuspenseQuery(settingsQuery);
  const update = useUpdateSettings();

  const form = useForm<SettingsFormValues, unknown, SettingsUpdate>({
    resolver: zodResolver(settingsUpdateSchema),
    defaultValues: toFormValues(data),
  });
  const { control } = form;

  const onSubmit = form.handleSubmit((values) =>
    update.mutate(values, {
      onSuccess: (saved) => {
        form.reset(toFormValues(saved));
        toast.success("Einstellungen gespeichert");
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    }),
  );

  return (
    <Page title="Einstellungen" description="Unternehmensdaten, Zahlungsbedingungen und Standardtexte für Belege.">
      <Form {...form}>
        <form onSubmit={onSubmit} className="max-w-4xl">
          <FormSection title="Unternehmen" description="Erscheint als Absender auf allen Belegen.">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField control={control} name="companyName" label="Firmenname" />
              <TextField control={control} name="ownerName" label="Inhaber:in" />
            </div>
            <TextField control={control} name="street" label="Straße" />
            <div className="grid gap-4 sm:grid-cols-[120px_1fr_200px]">
              <TextField control={control} name="zip" label="PLZ" />
              <TextField control={control} name="city" label="Ort" />
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
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField control={control} name="uid" label="UID-Nummer" placeholder="ATU12345678" />
              <TextField control={control} name="taxNumber" label="Steuernummer" />
              <TextField control={control} name="companyRegister" label="Firmenbuch" placeholder="FN 123456a" />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField control={control} name="email" label="E-Mail" type="email" />
              <TextField control={control} name="phone" label="Telefon" />
              <TextField control={control} name="website" label="Website" />
            </div>
          </FormSection>

          <FormSection title="Logo" description="PNG, JPG, SVG oder WebP, max. 5 MB.">
            <LogoUpload logoPath={data.logoPath} />
          </FormSection>

          <FormSection title="Bankverbindung" description="Für Zahlungsinformationen und QR-Code auf Rechnungen.">
            <TextField control={control} name="iban" label="IBAN" placeholder="AT00 0000 0000 0000 0000" />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField control={control} name="bic" label="BIC" />
              <TextField control={control} name="bankName" label="Bank" />
            </div>
          </FormSection>

          <FormSection title="Fristen">
            <div className="grid gap-4 sm:grid-cols-2">
              <NumberField control={control} name="paymentTermsDays" label="Zahlungsziel" suffix="Tage" min={0} />
              <NumberField control={control} name="offerValidityDays" label="Angebote gültig für" suffix="Tage" min={0} />
            </div>
          </FormSection>

          <FormSection
            title="Umsatzsteuer"
            description="Hinweistexte werden je nach Steuermodus auf den Beleg gedruckt. Formulierung mit Steuerberatung abstimmen."
          >
            <SwitchField
              control={control}
              name="smallBusiness"
              label="Kleinunternehmerregelung"
              description="Alle neuen Belege ohne Umsatzsteuer (§ 6 Abs. 1 Z 27 UStG)."
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={control}
                name="vatBasis"
                render={({ field }) => (
                  <FormItem className="content-start">
                    <FormLabel>Besteuerungsart</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="accrual">Sollbesteuerung (nach Rechnungsdatum)</SelectItem>
                        <SelectItem value="cash">Istbesteuerung (nach Zahlungseingang)</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Wer sonstige Leistungen erbringt (z.B. Freiberufler, Dienstleister), ist in Österreich meist Ist-besteuert, sofern
                      nicht zur Sollbesteuerung optiert wurde. Bestimmt, welches Datum in der UVA zählt.
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={control}
                name="vatPeriod"
                render={({ field }) => (
                  <FormItem className="content-start">
                    <FormLabel>UVA-Zeitraum</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="quarterly">Vierteljährlich</SelectItem>
                        <SelectItem value="monthly">Monatlich</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">Monatlich, wenn der Vorjahresumsatz 100.000 € überstiegen hat.</p>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <TextareaField control={control} name="taxNoteReverseCharge" label="Hinweis Reverse Charge (EU)" rows={2} />
            <TextareaField control={control} name="taxNoteThirdCountry" label="Hinweis Drittland" rows={2} />
            <TextareaField control={control} name="taxNoteSmallBusiness" label="Hinweis Kleinunternehmer" rows={2} />
          </FormSection>

          <FormSection title="Standardtexte" description="Vorbelegung für Einleitung und Schlusstext neuer Belege.">
            <Tabs defaultValue="offer">
              <TabsList>
                <TabsTrigger value="offer">Angebot</TabsTrigger>
                <TabsTrigger value="invoice">Rechnung</TabsTrigger>
                <TabsTrigger value="credit">Gutschrift</TabsTrigger>
              </TabsList>
              <TabsContent value="offer" className="grid gap-4 pt-2">
                <TextareaField control={control} name="defaultOfferIntro" label="Einleitung" rows={3} />
                <TextareaField control={control} name="defaultOfferClosing" label="Schlusstext" rows={3} />
              </TabsContent>
              <TabsContent value="invoice" className="grid gap-4 pt-2">
                <TextareaField control={control} name="defaultInvoiceIntro" label="Einleitung" rows={3} />
                <TextareaField control={control} name="defaultInvoiceClosing" label="Schlusstext" rows={3} />
              </TabsContent>
              <TabsContent value="credit" className="grid gap-4 pt-2">
                <TextareaField control={control} name="defaultCreditNoteIntro" label="Einleitung" rows={3} />
                <TextareaField control={control} name="defaultCreditNoteClosing" label="Schlusstext" rows={3} />
              </TabsContent>
            </Tabs>
          </FormSection>

          <div className="sticky bottom-0 -mx-8 flex justify-end gap-2 border-t bg-background/90 px-8 py-3 backdrop-blur">
            <Button
              type="button"
              variant="ghost"
              disabled={!form.formState.isDirty}
              onClick={() => form.reset()}
            >
              Verwerfen
            </Button>
            <Button type="submit" disabled={!form.formState.isDirty || update.isPending}>
              {update.isPending ? "Speichern…" : "Speichern"}
            </Button>
          </div>
        </form>
      </Form>
      <UnitSettingsSection />
      <ReminderSettingsSection />
      <ReceiptSettingsSection />
    </Page>
  );
}

function LogoUpload({ logoPath }: { logoPath: string | null }) {
  const input = useRef<HTMLInputElement>(null);
  const upload = useUploadLogo();
  const remove = useDeleteLogo();

  const onFile = (file: File | undefined) => {
    if (!file) return;
    upload.mutate(file, {
      onSuccess: () => toast.success("Logo hochgeladen"),
      onError: (err) => toast.error(apiErrorMessage(err)),
    });
  };

  return (
    <div className="flex items-center gap-4">
      <div className="grid h-20 w-40 place-items-center overflow-hidden rounded-lg border bg-muted/40">
        {logoPath ? (
          <img src={fileUrl(logoPath)} alt="Logo" className="max-h-full max-w-full object-contain p-2" />
        ) : (
          <span className="text-xs text-muted-foreground">Kein Logo</span>
        )}
      </div>
      <div className="flex gap-2">
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          className="hidden"
          onChange={(e) => {
            onFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <Button type="button" variant="outline" size="sm" disabled={upload.isPending} onClick={() => input.current?.click()}>
          <ImageUp />
          {logoPath ? "Ersetzen" : "Hochladen"}
        </Button>
        {logoPath && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate(undefined, { onError: (err) => toast.error(apiErrorMessage(err)) })}
          >
            <Trash2 />
            Entfernen
          </Button>
        )}
      </div>
    </div>
  );
}
