import { type ReactNode, useEffect, useRef, useState } from "react";
import { type Control, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { Calculator, CheckCircle2, Download, Eye, Lock, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { addDays, formatDate } from "@shared/dates";
import { formatBp, formatCents } from "@shared/money";
import {
  calcInterestCents,
  daysBetween,
  levelConfig,
  fillPlaceholders,
  REMINDER_PLACEHOLDERS,
  REMINDER_TAX_NOTE,
  reminderPlaceholderValues,
  reminderTotalCents,
} from "@shared/reminders";
import { type ReminderUpdate, reminderUpdateSchema } from "@shared/schemas/reminder";
import type { z } from "@shared/schemas/zod";
import { Page } from "@/components/page";
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
import { ActionBar } from "@/features/documents/components/action-bar";
import { CODECS, NumericInput } from "@/features/documents/components/numeric-input";
import {
  apiErrorMessage,
  type Reminder,
  reminderPdfUrl,
  reminderQuery,
  reminderSettingsQuery,
  templatesQuery,
  useDeleteReminder,
  useFinalizeReminder,
  useMarkReminderSent,
  useUpdateReminder,
} from "@/sdk";
import { LevelBadge, ReminderStatusBadge } from "./components/reminder-status-badge";

type FormValues = z.input<typeof reminderUpdateSchema>;
const DEFAULT_TEMPLATE = "default";

function toFormValues(r: Reminder): FormValues {
  return {
    level: r.level,
    issueDate: r.issueDate,
    dueDate: r.dueDate,
    feeCents: r.feeCents,
    interestCents: r.interestCents,
    title: r.title,
    introText: r.introText,
    closingText: r.closingText,
    templateId: r.templateId,
  };
}

/** /reminders/$id: drafts open in the editor, finalized reminders read-only. */
export function ReminderPage({ id }: { id: number }) {
  const { data: reminder } = useSuspenseQuery(reminderQuery(id));
  return reminder.status === "draft" ? <ReminderEditor key={reminder.id} reminder={reminder} /> : <ReminderView reminder={reminder} />;
}

function Title({ reminder }: { reminder: Reminder }) {
  return (
    <span className="flex items-center gap-3">
      {reminder.title || "Mahnung"} <span className="tabular">{reminder.number ?? ""}</span>
      <ReminderStatusBadge status={reminder.status} settled={reminder.settled} />
    </span>
  );
}

function Description({ reminder }: { reminder: Reminder }) {
  const { invoice } = reminder;
  return (
    <span>
      Zu{" "}
      <Link to="/invoices/$id" params={{ id: invoice.id }} className="text-foreground underline-offset-4 hover:underline">
        Rechnung {invoice.number}
      </Link>{" "}
      · {reminder.clientName}
      {reminder.siblings.length > 0 && (
        <>
          {" "}
          · Weitere:{" "}
          {reminder.siblings.map((s, i) => (
            <span key={s.id}>
              {i > 0 && ", "}
              <Link to="/reminders/$id" params={{ id: s.id }} className="text-foreground underline-offset-4 hover:underline">
                {s.number ?? `Entwurf Stufe ${s.level}`}
              </Link>
            </span>
          ))}
        </>
      )}
    </span>
  );
}

function SettledNotice({ reminder }: { reminder: Reminder }) {
  if (!reminder.settled) return null;
  return (
    <div className="mb-6 flex items-center gap-2 rounded-lg border border-success-border bg-success-muted px-4 py-3 text-sm text-success">
      <CheckCircle2 className="size-4" />
      Rechnung {reminder.invoice.number} wurde
      {reminder.invoice.paidAt ? ` am ${formatDate(reminder.invoice.paidAt)}` : ""} bezahlt – das Mahnverfahren ist erledigt.
    </div>
  );
}

/** Invoice facts + amount summary (right column). */
function AmountPanel({
  reminder,
  feeCents,
  interestCents,
  issueDate,
}: {
  reminder: Reminder;
  feeCents: number;
  interestCents: number;
  issueDate: string;
}) {
  const { invoice } = reminder;
  const total = reminderTotalCents({ openCents: reminder.openCents, feeCents, interestCents });
  const daysOverdue = invoice.dueDate ? Math.max(0, daysBetween(invoice.dueDate, issueDate)) : 0;
  return (
    <div className="grid content-start gap-4 text-sm">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5">
        <Meta label="Rechnungsdatum" value={formatDate(invoice.issueDate)} />
        <Meta label="Ursprünglich fällig" value={formatDate(invoice.dueDate)} />
        <Meta label="Tage überfällig" value={String(daysOverdue)} />
        <Meta label="Rechnungsbetrag" value={formatCents(invoice.grossCents)} />
      </dl>
      <div className="rounded-lg border bg-muted/30 p-4">
        <Row label="Offener Rechnungsbetrag" value={formatCents(reminder.openCents)} />
        <Row label="Mahnspesen" value={formatCents(feeCents)} />
        <Row label="Verzugszinsen" value={formatCents(interestCents)} />
        <div className="mt-2 flex justify-between border-t pt-2 font-semibold">
          <span>Zu zahlen</span>
          <span className="tabular">{formatCents(total)}</span>
        </div>
        {(feeCents > 0 || interestCents > 0) && <p className="mt-2 text-xs text-muted-foreground">{REMINDER_TAX_NOTE}</p>}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular">{value}</span>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular">{value || "–"}</dd>
    </>
  );
}

// ── Read-only view ──────────────────────────────────────────────────────────────

function ReminderView({ reminder }: { reminder: Reminder }) {
  const markSent = useMarkReminderSent();
  const values = reminderPlaceholderValues(reminder, reminder.invoice, reminder.clientName);
  return (
    <Page title={<Title reminder={reminder} />} description={<Description reminder={reminder} />}>
      <SettledNotice reminder={reminder} />
      <section className="grid gap-x-10 gap-y-6 border-b pb-8 md:grid-cols-2">
        <dl className="grid grid-cols-[max-content_1fr] content-start gap-x-6 gap-y-1.5 text-sm">
          <Meta label="Mahnstufe" value={<LevelBadge level={reminder.level} />} />
          <Meta label="Mahndatum" value={formatDate(reminder.issueDate)} />
          <Meta label="Zahlungsfrist" value={formatDate(reminder.dueDate)} />
          <Meta label="Finalisiert" value={formatDate(reminder.finalizedAt)} />
          {reminder.sentAt && <Meta label="Versendet" value={formatDate(reminder.sentAt)} />}
        </dl>
        <AmountPanel
          reminder={reminder}
          feeCents={reminder.feeCents}
          interestCents={reminder.interestCents}
          issueDate={reminder.issueDate}
        />
      </section>
      {reminder.introText && (
        <p className="border-b py-6 text-sm whitespace-pre-line">{fillPlaceholders(reminder.introText, values)}</p>
      )}
      {reminder.closingText && <p className="py-6 text-sm whitespace-pre-line">{fillPlaceholders(reminder.closingText, values)}</p>}

      <ActionBar
        left={
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Lock className="size-3.5" />
            Finalisiert – nicht mehr bearbeitbar
          </span>
        }
      >
        <Button variant="outline" size="sm" asChild>
          <a href={reminderPdfUrl(reminder.id)} target="_blank" rel="noreferrer">
            <Eye />
            Vorschau
          </a>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <a href={reminderPdfUrl(reminder.id, true)} download>
            <Download />
            PDF herunterladen
          </a>
        </Button>
        {reminder.status === "final" && (
          <Button
            size="sm"
            disabled={markSent.isPending}
            onClick={() =>
              markSent.mutate(reminder.id, {
                onSuccess: () => toast.success("Als versendet markiert"),
                onError: (err) => toast.error(apiErrorMessage(err)),
              })
            }
          >
            <Send />
            Als versendet markieren
          </Button>
        )}
      </ActionBar>
    </Page>
  );
}

// ── Draft editor ────────────────────────────────────────────────────────────────

function ReminderEditor({ reminder }: { reminder: Reminder }) {
  const navigate = useNavigate();
  const update = useUpdateReminder();
  const finalize = useFinalizeReminder();
  const remove = useDeleteReminder();
  const { data: settings } = useQuery(reminderSettingsQuery);
  const { data: allTemplates } = useQuery(templatesQuery);
  const templates = (allTemplates ?? []).filter((t) => t.docType === "reminder");
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const form = useForm<FormValues, unknown, ReminderUpdate>({
    resolver: zodResolver(reminderUpdateSchema),
    defaultValues: toFormValues(reminder),
  });
  const { control, formState } = form;
  const [feeCents, interestCents, issueDate] = useWatch({ control, name: ["feeCents", "interestCents", "issueDate"] });

  const leaving = useRef(false);
  useBlocker({
    shouldBlockFn: () => !leaving.current && formState.isDirty && !window.confirm("Ungespeicherte Änderungen verwerfen?"),
    enableBeforeUnload: () => !leaving.current && formState.isDirty,
  });

  const busy = update.isPending || finalize.isPending || remove.isPending;

  const save = (): Promise<Reminder | null> => {
    if (!formState.isDirty) return Promise.resolve(reminder);
    return new Promise((resolve) => {
      void form.handleSubmit(
        async (values) => {
          try {
            const saved = await update.mutateAsync({ id: reminder.id, json: values });
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
    if (await save()) toast.success("Mahnung gespeichert");
  };

  const onPdf = async (download: boolean) => {
    const win = download ? null : window.open("", "_blank");
    const saved = await save();
    if (!saved) {
      win?.close();
      return;
    }
    if (win) win.location.href = reminderPdfUrl(saved.id);
    else window.location.assign(reminderPdfUrl(saved.id, true));
  };

  const onFinalize = async () => {
    setConfirmFinalize(false);
    const saved = await save();
    if (!saved) return;
    finalize.mutate(saved.id, {
      onSuccess: (r) => toast.success(`Mahnung ${r.number} finalisiert`),
      onError: (err) => toast.error(apiErrorMessage(err)),
    });
  };

  const onDelete = () =>
    remove.mutate(reminder.id, {
      onSuccess: () => {
        toast.success("Entwurf gelöscht");
        leaving.current = true;
        void navigate({ to: "/reminders", search: { tab: "all" } });
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    });

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

  /** Switching the level takes over title, fee, texts and deadline from the level settings. */
  const applyLevel = (level: number) => {
    if (!settings) return;
    const cfg = levelConfig(settings, level);
    const opts = { shouldDirty: true };
    form.setValue("title", cfg.title, opts);
    form.setValue("feeCents", cfg.feeCents, opts);
    form.setValue("introText", cfg.introText, opts);
    form.setValue("closingText", cfg.closingText, opts);
    form.setValue("dueDate", addDays(form.getValues("issueDate"), cfg.days), opts);
  };

  const interestRateBp = settings?.interestRateBp ?? 0;
  const computeInterest = () => {
    if (!reminder.invoice.dueDate) return;
    form.setValue(
      "interestCents",
      calcInterestCents(reminder.openCents, interestRateBp, reminder.invoice.dueDate, form.getValues("issueDate")),
      { shouldDirty: true },
    );
  };

  const levels = settings?.levels ?? [];

  return (
    <Page title={<Title reminder={reminder} />} description={<Description reminder={reminder} />}>
      <SettledNotice reminder={reminder} />
      <Form {...form}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onSave();
          }}
        >
          <section className="grid gap-x-10 gap-y-6 border-b pb-8 md:grid-cols-2">
            <div className="grid content-start gap-4">
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={control}
                  name="level"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Mahnstufe</FormLabel>
                      <Select
                        value={String(field.value)}
                        onValueChange={(v) => {
                          field.onChange(Number(v));
                          applyLevel(Number(v));
                        }}
                      >
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {levels.map((l, i) => (
                            <SelectItem key={i} value={String(i + 1)}>
                              {i + 1} · {l.title}
                            </SelectItem>
                          ))}
                          {field.value > levels.length && (
                            <SelectItem value={String(field.value)}>{field.value}</SelectItem>
                          )}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={control}
                  name="title"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Überschrift</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <DateField
                  control={control}
                  name="issueDate"
                  label="Mahndatum"
                  onCommit={(v) => {
                    if (!v || !settings) return;
                    form.setValue("dueDate", addDays(v, levelConfig(settings, form.getValues("level")).days), { shouldDirty: true });
                  }}
                />
                <DateField control={control} name="dueDate" label="Neue Zahlungsfrist" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <MoneyField control={control} name="feeCents" label="Mahnspesen" />
                <MoneyField
                  control={control}
                  name="interestCents"
                  label="Verzugszinsen"
                  action={
                    interestRateBp > 0 && (
                      <button
                        type="button"
                        onClick={computeInterest}
                        className="inline-flex h-4 items-center gap-1 text-xs whitespace-nowrap text-muted-foreground hover:text-foreground"
                        title={`${formatBp(interestRateBp)} p. a. ab Fälligkeit bis Mahndatum`}
                      >
                        <Calculator className="size-3" />
                        Berechnen
                      </button>
                    )
                  }
                />
              </div>
              <FormField
                control={control}
                name="templateId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>PDF-Vorlage</FormLabel>
                    <Select
                      value={field.value == null ? DEFAULT_TEMPLATE : String(field.value)}
                      onValueChange={(v) => field.onChange(v === DEFAULT_TEMPLATE ? null : Number(v))}
                    >
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={DEFAULT_TEMPLATE}>Standardvorlage</SelectItem>
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
            </div>
            <AmountPanel reminder={reminder} feeCents={feeCents ?? 0} interestCents={interestCents ?? 0} issueDate={issueDate} />
          </section>

          <section className="grid gap-4 py-6">
            <TextField control={control} name="introText" label="Einleitung" />
            <TextField control={control} name="closingText" label="Schlusstext" />
            <p className="text-xs text-muted-foreground">
              Platzhalter:{" "}
              {REMINDER_PLACEHOLDERS.map((p, i) => (
                <span key={p.key}>
                  {i > 0 && ", "}
                  <code className="rounded bg-muted px-1">{`{${p.key}}`}</code> {p.label}
                </span>
              ))}
            </p>
          </section>

          <ActionBar
            left={
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}>
                <Trash2 />
                Löschen
              </Button>
            }
          >
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void onPdf(false)}>
              <Eye />
              Vorschau
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void onPdf(true)}>
              <Download />
              PDF
            </Button>
            <Button type="submit" variant="outline" size="sm" disabled={busy || !formState.isDirty}>
              Speichern
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy || reminder.settled}
              title={reminder.settled ? "Die Rechnung ist bereits bezahlt" : undefined}
              onClick={() => setConfirmFinalize(true)}
            >
              Finalisieren
            </Button>
          </ActionBar>
        </form>
      </Form>

      <AlertDialog open={confirmFinalize} onOpenChange={setConfirmFinalize}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mahnung finalisieren?</AlertDialogTitle>
            <AlertDialogDescription>
              Die Mahnung erhält eine fortlaufende Nummer (MA-…) und kann danach nicht mehr bearbeitet oder gelöscht werden.
            </AlertDialogDescription>
          </AlertDialogHeader>
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
            <AlertDialogDescription>Der Mahnungsentwurf wird endgültig gelöscht.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction onClick={onDelete}>Löschen</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

type FormControlT = Control<FormValues, unknown, ReminderUpdate>;

function DateField({
  control,
  name,
  label,
  onCommit,
}: {
  control: FormControlT;
  name: "issueDate" | "dueDate";
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
              onChange={(e) => {
                field.onChange(e.target.value);
                onCommit?.(e.target.value);
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

function MoneyField({
  control,
  name,
  label,
  action,
}: {
  control: FormControlT;
  name: "feeCents" | "interestCents";
  label: string;
  action?: ReactNode;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <div className="flex items-center justify-between gap-2">
            <FormLabel>{label}</FormLabel>
            {action}
          </div>
          <div className="relative">
            <FormControl>
              <NumericInput codec={CODECS.money} min={0} value={field.value} onChange={field.onChange} onBlur={field.onBlur} className="pr-8" />
            </FormControl>
            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">€</span>
          </div>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function TextField({ control, name, label }: { control: FormControlT; name: "introText" | "closingText"; label: string }) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Textarea rows={3} {...field} />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
