import { useEffect, useRef, useState } from "react";
import { type Control as RhfControl, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, Copy, Download, Eye, Lock, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { DOCUMENT_TYPE_LABELS, type DocumentType } from "@shared/documents";
import { type DocumentFormData, type DocumentFormValues, documentFormSchema } from "@shared/schemas/document";
import { formatDate } from "@shared/dates";
import { requiresClientUid, TAX_MODE_LABELS, TAX_MODES, type TaxMode, taxNoteFor } from "@shared/tax";
import { Page } from "@/components/page";
import { UnsavedChangesGuard } from "@/components/unsaved-changes-guard";
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
import { Button } from "@/components/ui/button";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ClientPicker } from "@/features/clients/components/ClientPicker";
import { BuyerReferenceField } from "./components/buyer-reference-field";
import {
  apiErrorMessage,
  clientQuery,
  type Document,
  documentFinalizeWarningsQuery,
  documentPdfUrl,
  documentsApi,
  settingsQuery,
  templatesQuery,
  useCreateDocument,
  useDeleteDocument,
  useFinalizeDocument,
  useUpdateDocument,
} from "@/sdk";
import { ActionBar, useDeriveAndOpen } from "./components/action-bar";
import { DocumentRelations } from "./components/document-relations";
import { LineItemsEditor } from "./components/line-items-editor";
import { StatusBadge } from "./components/status-badge";
import { TotalsPanel } from "./components/totals-panel";
import { cityLine, DOC_CONFIG, docLink } from "./config";

export function toFormValues(doc: Document): DocumentFormValues {
  return {
    clientId: doc.clientId,
    issueDate: doc.issueDate,
    servicePeriodStart: doc.servicePeriodStart,
    servicePeriodEnd: doc.servicePeriodEnd,
    dueDate: doc.dueDate,
    validUntil: doc.validUntil,
    taxMode: doc.taxMode,
    title: doc.title,
    introText: doc.introText,
    closingText: doc.closingText,
    templateId: doc.templateId,
    buyerReference: doc.buyerReference,
    items: doc.items.map(({ articleId, title, description, quantity, unit, unitPriceCents, taxRateBp, discountBp }) => ({
      articleId,
      title,
      description,
      quantity,
      unit,
      unitPriceCents,
      taxRateBp,
      discountBp,
    })),
  };
}

/**
 * Editor for a draft. `doc` undefined = new, unsaved document (created on first save).
 * Keyboard: ⌘/Ctrl+S saves.
 */
