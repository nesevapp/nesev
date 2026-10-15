import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_text,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, BellRing, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@shared/dates";
import { formatCents } from "@shared/money";
import { REMINDER_STATUS_LABELS, REMINDER_STATUSES, type ReminderStatus } from "@shared/reminders";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import {
  apiErrorMessage,
  type DueInvoice,
  dueInvoicesQuery,
  type ReminderListItem,
  remindersQuery,
  useCreateReminders,
} from "@/sdk";
import { useRemindAndOpen } from "./components/invoice-reminders";
import { LevelBadge, ReminderStatusBadge } from "./components/reminder-status-badge";

export type RemindersTab = "due" | "all";
export interface RemindersSearch {
  tab?: RemindersTab;
  status?: ReminderStatus;
}

const th = "h-9 text-xs font-medium text-muted-foreground";
const ALL = "all";

export function RemindersPage({
  search,
  setSearch,
}: {
  search: RemindersSearch;
  setSearch: (update: (s: RemindersSearch) => RemindersSearch) => void;
}) {
  const tab = search.tab ?? "due";
  const due = useQuery(dueInvoicesQuery);
  const dueCount = due.data?.filter((d) => d.due).length ?? 0;

  return (
    <Page
      title="Mahnungen"
      description="Überfällige Rechnungen mahnen: Zahlungserinnerung, 1. und 2. Mahnung."
      actions={
        <Button variant="ghost" size="sm" asChild>
          <Link to="/settings" hash="mahnwesen">
            <Settings2 />
            Mahnstufen
          </Link>
        </Button>
      }
    >
      <Tabs value={tab} onValueChange={(v) => setSearch(() => ({ tab: v === "due" ? undefined : (v as RemindersTab) }))}>
        <TabsList className="mb-4">
          <TabsTrigger value="due">
            Fällig zum Mahnen
            {dueCount > 0 && (
              <span className="ml-1 inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-danger-muted px-1 text-[11px] font-medium text-danger tabular">
                {dueCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="all">Mahnungen</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === "due" ? (
        <DueTab rows={due.data} />
      ) : (
        <AllTab status={search.status} setStatus={(status) => setSearch((s) => ({ ...s, status }))} />
      )}
    </Page>
  );
}

// ── Fällig zum Mahnen ───────────────────────────────────────────────────────────

function dunningState(row: DueInvoice) {
  if (row.draftId) return <span className="text-muted-foreground">Entwurf vorhanden</span>;
  if (!row.lastReminder) return <span className="text-muted-foreground">Noch nicht gemahnt</span>;
  const last = row.lastReminder;
  return (
    <span className="flex items-center gap-2">
      <LevelBadge level={last.level} />
      <span className="text-muted-foreground">
        {row.due ? "Frist abgelaufen" : <>Frist bis <span className="tabular">{formatDate(last.dueDate)}</span></>}
      </span>
    </span>
  );
}

function DueTab({ rows }: { rows: DueInvoice[] | undefined }) {
  const navigate = useNavigate();
  const remind = useRemindAndOpen();
  const bulk = useCreateReminders();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const data = rows ?? [];
  const selectable = data.filter((r) => r.due);
  const selectedIds = selectable.filter((r) => selected.has(r.invoiceId)).map((r) => r.invoiceId);
  const allSelected = selectable.length > 0 && selectedIds.length === selectable.length;

  const toggle = (id: number, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const createSelected = () =>
    bulk.mutate(selectedIds, {
      onSuccess: ({ created, errors }) => {
        setSelected(new Set());
        if (created.length) {
          toast.success(created.length === 1 ? "1 Mahnungsentwurf erstellt" : `${created.length} Mahnungsentwürfe erstellt`, {
            action: { label: "Anzeigen", onClick: () => void navigate({ to: "/reminders", search: { tab: "all", status: "draft" } }) },
          });
        }
        for (const e of errors) toast.error(e.error);
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    });

  return (
    <>
      <div className="mb-3 flex min-h-8 items-center gap-3">
        <span className="text-sm text-muted-foreground tabular">
          {data.length === 1 ? "1 überfällige Rechnung" : `${data.length} überfällige Rechnungen`}
          {data.length > 0 && ` · ${formatCents(data.reduce((s, r) => s + r.openCents, 0))} offen`}
        </span>
        {selectedIds.length > 0 && (
          <Button size="sm" className="ml-auto" disabled={bulk.isPending} onClick={createSelected}>
            <BellRing />
            {selectedIds.length === 1 ? "1 Mahnung erstellen" : `${selectedIds.length} Mahnungen erstellen`}
          </Button>
        )}
      </div>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(th, "w-10")}>
                <Checkbox
                  aria-label="Alle fälligen auswählen"
                  checked={allSelected ? true : selectedIds.length > 0 ? "indeterminate" : false}
                  disabled={selectable.length === 0}
                  onCheckedChange={(v) => setSelected(v === true ? new Set(selectable.map((r) => r.invoiceId)) : new Set())}
                />
              </TableHead>
              <TableHead className={th}>Rechnung</TableHead>
              <TableHead className={th}>Kunde</TableHead>
              <TableHead className={th}>Fällig seit</TableHead>
              <TableHead className={cn(th, "text-right")}>Tage</TableHead>
              <TableHead className={cn(th, "text-right")}>Offen</TableHead>
              <TableHead className={th}>Mahnstand</TableHead>
              <TableHead className={cn(th, "w-0")} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => {
              const open = () => void navigate({ to: "/invoices/$id", params: { id: row.invoiceId } });
              return (
                <TableRow
                  key={row.invoiceId}
                  tabIndex={0}
                  onClick={open}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && e.target === e.currentTarget) open();
                  }}
                  data-state={selected.has(row.invoiceId) && row.due ? "selected" : undefined}
                  className="cursor-pointer focus-visible:bg-muted/50 focus-visible:outline-none"
                >
                  <TableCell className="py-2" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      aria-label={`${row.number} auswählen`}
                      checked={row.due && selected.has(row.invoiceId)}
                      disabled={!row.due}
                      onCheckedChange={(v) => toggle(row.invoiceId, v === true)}
                    />
                  </TableCell>
                  <TableCell className="py-2 font-medium tabular">{row.number}</TableCell>
                  <TableCell className="max-w-56 truncate py-2">{row.clientName}</TableCell>
                  <TableCell className="py-2 tabular text-danger">{formatDate(row.dueDate)}</TableCell>
                  <TableCell className="py-2 text-right tabular">{row.daysOverdue}</TableCell>
                  <TableCell className="py-2 text-right tabular">{formatCents(row.openCents)}</TableCell>
                  <TableCell className="py-2 text-sm">{dunningState(row)}</TableCell>
                  <TableCell className="py-1.5 text-right whitespace-nowrap">
                    {row.draftId ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          void navigate({ to: "/reminders/$id", params: { id: row.draftId! } });
                        }}
                      >
                        Entwurf öffnen
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant={row.due ? "outline" : "ghost"}
                        className="h-7 text-xs"
                        disabled={remind.isPending}
                        title={row.due ? undefined : "Die Frist der letzten Mahnung läuft noch"}
                        onClick={(e) => {
                          e.stopPropagation();
                          remind.run(row.invoiceId);
                        }}
                      >
                        <BellRing />
                        {row.nextLevelTitle}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {data.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="py-16 text-center text-sm text-muted-foreground">
                  {rows ? "Keine überfälligen Rechnungen – nichts zu mahnen." : "Laden…"}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

// ── Alle Mahnungen ──────────────────────────────────────────────────────────────

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, basic: sortFn_basic },
});
const col = createColumnHelper<typeof features, ReminderListItem>();
const RIGHT = new Set(["totalCents"]);

const columns = col.columns([
  col.accessor((r) => r.number ?? "", {
    id: "number",
    header: "Nummer",
    sortFn: "alphanumeric",
    cell: ({ row }) =>
      row.original.number ? (
        <span className="tabular font-medium">{row.original.number}</span>
      ) : (
        <span className="text-muted-foreground">Entwurf</span>
      ),
  }),
  col.accessor((r) => r.invoiceNumber ?? "", {
    id: "invoice",
    header: "Rechnung",
    sortFn: "alphanumeric",
    cell: (info) => <span className="tabular">{info.getValue()}</span>,
  }),
  col.accessor("clientName", {
    header: "Kunde",
    sortFn: "text",
    cell: (info) => <div className="max-w-44 truncate">{info.getValue()}</div>,
  }),
  col.accessor("level", {
    header: "Stufe",
    sortFn: "basic",
    cell: ({ row }) => (
      <span className="flex items-center gap-2">
        <LevelBadge level={row.original.level} />
        <span className="hidden truncate text-muted-foreground xl:inline">{row.original.title}</span>
      </span>
    ),
  }),
  col.accessor("issueDate", {
    header: "Datum",
    sortFn: "text",
    cell: (info) => <span className="tabular">{formatDate(info.getValue())}</span>,
  }),
  col.accessor("dueDate", {
    header: "Frist",
    sortFn: "text",
    cell: (info) => <span className="tabular">{formatDate(info.getValue())}</span>,
  }),
  col.accessor("totalCents", {
    header: "Betrag",
    sortFn: "basic",
    cell: (info) => <span className="tabular">{formatCents(info.getValue())}</span>,
  }),
  col.accessor("status", {
    header: "Status",
    sortFn: "text",
    cell: ({ row }) => <ReminderStatusBadge status={row.original.status} settled={row.original.settled} />,
  }),
]);

function AllTab({ status, setStatus }: { status?: ReminderStatus; setStatus: (s: ReminderStatus | undefined) => void }) {
  const navigate = useNavigate();
  const { data = EMPTY, isFetching } = useQuery(remindersQuery({ status }));
  const table = useTable({
    features,
    columns,
    data,
    initialState: { sorting: [{ id: "issueDate", desc: true }] },
    enableSortingRemoval: false,
  });

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <Select value={status ?? ALL} onValueChange={(v) => setStatus(v === ALL ? undefined : (v as ReminderStatus))}>
          <SelectTrigger size="sm" className="w-40" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Alle Status</SelectItem>
            <SelectSeparator />
            {REMINDER_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {REMINDER_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className={cn("ml-auto text-sm text-muted-foreground tabular", isFetching && "opacity-60")}>
          {data.length === 1 ? "1 Mahnung" : `${data.length} Mahnungen`}
        </span>
      </div>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  const right = RIGHT.has(header.column.id);
                  return (
                    <TableHead key={header.id} className={cn(th, right && "text-right")}>
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className={cn("-ml-1 inline-flex items-center gap-1 rounded px-1 hover:text-foreground", right && "flex-row-reverse")}
                      >
                        <table.FlexRender header={header} />
                        {sorted === "asc" && <ArrowUp className="size-3" />}
                        {sorted === "desc" && <ArrowDown className="size-3" />}
                      </button>
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => {
              const open = () => void navigate({ to: "/reminders/$id", params: { id: row.original.id } });
              return (
                <TableRow
                  key={row.id}
                  tabIndex={0}
                  onClick={open}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") open();
                  }}
                  className="cursor-pointer focus-visible:bg-muted/50 focus-visible:outline-none"
                >
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id} className={cn("py-2.5", RIGHT.has(cell.column.id) && "text-right")}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
            {data.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="py-16 text-center text-sm text-muted-foreground">
                  {status ? "Keine Mahnungen mit diesem Status." : "Noch keine Mahnungen erstellt."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

const EMPTY: ReminderListItem[] = [];
