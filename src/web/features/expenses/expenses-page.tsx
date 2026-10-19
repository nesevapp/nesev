import { useEffect, useState } from "react";
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
import { ArrowDown, ArrowUp, Check, Circle, FileText, Image, Loader2, Plus, Search, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { formatDate, todayIso } from "@shared/dates";
import { categoryLabel, VAT_TREATMENT_SHORT_LABELS } from "@shared/expenses";
import { formatCents } from "@shared/money";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDebouncedValue } from "@/features/clients/use-debounced-value";
import {
  AnalysisStatusCell,
  AnalysisToolbar,
  ReceiptListScope,
  SelectCell,
  useReceiptListState,
} from "@/features/receipts/analysis-list";
import { InboxButton } from "./inbox/inbox-badge";
import { cn } from "@/lib/utils";
import {
  apiErrorMessage,
  type ExpenseListFilter,
  type ExpenseListItem,
  expensesQuery,
  receiptUrl,
  useCreateExpenseDrafts,
  useSetExpensePaid,
} from "@/sdk";
import { CategoryOptions } from "./components/category-select";
import { IncompleteBadge } from "./components/expense-badges";
import { DropOverlay, pickReceiptFiles, splitReceiptFiles, useWindowFileDrag } from "./components/file-drop";

const ALL = "all";
const RIGHT = new Set(["netCents", "taxCents", "grossCents"]);
/** Low-priority columns, hidden while the table container is narrower than the full table (~72rem, e.g. next to the assistant panel). */
const NARROW_HIDDEN = new Set(["categories", "netCents", "taxCents", "analysis"]);
const NARROW = "@max-[72rem]/table:hidden";
const narrow = (id: string) => NARROW_HIDDEN.has(id) && NARROW;

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, basic: sortFn_basic },
});
const col = createColumnHelper<typeof features, ExpenseListItem>();

const money = (v: number) => <span className="tabular">{formatCents(v)}</span>;

const COLUMNS = col.columns([
  col.display({
    id: "select",
    header: "",
    cell: ({ row }) => <SelectCell expense={row.original} />,
  }),
  col.accessor((e) => e.number ?? "", {
    id: "number",
    header: "Nr.",
    sortFn: "alphanumeric",
    cell: ({ row }) => <span className="tabular text-muted-foreground">{row.original.number}</span>,
  }),
  col.accessor("issueDate", {
    header: "Datum",
    sortFn: "text",
    cell: (info) => <span className="tabular">{formatDate(info.getValue())}</span>,
  }),
  col.accessor("supplierName", {
    header: "Lieferant",
    sortFn: "text",
    cell: ({ row }) => {
      const e = row.original;
      return (
        <div className="min-w-0 max-w-72">
          <div className="flex items-center gap-2">
            <span className="truncate">
              {e.supplierName || <span className="text-muted-foreground">{e.attachmentName || "Ohne Lieferant"}</span>}
            </span>
            {e.incomplete && <IncompleteBadge className="shrink-0" />}
          </div>
          {(e.description || e.vatTreatment !== "domestic") && (
            <div className="truncate text-xs text-muted-foreground">
              {e.description}
              {e.vatTreatment !== "domestic" && (
                <span className={cn("text-muted-foreground/80", e.description && "ml-1.5")}>
                  {e.description && "· "}
                  {VAT_TREATMENT_SHORT_LABELS[e.vatTreatment]}
                </span>
              )}
            </div>
          )}
        </div>
      );
    },
  }),
  col.accessor((e) => e.categories.map(categoryLabel).join(", "), {
    id: "categories",
    header: "Kategorie",
    sortFn: "text",
    cell: (info) => <div className="max-w-48 truncate text-muted-foreground">{info.getValue()}</div>,
  }),
  col.accessor("netCents", { header: "Netto", sortFn: "basic", cell: (info) => money(info.getValue()) }),
  col.accessor("taxCents", { header: "USt.", sortFn: "basic", cell: (info) => money(info.getValue()) }),
  col.accessor("grossCents", { header: "Brutto", sortFn: "basic", cell: (info) => money(info.getValue()) }),
  col.accessor((e) => e.paidAt ?? "", {
    id: "paid",
    header: "Bezahlt",
    sortFn: "text",
    cell: ({ row }) => <PaidToggle expense={row.original} />,
  }),
  col.accessor((e) => (e.attachmentPath ? 1 : 0), {
    id: "attachment",
    header: "Beleg",
    sortFn: "basic",
    cell: ({ row }) => <ReceiptLink expense={row.original} />,
  }),
  col.display({
    id: "analysis",
    header: "Analyse",
    cell: ({ row }) => <AnalysisStatusCell expense={row.original} />,
  }),
]);

