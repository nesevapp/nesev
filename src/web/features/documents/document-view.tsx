import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BellRing, Copy, Download, Eye, FileOutput, MoreHorizontal, ReceiptText } from "lucide-react";
import { toast } from "sonner";
import { formatDate, todayIso } from "@shared/dates";
import { ALLOWED_STATUS_ACTIONS, STATUS_ACTION_LABELS, type StatusAction } from "@shared/documents";
import { formatBp, formatCents, formatQuantity } from "@shared/money";
import { TAX_MODE_LABELS, taxNoteFor } from "@shared/tax";
import { calcLine } from "@shared/totals";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InvoicePayments } from "@/features/bank/components/invoice-payments";
import { InvoiceReminders, useRemindAndOpen } from "@/features/reminders/components/invoice-reminders";
import {
  apiErrorMessage,
  type Document,
  documentPaymentsQuery,
  documentPdfUrl,
  settingsQuery,
  useChangeDocumentStatus,
} from "@/sdk";
import { ActionBar, useDeriveAndOpen } from "./components/action-bar";
import { DocumentRelations } from "./components/document-relations";
import { EInvoiceDownloadButton } from "./components/einvoice-download";
import { StatusBadge } from "./components/status-badge";
import { TotalsPanel } from "./components/totals-panel";
import { cityLine, DOC_CONFIG } from "./config";

