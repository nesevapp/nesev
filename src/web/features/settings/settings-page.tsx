import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
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
import { ForecastSettingsSection } from "@/features/forecast/forecast-settings-section";
import { ReceiptSettingsSection } from "@/features/receipts/receipt-settings";
import { ChatSettingsSection } from "@/features/chat/chat-settings-section";
import {
  apiErrorMessage,
  fileUrl,
  type Settings,
  settingsQuery,
  useDeleteLogo,
  useUpdateSettings,
  useUploadLogo,
} from "@/sdk";
import { cn } from "@/lib/utils";
import { FORM_TABS, HASH_TABS, SETTINGS_TAB_LABELS, SETTINGS_TABS, type SettingsTab, tabsOfFields } from "./settings-tabs";
import { UnitSettingsSection } from "./unit-settings";

function toFormValues(s: Settings): SettingsFormValues {
  const { id: _id, logoPath: _logo, createdAt: _c, updatedAt: _u, ...values } = s;
  return values;
}

export function SettingsPage() {
  const { data } = useSuspenseQuery(settingsQuery);
  const update = useUpdateSettings();
  const search = useSearch({ from: "/settings" });
  const { hash } = useLocation();
  const navigate = useNavigate({ from: "/settings" });
  const tab: SettingsTab = search.tab ?? "unternehmen";
  const setTab = (next: SettingsTab, replace = false) =>
    void navigate({ search: (prev) => ({ ...prev, tab: next === "unternehmen" ? undefined : next }), replace });

  const form = useForm<SettingsFormValues, unknown, SettingsUpdate>({
    resolver: zodResolver(settingsUpdateSchema),
    defaultValues: toFormValues(data),
  });
  const { control, formState } = form;
  const dirtyTabs = tabsOfFields(Object.keys(formState.dirtyFields));
  const errorTabs = tabsOfFields(Object.keys(formState.errors));

  const onSubmit = form.handleSubmit(
    (values) =>
      update.mutate(values, {
        onSuccess: (saved) => {
          form.reset(toFormValues(saved));
          toast.success("Einstellungen gespeichert");
        },
        onError: (err) => toast.error(apiErrorMessage(err)),
      }),
    // an invalid field on another tab: go there, so the message is visible
    (errors) => {
      const tabs = tabsOfFields(Object.keys(errors));
      if (tabs.length && !tabs.includes(tab)) setTab(tabs[0]!);
      toast.error("Nicht gespeichert: bitte die markierten Felder prüfen.");
    },
  );

  // old section links (/settings#assistent, #mahnwesen, #prognose, …): open the section's tab, then scroll to it
  useEffect(() => {
    const target = hash ? HASH_TABS[hash] : undefined;
    if (!target) return;
    if (target !== tab) {
      void navigate({ search: (prev) => ({ ...prev, tab: target === "unternehmen" ? undefined : target }), hash, replace: true });
      return;
    }
    requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView({ block: "start" }));
  }, [hash, tab, navigate]);

  const saveBar = (
    <SaveBar
      dirty={formState.isDirty}
      pending={update.isPending}
      otherTabs={dirtyTabs.filter((t) => t !== tab)}
      onDiscard={() => form.reset()}
    />
  );

  return (
    <Page title="Einstellungen" description="Unternehmensdaten, Belege, Mahnwesen, Prognose, Belegerkennung und Assistent.">
      <Tabs value={tab} onValueChange={(v) => setTab(v as SettingsTab)} className="gap-6">
        <TabsList variant="line" className="h-auto w-full max-w-4xl flex-wrap justify-start border-b pb-1">
          {SETTINGS_TABS.map((t) => (
            <TabsTrigger key={t} value={t} className="flex-none px-3">
              {SETTINGS_TAB_LABELS[t]}
              {errorTabs.includes(t) ? (
                <TabDot className="bg-destructive" label="enthält Fehler" />
              ) : dirtyTabs.includes(t) ? (
                <TabDot className="bg-amber-500" label="ungespeicherte Änderungen" />
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>

        {formState.isDirty && !FORM_TABS.includes(tab) && (
          <UnsavedBanner tabs={dirtyTabs} pending={update.isPending} onShow={() => setTab(dirtyTabs[0] ?? "unternehmen")} onSave={() => void onSubmit()} />
        )}

        {/* all tabs stay mounted (hidden when inactive) so unsaved edits survive tab switches */}
        <Form {...form}>
          <TabsContent value="unternehmen" forceMount className={PANEL}>
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

              {saveBar}
            </form>
          </TabsContent>
          <TabsContent value="belege" forceMount className={PANEL}>
            <form onSubmit={onSubmit} className="max-w-4xl">
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

              {saveBar}
            </form>
            <UnitSettingsSection />
          </TabsContent>
        </Form>
        <TabsContent value="mahnwesen" forceMount className={PANEL}>
          <ReminderSettingsSection />
        </TabsContent>
        <TabsContent value="finanzen" forceMount className={PANEL}>
          <ForecastSettingsSection />
        </TabsContent>
        <TabsContent value="belegerkennung" forceMount className={PANEL}>
          <ReceiptSettingsSection />
        </TabsContent>
        <TabsContent value="assistent" forceMount className={PANEL}>
          <ChatSettingsSection />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

/** Inactive panels are hidden, not unmounted; a section's top rule is dropped when it opens its tab. */
const PANEL = "data-[state=inactive]:hidden [&>:first-child]:border-t-0 [&>:first-child]:pt-0";

function TabDot({ className, label }: { className: string; label: string }) {
  return (
    <>
      <span aria-hidden className={cn("size-1.5 rounded-full", className)} />
      <span className="sr-only">({label})</span>
    </>
  );
}

/** Save bar of the main form; it saves the fields of both form tabs, so it names the other tab when that one has edits. */
function SaveBar({
  dirty,
  pending,
  otherTabs,
  onDiscard,
}: {
  dirty: boolean;
  pending: boolean;
  otherTabs: SettingsTab[];
  onDiscard: () => void;
}) {
  return (
    <div className="sticky bottom-0 -mx-8 flex items-center justify-end gap-2 border-t bg-background/90 px-8 py-3 backdrop-blur">
      {dirty && (
        <span className="mr-auto text-xs text-muted-foreground">
          Ungespeicherte Änderungen
          {otherTabs.length > 0 && <> (auch unter {otherTabs.map((t) => `„${SETTINGS_TAB_LABELS[t]}“`).join(" und ")})</>}
        </span>
      )}
      <Button type="button" variant="ghost" disabled={!dirty} onClick={onDiscard}>
        Verwerfen
      </Button>
      <Button type="submit" disabled={!dirty || pending}>
        {pending ? "Speichern…" : "Speichern"}
      </Button>
    </div>
  );
}

/** On the tabs with their own sections: the main form still has unsaved edits. */
function UnsavedBanner({
  tabs,
  pending,
  onShow,
  onSave,
}: {
  tabs: SettingsTab[];
  pending: boolean;
  onShow: () => void;
  onSave: () => void;
}) {
  return (
    <div className="flex max-w-4xl items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm">
      <span className="flex-1">
        Ungespeicherte Änderungen unter {tabs.map((t) => `„${SETTINGS_TAB_LABELS[t]}“`).join(" und ")}.
      </span>
      <Button type="button" variant="ghost" size="sm" onClick={onShow}>
        Anzeigen
      </Button>
      <Button type="button" size="sm" disabled={pending} onClick={onSave}>
        Speichern
      </Button>
    </div>
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