function PaidToggle({ expense }: { expense: ExpenseListItem }) {
  const setPaid = useSetExpensePaid();
  const overdue = !expense.paidAt && !!expense.dueDate && expense.dueDate < todayIso();
  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPaid.mutate(
      { id: expense.id, paidAt: expense.paidAt ? null : todayIso() },
      { onError: (err) => toast.error(apiErrorMessage(err)) },
    );
  };
  return (
    <button
      type="button"
      onClick={toggle}
      onKeyDown={(e) => e.stopPropagation()}
      disabled={setPaid.isPending}
      title={expense.paidAt ? "Als offen markieren" : "Heute als bezahlt markieren"}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-full px-1.5 text-xs whitespace-nowrap hover:bg-muted",
        expense.paidAt ? "text-success" : overdue ? "text-danger" : "text-muted-foreground",
      )}
    >
      {setPaid.isPending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : expense.paidAt ? (
        <Check className="size-4" />
      ) : (
        <Circle className="size-4" />
      )}
      <span className="tabular">{expense.paidAt ? formatDate(expense.paidAt) : overdue ? "überfällig" : "offen"}</span>
    </button>
  );
}

function ReceiptLink({ expense }: { expense: ExpenseListItem }) {
  const url = receiptUrl(expense);
  if (!url) return <span className="text-muted-foreground/50">–</span>;
  const Icon = expense.attachmentPath?.endsWith(".pdf") ? FileText : Image;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={expense.attachmentName || "Beleg öffnen"}
      className="inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <Icon className="size-4" />
    </a>
  );
}