/** Read-only view of a finalized document (data from its snapshots) with status/follow-up actions. */
export function DocumentView({ doc }: { doc: Document }) {
  const config = DOC_CONFIG[doc.type];
  const { data: settings } = useQuery(settingsQuery);
  const changeStatus = useChangeDocumentStatus();
  const derive = useDeriveAndOpen();
  const remind = useRemindAndOpen();
  const [paidOpen, setPaidOpen] = useState(false);
  const [paidAt, setPaidAt] = useState(todayIso());
  const [resetOpen, setResetOpen] = useState(false);
  const { data: payments } = useQuery({ ...documentPaymentsQuery(doc.id), enabled: doc.type === "invoice" });

  const client = doc.clientSnapshot;
  const actions = ALLOWED_STATUS_ACTIONS[doc.type][doc.status] ?? [];
  const taxNote = settings ? taxNoteFor(doc.taxMode, settings) : null;
  const busy = changeStatus.isPending || derive.isPending || remind.isPending;

  const runAction = (action: StatusAction, opts: { paidAt?: string; removeAllocations?: boolean } = {}) =>
    changeStatus.mutate(
      { id: doc.id, json: { action, ...opts } },
      {
        onSuccess: () => {
          setPaidOpen(false);
          setResetOpen(false);
          toast.success("Status aktualisiert");
        },
        onError: (err) => toast.error(apiErrorMessage(err)),
      },
    );

  const onAction = (action: StatusAction) => {
    if (action === "paid") {
      setPaidAt(todayIso());
      setPaidOpen(true);
    } else if (action === "unpaid" && payments && payments.payments.length > 0) {
      // bank allocations cover it: resetting only makes sense together with them
      setResetOpen(true);
    } else runAction(action);
  };

  const [primaryAction, ...moreActions] = actions;

  return (
    <Page
      title={
        <span className="flex items-center gap-3">
          {config.singular} <span className="tabular">{doc.number}</span>
          <StatusBadge status={doc.status} overdue={doc.overdue} />
        </span>
      }
      description={<DocumentRelations doc={doc} />}
    >
      <section className="grid gap-x-10 gap-y-6 border-b pb-8 md:grid-cols-2">
        <div className="text-sm">
          <div className="mb-1 text-xs text-muted-foreground">Kunde</div>
          {client ? (
            <div className="space-y-0.5">
              <div className="font-medium">{client.name}</div>
              {client.contactPerson && <div>{client.contactPerson}</div>}
              {client.street && <div>{client.street}</div>}
              {client.addressExtra && <div>{client.addressExtra}</div>}
              <div>
                {cityLine(client)}
              </div>
              {client.uid && <div className="tabular text-muted-foreground">UID: {client.uid}</div>}
            </div>
          ) : (
            <div>{doc.clientName}</div>
          )}
          {doc.title && (
            <>
              <div className="mt-4 mb-1 text-xs text-muted-foreground">Betreff</div>
              <div>{doc.title}</div>
            </>
          )}
        </div>
        <dl className="grid grid-cols-[max-content_1fr] content-start gap-x-6 gap-y-1.5 text-sm">
          <Meta label={`${config.singular}sdatum`} value={formatDate(doc.issueDate)} />
          {doc.type === "invoice" && (
            <Meta label="Fällig am" value={formatDate(doc.dueDate)} className={doc.overdue ? "text-danger" : undefined} />
          )}
          {doc.type === "offer" && <Meta label="Gültig bis" value={formatDate(doc.validUntil)} />}
          {(doc.servicePeriodStart || doc.servicePeriodEnd) && (
            <Meta
              label="Leistungszeitraum"
              value={[formatDate(doc.servicePeriodStart), formatDate(doc.servicePeriodEnd)].filter(Boolean).join(" – ")}
            />
          )}
          <Meta label="Steuermodus" value={TAX_MODE_LABELS[doc.taxMode]} />
          <Meta label="Finalisiert" value={formatDate(doc.finalizedAt)} />
          {doc.sentAt && <Meta label="Versendet" value={formatDate(doc.sentAt)} />}
          {doc.paidAt && <Meta label="Bezahlt am" value={formatDate(doc.paidAt)} />}
        </dl>
      </section>

      {doc.introText && <p className="border-b py-6 text-sm whitespace-pre-line">{doc.introText}</p>}

      <section className="py-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="w-8 pb-2 text-left font-medium">#</th>
              <th className="pb-2 text-left font-medium">Bezeichnung</th>
              <th className="pb-2 text-right font-medium">Menge</th>
              <th className="pb-2 text-right font-medium">Einzelpreis</th>
              <th className="pb-2 text-right font-medium">USt.</th>
              <th className="pb-2 text-right font-medium">Rabatt</th>
              <th className="pb-2 text-right font-medium">Gesamt netto</th>
            </tr>
          </thead>
          <tbody>
            {doc.items.map((item, i) => {
              const line = calcLine(item, doc.taxMode);
              return (
                <tr key={item.id} className="border-b align-top">
                  <td className="tabular py-2.5 text-muted-foreground">{i + 1}</td>
                  <td className="py-2.5 pr-4">
                    <div className="font-medium">{item.title}</div>
                    {item.description && (
                      <div className="whitespace-pre-line text-muted-foreground">{item.description}</div>
                    )}
                  </td>
                  <td className="tabular py-2.5 text-right whitespace-nowrap">
                    {formatQuantity(item.quantity)} {item.unit}
                  </td>
                  <td className="tabular py-2.5 text-right">{formatCents(item.unitPriceCents)}</td>
                  <td className="tabular py-2.5 text-right">{formatBp(line.taxRateBp)}</td>
                  <td className="tabular py-2.5 text-right text-muted-foreground">
                    {item.discountBp ? formatBp(item.discountBp) : "–"}
                  </td>
                  <td className="tabular py-2.5 text-right">{formatCents(line.netCents)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="mt-6 flex justify-end">
          <TotalsPanel items={doc.items} taxMode={doc.taxMode} taxNote={taxNote} />
        </div>
      </section>

      {doc.closingText && <p className="border-t pt-6 text-sm whitespace-pre-line">{doc.closingText}</p>}

      {doc.type === "invoice" && <InvoicePayments documentId={doc.id} />}
      {doc.type === "invoice" && <InvoiceReminders invoiceId={doc.id} />}

      <ActionBar>
        <Button variant="outline" size="sm" asChild>
          <a href={documentPdfUrl(doc.id)} target="_blank" rel="noreferrer">
            <Eye />
            Vorschau
          </a>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <a href={documentPdfUrl(doc.id, true)} download>
            <Download />
            PDF herunterladen
          </a>
        </Button>
        {doc.type !== "offer" && doc.number && <EInvoiceDownloadButton documentId={doc.id} number={doc.number} />}
        {/* follow-ups and secondary status actions, so the bar stays one row */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon-sm" aria-label="Weitere Aktionen" title="Weitere Aktionen" disabled={busy}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {doc.type === "invoice" && doc.overdue && (
              <DropdownMenuItem onSelect={() => remind.run(doc.id)}>
                <BellRing />
                Mahnung erstellen
              </DropdownMenuItem>
            )}
            {doc.type === "offer" && (
              <DropdownMenuItem onSelect={() => derive.run(doc, "convert-to-invoice")}>
                <FileOutput />
                In Rechnung umwandeln
              </DropdownMenuItem>
            )}
            {doc.type === "invoice" && (
              <DropdownMenuItem onSelect={() => derive.run(doc, "credit-note")}>
                <ReceiptText />
                Gutschrift erstellen
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => derive.run(doc, "duplicate")}>
              <Copy />
              Duplizieren
            </DropdownMenuItem>
            {moreActions.length > 0 && <DropdownMenuSeparator />}
            {moreActions.map((a) => (
              <DropdownMenuItem key={a} onSelect={() => onAction(a)}>
                {STATUS_ACTION_LABELS[a]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {primaryAction && (
          <Button size="sm" disabled={busy} onClick={() => onAction(primaryAction)}>
            {STATUS_ACTION_LABELS[primaryAction]}
          </Button>
        )}
      </ActionBar>

      <Dialog open={paidOpen} onOpenChange={setPaidOpen}>
        <DialogContent className="sm:max-w-sm">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (paidAt) runAction("paid", { paidAt });
            }}
          >
            <DialogHeader>
              <DialogTitle>Als bezahlt markieren</DialogTitle>
              <DialogDescription>
                {doc.number} · {formatCents(doc.grossCents)}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 py-4">
              <Label htmlFor="paid-at">Zahlungsdatum</Label>
              <Input
                id="paid-at"
                type="date"
                value={paidAt}
                onChange={(e) => setPaidAt(e.target.value)}
                className="tabular"
                autoFocus
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPaidOpen(false)}>
                Abbrechen
              </Button>
              <Button type="submit" disabled={!paidAt || changeStatus.isPending}>
                Bezahlt
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Zahlung zurücksetzen</DialogTitle>
            <DialogDescription>
              Diese Rechnung ist durch Bankbuchungen bezahlt – Zuordnungen ebenfalls entfernen? Die Buchungen
              {payments ? ` (${formatCents(payments.paidCents)})` : ""} werden wieder als offen markiert.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setResetOpen(false)}>
              Abbrechen
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={changeStatus.isPending}
              onClick={() => runAction("unpaid", { removeAllocations: true })}
            >
              Zuordnungen entfernen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}

function Meta({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={className ? `tabular ${className}` : "tabular"}>{value || "–"}</dd>
    </>
  );
}
