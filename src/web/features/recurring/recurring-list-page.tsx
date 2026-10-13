import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Play, Plus, Repeat } from "lucide-react";
import { toast } from "sonner";
import { formatDate, todayIso } from "@shared/dates";
import { formatCents } from "@shared/money";
import { intervalLabel } from "@shared/recurring";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { type RecurringListRowDTO, recurringListQuery, useRunRecurring, useUpdateRecurring } from "./api";

/** Toast summary for a generation run. */
export function reportGenerated(created: { finalized: boolean; error?: string }[]) {
  if (created.length === 0) {
    toast.info("Keine fälligen Serienrechnungen");
    return;
  }
  const finals = created.filter((c) => c.finalized).length;
  const drafts = created.length - finals;
  const parts = [finals && `${finals} finalisiert`, drafts && `${drafts} als Entwurf`].filter(Boolean).join(", ");
  toast.success(`${created.length} ${created.length === 1 ? "Rechnung" : "Rechnungen"} erstellt (${parts})`);
  for (const c of created) if (c.error) toast.warning(`Nicht finalisiert: ${c.error}`);
}

export function scheduleState(r: Pick<RecurringListRowDTO, "active" | "endDate" | "nextRunDate">, today: string) {
  if (r.endDate && r.nextRunDate > r.endDate) return "ended" as const;
  if (!r.active) return "paused" as const;
  return r.nextRunDate <= today ? ("due" as const) : ("scheduled" as const);
}

export function RecurringListPage() {
  const navigate = useNavigate();
  const { data = [] } = useQuery(recurringListQuery);
  const run = useRunRecurring();
  const update = useUpdateRecurring();
  const today = todayIso();
  const dueCount = data.filter((r) => scheduleState(r, today) === "due").length;
  const monthlyCents = data
    .filter((r) => scheduleState(r, today) !== "ended" && r.active)
    .reduce((s, r) => s + (r.grossCents * (r.intervalUnit === "year" ? 1 : 12)) / (r.intervalCount * 12), 0);

  const onRun = () =>
    run.mutate(undefined, {
      onSuccess: ({ created }) => reportGenerated(created),
      onError: (err) => toast.error(apiErrorMessage(err)),
    });

  return (
    <Page
      title="Serienrechnungen"
      description={
        data.length > 0 &&
        `${data.filter((r) => r.active).length} aktiv · ca. ${formatCents(Math.round(monthlyCents))} brutto pro Monat`
      }
      actions={
        <>
          <Button variant="outline" size="sm" disabled={run.isPending} onClick={onRun}>
            <Play />
            Jetzt ausführen
            {dueCount > 0 && <span className="ml-0.5 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">{dueCount}</span>}
          </Button>
          <Button size="sm" asChild>
            <Link to="/recurring/new">
              <Plus />
              Neue Serienrechnung
            </Link>
          </Button>
        </>
      }
    >
      {data.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
          <Repeat className="mx-auto mb-3 size-6 text-muted-foreground/60" />
          Noch keine Serienrechnungen. Wiederkehrende Leistungen (Hosting, Wartung, Retainer) werden automatisch
          zum Stichtag verrechnet.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Intervall</TableHead>
              <TableHead>Nächste Rechnung</TableHead>
              <TableHead className="text-right">Betrag brutto</TableHead>
              <TableHead>Zuletzt erstellt</TableHead>
              <TableHead className="w-16 text-right">Aktiv</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((r) => {
              const state = scheduleState(r, today);
              return (
                <TableRow
                  key={r.id}
                  className={cn("cursor-pointer", !r.active && "text-muted-foreground")}
                  onClick={() => void navigate({ to: "/recurring/$id", params: { id: r.id } })}
                >
                  <TableCell>
                    <Link
                      to="/recurring/$id"
                      params={{ id: r.id }}
                      className="font-medium text-foreground"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {r.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">{r.clientName}</div>
                  </TableCell>
                  <TableCell>
                    {intervalLabel(r)}
                    <div className="text-xs text-muted-foreground">
                      {[r.endDate && `bis ${formatDate(r.endDate)}`, r.autoFinalize && "automatisch finalisiert"]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </TableCell>
                  <TableCell>
                    {state === "ended" ? (
                      <span className="text-muted-foreground">beendet</span>
                    ) : (
                      <span className="tabular">{formatDate(r.nextRunDate)}</span>
                    )}
                    {state === "due" && <div className="text-xs text-amber-700">fällig – wird erstellt</div>}
                    {state === "paused" && <div className="text-xs text-muted-foreground">pausiert</div>}
                  </TableCell>
                  <TableCell className="text-right tabular">{formatCents(r.grossCents)}</TableCell>
                  <TableCell>
                    {r.lastInvoiceDate ? (
                      <>
                        <span className="tabular">{formatDate(r.lastInvoiceDate)}</span>
                        <div className="text-xs text-muted-foreground">
                          {r.invoiceCount} {r.invoiceCount === 1 ? "Rechnung" : "Rechnungen"}
                        </div>
                      </>
                    ) : (
                      <span className="text-muted-foreground/60">–</span>
                    )}
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
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Page>
  );
}
