import { type ReactNode, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarClock, ListChecks, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { addDays, formatDate, todayIso } from "@shared/dates";
import { categoryLabel } from "@shared/expenses";
import { formatCents } from "@shared/money";
import { intervalLabel } from "@shared/recurring";
import { paymentDatesBetween } from "@shared/recurring-expenses";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  apiErrorMessage,
  type RecurringExpense,
  recurringExpensesQuery,
  useDeleteRecurringExpense,
  useUpdateRecurringExpense,
} from "@/sdk";
import { FixedCostDialog } from "./fixed-cost-dialog";
import { FixedCostScheduleDialog } from "./fixed-cost-schedule-dialog";

type DialogState =
  | { kind: "edit"; item: RecurringExpense | null }
  | { kind: "delete"; item: RecurringExpense }
  | { kind: "schedule"; item: RecurringExpense }
  | null;


export function FixedCostsPage() {
  const { data = [] } = useQuery(recurringExpensesQuery);
  const update = useUpdateRecurringExpense();
  const [dialog, setDialogState] = useState<DialogState>(null);
  // kept while the edit dialog animates out, so its title doesn't flip to "Neue Fixkosten"
  const [editItem, setEditItem] = useState<RecurringExpense | null>(null);
  const setDialog = (d: DialogState) => {
    if (d?.kind === "edit") setEditItem(d.item);
    setDialogState(d);
  };
  const today = todayIso();

  const running = data.filter((r) => r.active && !r.ended);
  const monthly = running.reduce((s, r) => s + r.monthlyCents, 0);
  const monthlyTax = running.reduce((s, r) => s + Math.round((r.taxCents * r.monthlyCents) / r.grossCents), 0);
  const in30 = addDays(today, 30);
  const next30 = running.reduce((s, r) => s + paymentDatesBetween(r, today, in30).length * r.grossCents, 0);
  const newItem = () => setDialog({ kind: "edit", item: null });

  return (
    <Page
      title="Fixkosten"
      description="Wiederkehrende Ausgaben (SVS, Miete, Abos, Versicherungen) für die Zahlungsprognose."
      actions={
        <>
          <Button variant="outline" size="sm" asChild>
            <Link to="/forecast">
              <CalendarClock />
              Zahlungsprognose
            </Link>
          </Button>
          <Button size="sm" onClick={newItem}>
            <Plus />
            Neue Fixkosten
          </Button>
        </>
      }
    >
      {data.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
          <CalendarClock className="mx-auto mb-3 size-6 text-muted-foreground/60" />
          <p>Noch keine Fixkosten. Trag regelmäßige Zahlungen ein, damit die Prognose deinen Kontostand vorausrechnen kann.</p>
          <Button size="sm" variant="outline" className="mt-4" onClick={newItem}>
            <Plus />
            Erste Fixkosten anlegen
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-3">
            <Tile label="Fixkosten pro Monat (Ø)" value={formatCents(monthly)} sub={`${running.length} aktiv · darin USt. ${formatCents(monthlyTax)}`} />
            <Tile label="Pro Jahr" value={formatCents(monthly * 12)} sub="hochgerechnet aus dem Monatsschnitt" />
            <Tile label="Nächste 30 Tage" value={formatCents(next30)} sub={`fällig bis ${formatDate(in30)}`} />
          </div>

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Bezeichnung</TableHead>
                  <TableHead>Kategorie</TableHead>
                  <TableHead>Intervall</TableHead>
                  <TableHead>Nächste Zahlung</TableHead>
                  <TableHead className="text-right">Betrag</TableHead>
                  <TableHead className="text-right">pro Monat</TableHead>
                  <TableHead>Belege</TableHead>
                  <TableHead className="w-16 text-right">Aktiv</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((r) => (
                  <TableRow
                    key={r.id}
                    className={cn("cursor-pointer", (!r.active || r.ended) && "text-muted-foreground")}
                    onClick={() => setDialog({ kind: "edit", item: r })}
                  >
                    <TableCell className="py-2.5">
                      <div className="font-medium text-foreground">{r.name}</div>
                      {r.supplierName && <div className="text-xs text-muted-foreground">{r.supplierName}</div>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{categoryLabel(r.category)}</TableCell>
                    <TableCell>
                      {intervalLabel(r)}
                      {r.endDate && <div className="text-xs text-muted-foreground">bis {formatDate(r.endDate)}</div>}
                    </TableCell>
                    <TableCell>
                      {r.nextPaymentDate ? <span className="tabular">{formatDate(r.nextPaymentDate)}</span> : <span>beendet</span>}
                      {!r.active && !r.ended && <div className="text-xs text-muted-foreground">pausiert</div>}
                    </TableCell>
                    <TableCell className="text-right tabular">
                      {formatCents(r.grossCents)}
                      {r.taxCents > 0 && <div className="text-xs text-muted-foreground">USt. {formatCents(r.taxCents)}</div>}
                    </TableCell>
                    <TableCell className="text-right tabular">{formatCents(r.monthlyCents)}</TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={cn("-ml-2 h-7 px-2 text-xs", r.missingCount > 0 ? "text-amber-800" : "text-muted-foreground")}
                        onClick={() => setDialog({ kind: "schedule", item: r })}
                      >
                        <ListChecks />
                        {r.missingCount > 0 ? `${r.missingCount} ohne Beleg` : "Zahlungen"}
                      </Button>
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <Switch
                        size="sm"
                        checked={r.active}
                        aria-label={`${r.name} aktiv`}
                        onCheckedChange={(active) =>
                          update.mutate(
                            { id: r.id, json: { active } },
                            {
                              onSuccess: () => toast.success(active ? `${r.name} aktiviert` : `${r.name} pausiert`),
                              onError: (err) => toast.error(apiErrorMessage(err)),
                            },
                          )
                        }
                      />
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" aria-label={`Aktionen für ${r.name}`} className="text-muted-foreground">
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setDialog({ kind: "edit", item: r })}>
                            <Pencil />
                            Bearbeiten
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setDialog({ kind: "schedule", item: r })}>
                            <ListChecks />
                            Zahlungen &amp; Belege
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => setDialog({ kind: "delete", item: r })}>
                            <Trash2 />
                            Löschen
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5}>Summe aktiv</TableCell>
                  <TableCell className="text-right tabular">{formatCents(monthly)}</TableCell>
                  <TableCell colSpan={3} />
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        </div>
      )}

      <FixedCostDialog
        open={dialog?.kind === "edit"}
        onOpenChange={(open) => !open && setDialog(null)}
        item={editItem}
      />
      <FixedCostScheduleDialog item={dialog?.kind === "schedule" ? dialog.item : null} onClose={() => setDialog(null)} />
      <DeleteDialog item={dialog?.kind === "delete" ? dialog.item : null} onClose={() => setDialog(null)} />
    </Page>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: ReactNode }) {
  return (
    <div className="bg-background p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1.5 text-xl font-semibold tracking-tight tabular">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}

function DeleteDialog({ item, onClose }: { item: RecurringExpense | null; onClose: () => void }) {
  const del = useDeleteRecurringExpense();
  return (
    <AlertDialog open={!!item} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Fixkosten löschen?</AlertDialogTitle>
          <AlertDialogDescription>
            „{item?.name}“ wird aus der Zahlungsprognose entfernt. Erfasste Ausgaben bleiben unverändert. Zum
            vorübergehenden Aussetzen stattdessen „Aktiv“ ausschalten.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Abbrechen</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={del.isPending}
            onClick={(e) => {
              e.preventDefault();
              if (!item) return;
              del.mutate(item.id, {
                onSuccess: () => {
                  toast.success("Fixkosten gelöscht");
                  onClose();
                },
                onError: (err) => toast.error(apiErrorMessage(err)),
              });
            }}
          >
            Löschen
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