export function ExpensesPage({
  search,
  setSearch,
}: {
  search: ExpenseListFilter;
  setSearch: (update: (s: ExpenseListFilter) => ExpenseListFilter) => void;
}) {
  const navigate = useNavigate();
  const [q, setQ] = useState(search.q ?? "");
  const debouncedQ = useDebouncedValue(q.trim(), 200);
  useEffect(() => {
    if (debouncedQ !== (search.q ?? "")) setSearch((s) => ({ ...s, q: debouncedQ || undefined }));
  }, [debouncedQ, search.q, setSearch]);

  const { data: fetched = EMPTY, isFetching } = useQuery(expensesQuery(search));
  const receiptList = useReceiptListState();
  const data = receiptList.filter(fetched);
  const { data: drafts = EMPTY } = useQuery(expensesQuery({ status: "incomplete" }));
  const createDrafts = useCreateExpenseDrafts();
  const dragging = useWindowFileDrag();

  const table = useTable({
    features,
    columns: COLUMNS,
    data,
    initialState: { sorting: [{ id: "issueDate", desc: true }] },
    enableSortingRemoval: false,
  });

  const filtered = !!(
    search.q ||
    search.status ||
    search.category ||
    search.attachment ||
    search.from ||
    search.to ||
    receiptList.readyOnly
  );
  const sum = (k: "netCents" | "taxCents" | "grossCents") => data.reduce((s, e) => s + e[k], 0);
  const open = (id: number) => navigate({ to: "/expenses/$id", params: { id } });
  const firstDraft = drafts.at(-1); // oldest

  const onFiles = (files: File[]) => {
    const { accepted, rejected } = splitReceiptFiles(files);
    if (rejected.length) toast.error(`Nicht unterstützt: ${rejected.join(", ")}`);
    if (!accepted.length) return;
    createDrafts.mutate(accepted, {
      onSuccess: (created) => {
        const first = created[0];
        toast.success(created.length === 1 ? "1 Beleg angelegt" : `${created.length} Belege angelegt`, {
          description: "Als unvollständige Ausgaben gespeichert.",
          action: first ? { label: "Jetzt erfassen", onClick: () => void open(first.id) } : undefined,
        });
      },
      onError: (err) => toast.error(apiErrorMessage(err)),
    });
  };

  return (
    <Page
      title="Ausgaben"
      description="Eingangsrechnungen und Belege. Belege einfach auf die Seite ziehen, um sie schnell anzulegen."
      actions={
        <>
          <InboxButton />
          <Button
            variant="outline"
            size="sm"
            disabled={createDrafts.isPending}
            onClick={() => pickReceiptFiles(true, onFiles)}
          >
            {createDrafts.isPending ? <Loader2 className="animate-spin" /> : <Upload />}
            Belege hochladen
          </Button>
          <Button asChild size="sm">
            <Link to="/expenses/new">
              <Plus />
              Neue Ausgabe
            </Link>
          </Button>
        </>
      }
    >
      <DropOverlay
        active={dragging}
        onFiles={onFiles}
        label="Belege ablegen – je Datei wird eine Ausgabe angelegt"
        className="fixed inset-4 z-50 text-base"
      />

      {drafts.length > 0 && search.status !== "incomplete" && (
        <div className="mb-4 flex items-center gap-3 rounded-lg border border-warning-border bg-warning-muted px-4 py-2.5 text-sm">
          <span className="text-warning">
            {drafts.length === 1 ? "1 Beleg ist" : `${drafts.length} Belege sind`} noch unvollständig.
          </span>
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 text-warning"
            onClick={() => firstDraft && void open(firstDraft.id)}
          >
            Jetzt erfassen
          </Button>
          <Button
            variant="link"
            size="sm"
            className="ml-auto h-auto p-0 text-warning/80"
            onClick={() => setSearch((s) => ({ ...s, status: "incomplete" }))}
          >
            Anzeigen
          </Button>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-60">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Lieferant, Nr., Beschreibung…"
            className="h-8 pl-8"
            aria-label="Ausgaben suchen"
          />
        </div>
        <Select
          value={search.status ?? ALL}
          onValueChange={(v) => setSearch((s) => ({ ...s, status: v === ALL ? undefined : (v as ExpenseListFilter["status"]) }))}
        >
          <SelectTrigger size="sm" className="w-40" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Alle Status</SelectItem>
            <SelectSeparator />
            <SelectItem value="open">Offen</SelectItem>
            <SelectItem value="paid">Bezahlt</SelectItem>
            <SelectItem value="incomplete">Unvollständig</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={search.category ?? ALL}
          onValueChange={(v) =>
            setSearch((s) => ({ ...s, category: v === ALL ? undefined : (v as ExpenseListFilter["category"]) }))
          }
        >
          <SelectTrigger size="sm" className="w-48" aria-label="Kategorie">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Alle Kategorien</SelectItem>
            <SelectSeparator />
            <CategoryOptions />
          </SelectContent>
        </Select>
        <Select
          value={search.attachment ?? ALL}
          onValueChange={(v) =>
            setSearch((s) => ({ ...s, attachment: v === ALL ? undefined : (v as ExpenseListFilter["attachment"]) }))
          }
        >
          <SelectTrigger size="sm" className="w-36" aria-label="Beleg">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Alle Belege</SelectItem>
            <SelectSeparator />
            <SelectItem value="with">Mit Beleg</SelectItem>
            <SelectItem value="without">Ohne Beleg</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1 text-sm text-muted-foreground">
          <Input
            type="date"
            value={search.from ?? ""}
            onChange={(e) => setSearch((s) => ({ ...s, from: e.target.value || undefined }))}
            className="h-8 w-36"
            aria-label="Datum von"
          />
          <span>–</span>
          <Input
            type="date"
            value={search.to ?? ""}
            onChange={(e) => setSearch((s) => ({ ...s, to: e.target.value || undefined }))}
            className="h-8 w-36"
            aria-label="Datum bis"
          />
        </div>
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQ("");
              setSearch(() => ({}));
              receiptList.setReadyOnly(false);
            }}
          >
            <X />
            Filter zurücksetzen
          </Button>
        )}
        <span className={cn("ml-auto text-sm text-muted-foreground tabular", isFetching && "opacity-60")}>
          {data.length === 1 ? "1 Ausgabe" : `${data.length} Ausgaben`}
        </span>
      </div>

      <AnalysisToolbar state={receiptList} rows={fetched} />
      <ReceiptListScope value={receiptList} className="rounded-lg border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  const right = RIGHT.has(header.column.id);
                  return (
                    <TableHead
                      key={header.id}
                      className={cn("h-9 text-xs font-medium text-muted-foreground", right && "text-right", narrow(header.column.id))}
                    >
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className={cn(
                          "-ml-1 inline-flex items-center gap-1 rounded px-1 hover:text-foreground",
                          right && "flex-row-reverse",
                        )}
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
            {table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                tabIndex={0}
                onClick={() => void open(row.original.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void open(row.original.id);
                }}
                className="cursor-pointer focus-visible:bg-muted/50 focus-visible:outline-none"
              >
                {row.getAllCells().map((cell) => (
                  <TableCell key={cell.id} className={cn("py-2", RIGHT.has(cell.column.id) && "text-right", narrow(cell.column.id))}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS.length} className="py-16 text-center text-sm text-muted-foreground">
                  {filtered ? (
                    "Keine Ausgaben gefunden."
                  ) : (
                    <div className="space-y-3">
                      <p>Noch keine Ausgaben. Belege hierher ziehen oder eine Ausgabe anlegen.</p>
                      <Button asChild size="sm" variant="outline">
                        <Link to="/expenses/new">
                          <Plus />
                          Neue Ausgabe
                        </Link>
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
          {data.length > 0 && (
            <TableFooter className="bg-transparent">
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="py-2.5 text-xs font-normal text-muted-foreground">
                  Summe brutto{filtered ? " (gefiltert)" : ""}
                </TableCell>
                <TableCell className={NARROW} />
                <TableCell className={cn("tabular py-2.5 text-right", NARROW)}>{formatCents(sum("netCents"))}</TableCell>
                <TableCell className={cn("tabular py-2.5 text-right", NARROW)}>{formatCents(sum("taxCents"))}</TableCell>
                <TableCell className="tabular py-2.5 text-right">{formatCents(sum("grossCents"))}</TableCell>
                <TableCell colSpan={2} />
                <TableCell className={NARROW} />
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </ReceiptListScope>
    </Page>
  );
}

const EMPTY: ExpenseListItem[] = [];
