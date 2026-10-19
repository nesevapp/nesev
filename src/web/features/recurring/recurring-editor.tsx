import { useEffect, useRef, useState } from "react";
import { type Control, useForm, useFormContext, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, FilePlus2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { formatDate, todayIso } from "@shared/dates";
import { formatCents } from "@shared/money";
import { coveredPeriod, INTERVAL_PRESETS, intervalLabel, runDatesUntil } from "@shared/recurring";
import { type RecurringFormData, type RecurringFormValues, recurringFormSchemaChecked } from "@shared/schemas/recurring";
import { requiresClientUid, TAX_MODE_LABELS, TAX_MODES, type TaxMode, taxNoteFor } from "@shared/tax";
import { Page } from "@/components/page";
import { SwitchField, TextareaField, TextField } from "@/components/form-fields";
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
import { UnsavedChangesGuard } from "@/components/unsaved-changes-guard";
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClientPicker } from "@/features/clients/components/ClientPicker";
import { ActionBar } from "@/features/documents/components/action-bar";
import { LineItemsEditor } from "@/features/documents/components/line-items-editor";
import { StatusBadge } from "@/features/documents/components/status-badge";
import { TotalsPanel } from "@/features/documents/components/totals-panel";
import { docLink } from "@/features/documents/config";
import {
  apiErrorMessage,
  clientQuery,
  documentsApi,
  type Recurring,
  settingsQuery,
  templatesQuery,
  useCreateRecurring,
  useDeleteRecurring,
  useGenerateRecurringNow,
  useUpdateRecurring,
} from "@/sdk";
import { reportGenerated, scheduleState } from "./recurring-list-page";

type FormControl_ = Control<RecurringFormValues, unknown, RecurringFormData>;

export function toFormValues(r: Recurring): RecurringFormValues {
  return {
    name: r.name,
    clientId: r.clientId,
    active: r.active,
    intervalUnit: r.intervalUnit,
    intervalCount: r.intervalCount,
    startDate: r.startDate,
    endDate: r.endDate,
    nextRunDate: r.nextRunDate,
    setServicePeriod: r.setServicePeriod,
    autoFinalize: r.autoFinalize,
    taxMode: r.taxMode,
    title: r.title,
    introText: r.introText,
    closingText: r.closingText,
    templateId: r.templateId,
    items: r.items.map(({ id: _id, recurringInvoiceId: _r, position: _p, ...item }) => item),
  };
}