export function DocumentEditor({
  type,
  doc,
  initialValues,
}: {
  type: DocumentType;
  doc?: Document;
  initialValues: DocumentFormValues;
}) {
  const config = DOC_CONFIG[type];
  const navigate = useNavigate();
  const create = useCreateDocument();
  const update = useUpdateDocument();
  const finalize = useFinalizeDocument();
  const remove = useDeleteDocument();
  const derive = useDeriveAndOpen();
  const { data: settings } = useQuery(settingsQuery);
  const { data: allTemplates } = useQuery(templatesQuery);
  const templates = (allTemplates ?? []).filter((t) => t.docType === type);
  const queryClient = useQueryClient();
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  /** the draft as saved for the finalize dialog, plus the server's non-blocking hints for it */
  const [finalizing, setFinalizing] = useState<{ saved: Document; warnings: string[] } | null>(null);
  const [checking, setChecking] = useState(false);
  const finalizeStarted = useRef(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const form = useForm<DocumentFormValues, unknown, DocumentFormData>({
    resolver: zodResolver(documentFormSchema),
    defaultValues: initialValues,
  });
  const { control, formState } = form;
  const [clientId, taxMode, items] = useWatch({ control, name: ["clientId", "taxMode", "items"] });
  const client = useQuery({ ...clientQuery(clientId), enabled: clientId > 0 });

  // Leaving with unsaved changes asks first (<UnsavedChangesGuard> below); set before navigating away on purpose.
  const leaving = useRef(false);

  const busy = create.isPending || update.isPending || finalize.isPending || remove.isPending || checking;

  /** Save if new or dirty. Resolves to the saved document, or null on validation/API error. */
  const save = (): Promise<Document | null> => {
    if (doc && !formState.isDirty) return Promise.resolve(doc);
    return new Promise((resolve) => {
      void form.handleSubmit(
        async (values) => {
          try {
            const saved = doc
              ? await update.mutateAsync({ id: doc.id, json: values })
              : await create.mutateAsync({ type, ...values });
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

  const openDetail = (saved: Document) => {
    if (doc?.id === saved.id) return;
    leaving.current = true;
    void navigate({ ...docLink(type, saved.id), replace: true });
  };

  const onSave = async () => {
    const saved = await save();
    if (!saved) return;
    toast.success(`${config.singular} gespeichert`);
    openDetail(saved);
  };

  /**
   * Validate before asking the irreversible question: the form schema plus the server's finalize checks
   * (client, at least one line, line titles, UID for reverse charge, service period). Errors show on the fields.
   * Then the draft is saved and the server's non-blocking hints (finalize-warnings) go into the dialog.
   */
  const requestFinalize = async () => {
    const valid = await form.trigger(undefined, { shouldFocus: true });
    const values = form.getValues();
    const issues = finalizeIssues(values, { clientUid: client.data?.uid });
    for (const issue of issues) {
      if (issue.name) form.setError(issue.name, { type: "finalize", message: issue.message });
    }
    if (!valid || issues.length > 0) {
      const named = issues.find((i) => i.name);
      if (valid && named?.name) form.setFocus(named.name);
      toast.error(issues.find((i) => !i.name)?.message ?? "Bitte Eingaben prüfen");
      return;
    }
    setChecking(true);
    try {
      const saved = await save();
      if (!saved) return;
      // the hints are advice only: if they can't be loaded, finalizing is still possible
      const warnings = await queryClient
        .fetchQuery(documentFinalizeWarningsQuery(saved.id))
        .then((r) => r.warnings)
        .catch(() => []);
      finalizeStarted.current = false;
      setFinalizing({ saved, warnings });
      setConfirmFinalize(true);
    } finally {
      setChecking(false);
    }
  };

  /** Dialog closed without finalizing: a new draft was saved meanwhile, so continue on its own page. */
  const onFinalizeDialogChange = (open: boolean) => {
    setConfirmFinalize(open);
    if (!open && finalizing && !finalizeStarted.current) openDetail(finalizing.saved);
  };

  // finalize errors (set by hand above) disappear as soon as their cause is fixed
  useEffect(() => {
    const sub = form.watch((values) => {
      const open = new Set(finalizeIssues(values as DocumentFormValues, {}).map((i) => i.name));
      const { errors } = form.formState;
      const stale: FinalizeField[] = [];
      if (errors.servicePeriodEnd?.type === "finalize" && !open.has("servicePeriodEnd")) stale.push("servicePeriodEnd");
      (values.items ?? []).forEach((_, i) => {
        const name = `items.${i}.title` as const;
        if (errors.items?.[i]?.title?.type === "finalize" && !open.has(name)) stale.push(name);
      });
      if (stale.length > 0) form.clearErrors(stale);
    });
    return () => sub.unsubscribe();
  }, [form]);

  const onFinalize = async () => {
    finalizeStarted.current = true;
    setConfirmFinalize(false);
    const saved = finalizing && !formState.isDirty ? finalizing.saved : await save();
    setFinalizing(null);
    if (!saved) return;
    finalize.mutate(saved.id, {
      onSuccess: (final) => {
        toast.success(`${config.singular} ${final.number} finalisiert`);
        openDetail(final);
      },
      onError: (err) => {
        toast.error(apiErrorMessage(err));
        openDetail(saved);
      },
    });
  };

  const onPdf = async (download: boolean) => {
    // Open the tab synchronously so the popup blocker allows it, then point it at the PDF after saving.
    const win = download ? null : window.open("", "_blank");
    const saved = await save();
    if (!saved) {
      win?.close();
      return;
    }
    if (win) win.location.href = documentPdfUrl(saved.id);
    else window.location.assign(documentPdfUrl(saved.id, true));
    openDetail(saved);
  };

  const onDelete = () => {
    if (!doc) return;
    remove.mutate(doc.id, {
      onSuccess: () => {
        toast.success("Entwurf gelöscht");
        leaving.current = true;
        void navigate({ to: config.list });
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

  /** Re-derive tax mode (on client change, or when a new date has another Kleinunternehmer status) and
   *  due/valid-until dates from client + settings. */
  const applyDefaults = async (opts: { clientId: number; issueDate: string; taxMode: boolean }) => {
    try {
      const d = await documentsApi.defaults(type, opts.clientId || undefined, opts.issueDate);
      const current = form.getValues("taxMode");
      // Steuerstatus at the new date doesn't fit the mode (e.g. Kleinunternehmer mode, but regular from that day)
      const statusMismatch = (current === "SMALL_BUSINESS" && !d.smallBusiness) || (current === "AT_DOMESTIC" && d.smallBusiness);
      if (opts.taxMode || (statusMismatch && d.taxMode !== current)) form.setValue("taxMode", d.taxMode, { shouldDirty: true });
      if (!opts.taxMode && statusMismatch && d.taxMode !== current) {
        toast.info(`Steuermodus an den Steuerstatus am ${formatDate(opts.issueDate)} angepasst: ${TAX_MODE_LABELS[d.taxMode]}`);
      }
      if (type === "invoice") form.setValue("dueDate", d.dueDate, { shouldDirty: true });
      if (type === "offer") form.setValue("validUntil", d.validUntil, { shouldDirty: true });
    } catch (err) {
      toast.error(apiErrorMessage(err));
    }
  };

  const taxNote = settings ? taxNoteFor(taxMode, settings) : null;
  const missingUid = requiresClientUid(taxMode) && client.data && !client.data.uid.trim();
  const c = client.data;

  return (
    <Page
      title={
        <span className="flex items-center gap-3">
          {doc ? config.singular : config.newLabel}
          {doc && <StatusBadge status={doc.status} />}
        </span>
      }
      description={doc && <DocumentRelations doc={doc} />}
    >
      <UnsavedChangesGuard when={formState.isDirty} shouldBlock={() => !leaving.current} />
      <Form {...form}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onSave();
          }}
        >
          <section className="grid gap-x-10 gap-y-5 border-b pb-8 md:grid-cols-2">
            <div className="grid content-start gap-4">
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
                        if (picked) {
                          void applyDefaults({ clientId: picked.id, issueDate: form.getValues("issueDate"), taxMode: true });
                        }
                      }}
                    />
                    <FormMessage />
                  </FormItem>
                )}
              />
              {c && (
                <div className="-mt-1 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                  {c.contactPerson && <div>{c.contactPerson}</div>}
                  {c.street && <div>{c.street}</div>}
                  {c.addressExtra && <div>{c.addressExtra}</div>}
                  <div>
                    {cityLine(c)}
                  </div>
                  {c.uid && <div className="tabular">UID: {c.uid}</div>}
                </div>
              )}
              <FormField
                control={control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Betreff</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder={`z. B. ${config.singular} Webdesign`} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {c && type !== "offer" && <BuyerReferenceField control={control} client={c} />}
            </div>

            <div className="grid content-start gap-4">
              <div className="grid grid-cols-2 gap-4">
                <DateField
                  control={control}
                  name="issueDate"
                  label={`${config.singular}sdatum`}
                  onCommit={(issueDate) => {
                    if (issueDate && type !== "credit_note") {
                      void applyDefaults({ clientId: form.getValues("clientId"), issueDate, taxMode: false });
                    }
                  }}
                />
                {type === "invoice" && <DateField control={control} name="dueDate" label="Fällig am" />}
                {type === "offer" && <DateField control={control} name="validUntil" label="Gültig bis" />}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <DateField control={control} name="servicePeriodStart" label="Leistung von" />
                <DateField control={control} name="servicePeriodEnd" label="Leistung bis" />
              </div>
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
                    <FormMessage />
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
                              {t.isDefault ? " (Standard)" : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
              )}
            </div>
          </section>

          <section className="border-b py-6">
            <TextBlock control={control} name="introText" label="Einleitung" />
          </section>

          <section className="py-6">
            <LineItemsEditor control={control} taxMode={taxMode} />
            <div className="mt-6 flex justify-end">
              <TotalsPanel items={items ?? []} taxMode={taxMode} />
            </div>
          </section>

          <section className="border-t pt-6">
            <TextBlock control={control} name="closingText" label="Schlusstext" />
          </section>

          <ActionBar
            left={
              doc && (
                <>
                  <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}>
                    <Trash2 />
                    Löschen
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy || derive.isPending}
                    onClick={() => derive.run(doc, "duplicate")}
                  >
                    <Copy />
                    Duplizieren
                  </Button>
                </>
              )
            }
          >
            <span className="mr-2 text-xs text-muted-foreground">
              {formState.isDirty ? "Ungespeicherte Änderungen" : doc ? "Gespeichert" : ""}
            </span>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void onPdf(false)}>
              <Eye />
              Vorschau
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void onPdf(true)}>
              <Download />
              PDF
            </Button>
            <Button type="submit" variant="outline" size="sm" disabled={busy}>
              Speichern
              <kbd className="ml-1 text-[10px] text-muted-foreground">⌘S</kbd>
            </Button>
            <Button type="button" size="sm" disabled={busy} onClick={() => void requestFinalize()}>
              <Lock />
              Finalisieren
            </Button>
          </ActionBar>
        </form>
      </Form>

      <AlertDialog open={confirmFinalize} onOpenChange={onFinalizeDialogChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{DOCUMENT_TYPE_LABELS[type]} finalisieren?</AlertDialogTitle>
            <AlertDialogDescription>
              Der Beleg erhält eine fortlaufende Nummer und kann danach nicht mehr bearbeitet oder gelöscht werden.
              {type === "invoice" && " Korrekturen sind nur noch über eine Gutschrift möglich."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {finalizing && finalizing.warnings.length > 0 && (
            <div className="grid gap-2 rounded-md border border-warning-border bg-warning-muted p-3 text-sm text-warning" role="note">
              <p className="flex items-center gap-2 font-medium">
                <AlertTriangle className="size-4 shrink-0" />
                Bitte vor dem Finalisieren prüfen
              </p>
              <ul className="grid gap-1.5 pl-6">
                {finalizing.warnings.map((w) => (
                  <li key={w} className="list-disc">
                    {w}
                  </li>
                ))}
              </ul>
              <p className="text-xs">Sie können trotzdem finalisieren.</p>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onFinalize()}>Finalisieren</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Entwurf löschen?</AlertDialogTitle>
            <AlertDialogDescription>Der Entwurf wird endgültig gelöscht.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onDelete}>
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

type Control = RhfControl<DocumentFormValues, unknown, DocumentFormData>;
type FinalizeField = "servicePeriodEnd" | `items.${number}.title`;

/** The server's finalize checks (services/documents.ts finalizeDocument) that the form schema doesn't cover. */
function finalizeIssues(
  values: DocumentFormValues,
  opts: { clientUid?: string },
): { name?: FinalizeField; message: string }[] {
  const issues: { name?: FinalizeField; message: string }[] = [];
  const items = values.items ?? [];
  if (items.length === 0) issues.push({ message: "Mindestens eine Position ist erforderlich" });
  items.forEach((item, i) => {
    if (!item?.title?.trim()) issues.push({ name: `items.${i}.title`, message: "Bezeichnung fehlt" });
  });
  if (requiresClientUid(values.taxMode) && opts.clientUid !== undefined && !opts.clientUid.trim()) {
    issues.push({ message: "Reverse Charge erfordert eine UID-Nummer beim Kunden" });
  }
  if (values.servicePeriodStart && values.servicePeriodEnd && values.servicePeriodEnd < values.servicePeriodStart) {
    issues.push({ name: "servicePeriodEnd", message: "Ende liegt vor dem Beginn" });
  }
  return issues;
}
type DateName = "issueDate" | "dueDate" | "validUntil" | "servicePeriodStart" | "servicePeriodEnd";

function DateField({
  control,
  name,
  label,
  onCommit,
}: {
  control: Control;
  name: DateName;
  label: string;
  onCommit?: (value: string) => void;
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
              value={field.value ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                field.onChange(name === "issueDate" ? v : v || null);
                onCommit?.(v);
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

function TextBlock({ control, name, label }: { control: Control; name: "introText" | "closingText"; label: string }) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel className="text-xs text-muted-foreground">{label}</FormLabel>
          <FormControl>
            <Textarea {...field} rows={2} className="min-h-14" />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