export function RecurringEditor({ recurring, initialValues }: { recurring?: Recurring; initialValues: RecurringFormValues }) {
  const navigate = useNavigate();
  const create = useCreateRecurring();
  const update = useUpdateRecurring();
  const remove = useDeleteRecurring();
  const generate = useGenerateRecurringNow();
  const { data: settings } = useQuery(settingsQuery);
  const { data: allTemplates } = useQuery(templatesQuery);
  const templates = (allTemplates ?? []).filter((t) => t.docType === "invoice");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmGenerate, setConfirmGenerate] = useState(false);

  const form = useForm<RecurringFormValues, unknown, RecurringFormData>({
    resolver: zodResolver(recurringFormSchemaChecked),
    defaultValues: initialValues,
  });
  const { control, formState } = form;
  const values = useWatch({ control }) as RecurringFormValues;
  const client = useQuery({ ...clientQuery(values.clientId), enabled: values.clientId > 0 });

  const leaving = useRef(false);

  const busy = create.isPending || update.isPending || remove.isPending || generate.isPending;

  const save = (): Promise<Recurring | null> => {
    if (recurring && !formState.isDirty) return Promise.resolve(recurring);
    return new Promise((resolve) => {
      void form.handleSubmit(
        async (data) => {
          try {
            const saved = recurring
              ? await update.mutateAsync({ id: recurring.id, json: data })
              : await create.mutateAsync(data);
            form.reset(toFormValues(saved));
            resolve(saved);
          } catch (err) {
            toast.error(apiErrorMessage(err));
            resolve(null);
          }
        },
        () => {
          toast.error("Bitte Eingaben prüfen");
          resolve(null);
        },
      )();
    });
  };

  const onSave = async () => {
    const saved = await save();
    if (!saved) return;
    toast.success("Serienrechnung gespeichert");
    if (!recurring) {
      leaving.current = true;
      void navigate({ to: "/recurring/$id", params: { id: saved.id }, replace: true });
    }
  };

  const onGenerate = async () => {
    setConfirmGenerate(false);
    const saved = await save();
    if (!saved) return;
    generate.mutate(saved.id, {
      onSuccess: (created) => {
        reportGenerated([created]);
        form.resetField("nextRunDate");
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    });
  };

  // After "Rechnung jetzt erstellen" the server advanced nextRunDate; take it over unless edited.
  useEffect(() => {
    if (recurring && !form.getFieldState("nextRunDate").isDirty) {
      form.resetField("nextRunDate", { defaultValue: recurring.nextRunDate });
    }
  }, [recurring?.nextRunDate]); // eslint-disable-line react-hooks/exhaustive-deps

  const onDelete = () => {
    if (!recurring) return;
    remove.mutate(recurring.id, {
      onSuccess: () => {
        toast.success("Serienrechnung gelöscht");
        leaving.current = true;
        void navigate({ to: "/recurring" });
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    });
  };

  // ⌘/Ctrl+S
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onClientPicked = async (picked: { id: number; name: string }) => {
    if (!form.getValues("name").trim()) form.setValue("name", picked.name, { shouldDirty: true });
    try {
      const d = await documentsApi.defaults("invoice", picked.id);
      form.setValue("taxMode", d.taxMode, { shouldDirty: true });
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  const taxMode = values.taxMode;
  const taxNote = settings ? taxNoteFor(taxMode, settings) : null;
  const missingUid = requiresClientUid(taxMode) && client.data && !client.data.uid.trim();
  const today = todayIso();
  const state = recurring ? scheduleState(recurring, today) : null;

  return (
    <Page
      title={recurring ? recurring.name : "Neue Serienrechnung"}
      description={
        recurring && (
          <>
            {intervalLabel(recurring)} · {recurring.clientName}
            {state === "ended" && " · beendet"}
            {state === "paused" && " · pausiert"}
          </>
        )
      }
      actions={
        recurring && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy || state === "ended"}
            onClick={() => setConfirmGenerate(true)}
          >
            <FilePlus2 />
            Rechnung jetzt erstellen
          </Button>
        )
      }
    >
      <Form {...form}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onSave();
          }}
        >
          <section className="grid gap-x-10 gap-y-5 border-b pb-8 md:grid-cols-2">
            <div className="grid content-start gap-4">
              <TextField control={control} name="name" label="Name" placeholder="z. B. Hosting Alpen AG" />
              <FormField
                control={control}
                name="clientId"
                render={({ field, fieldState }) => (
                  <FormItem>
                    <FormLabel>Kunde</FormLabel>
                    <ClientPicker
                      value={field.value || undefined}
                      aria-invalid={!!fieldState.error}
                      onChange={(picked) => {
                        field.onChange(picked?.id ?? 0);
                        if (picked) void onClientPicked(picked);
                      }}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <TextField control={control} name="title" label="Betreff der Rechnungen" placeholder="z. B. Webhosting" />
              <FormField
                control={control}
                name="taxMode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Steuermodus</FormLabel>
                    <Select value={field.value} onValueChange={(v) => field.onChange(v as TaxMode)}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {TAX_MODES.map((m) => (
                          <SelectItem key={m} value={m}>
                            {TAX_MODE_LABELS[m]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {taxNote && <p className="text-xs text-muted-foreground">Hinweis auf dem Beleg: „{taxNote}“</p>}
                    {missingUid && (
                      <p className="flex items-center gap-1.5 text-xs text-warning">
                        <AlertTriangle className="size-3.5" />
                        Kunde hat keine UID-Nummer – Reverse Charge kann so nicht finalisiert werden.
                      </p>
                    )}
                  </FormItem>
                )}
              />
              {templates.length > 1 && (
                <FormField
                  control={control}
                  name="templateId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>PDF-Vorlage</FormLabel>
                      <Select
                        value={field.value ? String(field.value) : "default"}
                        onValueChange={(v) => field.onChange(v === "default" ? null : Number(v))}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="default">Standardvorlage</SelectItem>
                          {templates.map((t) => (
                            <SelectItem key={t.id} value={String(t.id)}>
                              {t.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
              )}
              <SwitchField
                control={control}
                name="setServicePeriod"
                label="Leistungszeitraum setzen"
                description="Jede Rechnung erhält den abgerechneten Zeitraum, z. B. 01.11.–30.11."
              />
              <SwitchField
                control={control}
                name="autoFinalize"
                label="Automatisch finalisieren"
                description="Rechnungen erhalten sofort eine Nummer und ein PDF. Aus: Sie werden als Entwurf zur Prüfung angelegt."
              />
              <SwitchField control={control} name="active" label="Aktiv" description="Pausierte Serien erstellen keine Rechnungen." />
            </div>

            <div className="grid content-start gap-4">
              <IntervalField control={control} />
              <div className="grid grid-cols-2 gap-4">
                <DateField
                  control={control}
                  name="startDate"
                  label="Erste Rechnung am"
                  onCommit={(v, prev) => {
                    // new schedule: the next run follows the start date until edited separately
                    if (v && (!recurring || form.getValues("nextRunDate") === prev)) {
                      form.setValue("nextRunDate", v, { shouldDirty: true });
                    }
                  }}
                />
                <DateField control={control} name="endDate" label="Endet am" placeholder="unbefristet" />
              </div>
              <DateField control={control} name="nextRunDate" label="Nächste Rechnung am" />
              <SchedulePreview values={values} today={today} />
            </div>
          </section>

          <section className="border-b py-6">
            <TextareaField control={control} name="introText" label="Einleitung" rows={2} className="[&_label]:text-xs [&_label]:text-muted-foreground" />
          </section>

          <section className="py-6">
            <LineItemsEditor control={control} taxMode={taxMode} />
            <div className="mt-6 flex justify-end">
              <TotalsPanel items={values.items ?? []} taxMode={taxMode} taxNote={taxNote} />
            </div>
          </section>

          <section className="border-t pt-6">
            <TextareaField control={control} name="closingText" label="Schlusstext" rows={2} className="[&_label]:text-xs [&_label]:text-muted-foreground" />
          </section>

          {recurring && <GeneratedInvoices recurring={recurring} />}

          <ActionBar
            left={
              recurring && (
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}>
                  <Trash2 />
                  Löschen
                </Button>
              )
            }
          >
            <span className="mr-2 text-xs text-muted-foreground">
              {formState.isDirty ? "Ungespeicherte Änderungen" : recurring ? "Gespeichert" : ""}
            </span>
            <Button type="submit" size="sm" disabled={busy}>
              Speichern
              <kbd className="ml-1 text-[10px] opacity-70">⌘S</kbd>
            </Button>
          </ActionBar>
        </form>
      </Form>

      <AlertDialog open={confirmGenerate} onOpenChange={setConfirmGenerate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rechnung jetzt erstellen?</AlertDialogTitle>
            <AlertDialogDescription>
              Die für den {formatDate(recurring?.nextRunDate)} geplante Rechnung wird sofort erstellt
              {recurring?.autoFinalize ? " und finalisiert" : " (als Entwurf)"}. Die nächste Ausführung verschiebt sich
              um ein Intervall.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onGenerate()}>Erstellen</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Serienrechnung löschen?</AlertDialogTitle>
            <AlertDialogDescription>
              Es werden keine weiteren Rechnungen erstellt. Bereits erstellte Rechnungen bleiben erhalten.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onDelete}>
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <UnsavedChangesGuard when={formState.isDirty} shouldBlock={() => !leaving.current} />
    </Page>
  );
}

function IntervalField({ control }: { control: FormControl_ }) {
  const { setValue } = useFormContext<RecurringFormValues, unknown, RecurringFormData>();
  const [unit, count] = useWatch({ control, name: ["intervalUnit", "intervalCount"] });
  const preset = INTERVAL_PRESETS.find((p) => p.interval.intervalUnit === unit && p.interval.intervalCount === count);
  const [custom, setCustom] = useState(!preset);
  return (
    <FormField
      control={control}
      name="intervalCount"
      render={({ field }) => (
        <FormItem>
          <FormLabel>Intervall</FormLabel>
          <div className="flex gap-2">
            <Select
              value={custom || !preset ? "custom" : preset.key}
              onValueChange={(key) => {
                const p = INTERVAL_PRESETS.find((x) => x.key === key);
                setCustom(!p);
                if (p) {
                  field.onChange(p.interval.intervalCount);
                  setValue("intervalUnit", p.interval.intervalUnit, { shouldDirty: true });
                }
              }}
            >
              <FormControl>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {INTERVAL_PRESETS.map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    {p.label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Benutzerdefiniert …</SelectItem>
              </SelectContent>
            </Select>
            {(custom || !preset) && (
              <>
                <span className="self-center text-sm text-muted-foreground">alle</span>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  className="w-20 tabular"
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value === "" ? 1 : Number(e.target.value))}
                  aria-label="Anzahl"
                />
                <FormField
                  control={control}
                  name="intervalUnit"
                  render={({ field: unitField }) => (
                    <Select value={unitField.value} onValueChange={unitField.onChange}>
                      <SelectTrigger className="w-32" aria-label="Einheit">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="month">Monate</SelectItem>
                        <SelectItem value="year">Jahre</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </>
            )}
          </div>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** Next runs (with service periods) and a hint about periods that are already due. */
function SchedulePreview({ values, today }: { values: RecurringFormValues; today: string }) {
  const { startDate, endDate, nextRunDate, intervalUnit, intervalCount } = values;
  if (!startDate || !nextRunDate || !intervalCount || intervalCount < 1) return null;
  const r = { startDate, endDate: endDate ?? null, intervalUnit, intervalCount };
  const due = nextRunDate <= today ? runDatesUntil(r, nextRunDate, today) : [];
  const upcoming = runDatesUntil(r, nextRunDate, "9999-12-31", due.length + 3).slice(due.length);
  if (!due.length && !upcoming.length) {
    return <p className="text-xs text-muted-foreground">Keine weiteren Rechnungen – das Enddatum ist erreicht.</p>;
  }
  return (
    <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      {due.length > 0 && (
        <p className="mb-1.5 flex items-start gap-1.5 text-warning">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          {due.length === 1 ? "1 Rechnung ist" : `${due.length} Rechnungen sind`} bereits fällig (ab {formatDate(due[0])}) und
          {due.length === 1 ? " wird" : " werden"} bei der nächsten Ausführung erstellt – stündlich oder über „Jetzt
          ausführen“.
        </p>
      )}
      {upcoming.length > 0 && (
        <>
          <div className="mb-0.5">{due.length ? "Danach:" : "Nächste Termine:"}</div>
          <ul className="space-y-0.5 tabular">
            {upcoming.map((d) => {
              const p = coveredPeriod(d, startDate, r);
              return (
                <li key={d}>
                  {formatDate(d)}
                  {values.setServicePeriod && (
                    <span className="text-muted-foreground/70">
                      {" "}
                      · Leistung {formatDate(p.start)}–{formatDate(p.end)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

function GeneratedInvoices({ recurring }: { recurring: Recurring }) {
  return (
    <section className="border-t py-8">
      <h2 className="mb-3 text-sm font-medium">
        Erstellte Rechnungen <span className="font-normal text-muted-foreground">({recurring.invoices.length})</span>
      </h2>
      {recurring.invoices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Noch keine. Die erste Rechnung wird am {formatDate(recurring.nextRunDate)} erstellt.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Nummer</TableHead>
              <TableHead>Datum</TableHead>
              <TableHead>Leistungszeitraum</TableHead>
              <TableHead>Fällig</TableHead>
              <TableHead className="text-right">Brutto</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {recurring.invoices.map((d) => (
              <TableRow key={d.id}>
                <TableCell>
                  <Link {...docLink("invoice", d.id)} className="font-medium tabular underline-offset-4 hover:underline">
                    {d.number ?? "Entwurf"}
                  </Link>
                </TableCell>
                <TableCell className="tabular">{formatDate(d.issueDate)}</TableCell>
                <TableCell className="tabular text-muted-foreground">
                  {d.servicePeriodStart ? `${formatDate(d.servicePeriodStart)}–${formatDate(d.servicePeriodEnd)}` : "–"}
                </TableCell>
                <TableCell className={d.overdue ? "tabular text-danger" : "tabular"}>{formatDate(d.dueDate)}</TableCell>
                <TableCell className="text-right tabular">{formatCents(d.grossCents)}</TableCell>
                <TableCell>
                  <StatusBadge status={d.status} overdue={d.overdue} />
                  {d.paidAt && <span className="ml-2 text-xs text-muted-foreground tabular">{formatDate(d.paidAt)}</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

type DateName = "startDate" | "endDate" | "nextRunDate";

function DateField({
  control,
  name,
  label,
  placeholder,
  onCommit,
}: {
  control: FormControl_;
  name: DateName;
  label: string;
  placeholder?: string;
  onCommit?: (value: string, previous: string | null | undefined) => void;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type="date"
              {...field}
              placeholder={placeholder}
              value={field.value ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                const prev = field.value;
                field.onChange(name === "endDate" ? v || null : v);
                onCommit?.(v, prev);
              }}
              className="tabular"
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** Default values for a new recurring invoice. */
export function newRecurringValues(defaults: { taxMode: TaxMode; introText: string; closingText: string }, clientId = 0): RecurringFormValues {
  const today = todayIso();
  return {
    name: "",
    clientId,
    active: true,
    intervalUnit: "month",
    intervalCount: 1,
    startDate: today,
    endDate: null,
    nextRunDate: today,
    setServicePeriod: true,
    autoFinalize: false,
    taxMode: defaults.taxMode,
    title: "",
    introText: defaults.introText,
    closingText: defaults.closingText,
    templateId: null,
    items: [],
  };
}

