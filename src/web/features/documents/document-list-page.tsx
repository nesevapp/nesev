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
import { ArrowDown, ArrowUp, Plus, Search, X } from "lucide-react";
import { formatDate } from "@shared/dates";
import { DOCUMENT_STATUS_LABELS, type DocumentType, OVERDUE_LABEL, STATUSES_BY_TYPE } from "@shared/documents";
import { formatCents } from "@shared/money";
import type { DocumentListQuery } from "@shared/schemas/document";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClientPicker } from "@/features/clients/components/ClientPicker";
import { useDebouncedValue } from "@/features/clients/use-debounced-value";
import { cn } from "@/lib/utils";
import { type DocumentListItem, documentsQuery } from "@/sdk";
import { StatusBadge } from "./components/status-badge";
import { DOC_CONFIG, docLink } from "./config";

export type DocumentListSearch = Omit<DocumentListQuery, "type">;

const ALL = "all";

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, basic: sortFn_basic },
});
const col = createColumnHelper<typeof features, DocumentListItem>();

function dueCell(value: string | null, overdue: boolean) {
  return value ? (
    <span className={cn("tabular", overdue && "text-red-600")}>{formatDate(value)}</span>
  ) : (
    <span className="text-muted-foreground/60">–</span>
  );
}

function buildColumns(type: DocumentType) {
  const dueColumn =
    type === "offer"
      ? col.accessor((d) => d.validUntil ?? "", {
          id: "due",
          header: "Gültig bis",
          sortFn: "text",
          cell: ({ row }) => dueCell(row.original.validUntil, false),
        })
      : type === "invoice"
        ? col.accessor((d) => d.dueDate ?? "", {
            id: "due",
            header: "Fällig",
            sortFn: "text",
            cell: ({ row }) => dueCell(row.original.dueDate, row.original.overdue),
          })
        : null;
  return col.columns([
    col.accessor((d) => d.number ?? "", {
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
    col.accessor("clientName", {
      header: "Kunde",
      sortFn: "text",
      cell: ({ row }) => (
        <div className="min-w-0 max-w-80">
          <div className="truncate">{row.original.clientName}</div>
          {row.original.title && <div className="truncate text-xs text-muted-foreground">{row.original.title}</div>}
        </div>
      ),
    }),
    col.accessor("issueDate", {
      header: "Datum",
      sortFn: "text",
      cell: (info) => <span className="tabular">{formatDate(info.getValue())}</span>,
    }),
    ...(dueColumn ? [dueColumn] : []),
    col.accessor("grossCents", {
      header: "Brutto",
      sortFn: "basic",
      cell: (info) => <span className="tabular">{formatCents(info.getValue())}</span>,
    }),
    col.accessor("status", {
      header: "Status",
      sortFn: "text",
      cell: ({ row }) => <StatusBadge status={row.original.status} overdue={row.original.overdue} />,
    }),
  ]);
}

const COLUMNS = {
  offer: buildColumns("offer"),
  invoice: buildColumns("invoice"),
  credit_note: buildColumns("credit_note"),
};

export function DocumentListPage({
  type,
  search,
  setSearch,
}: {
  type: DocumentType;
  search: DocumentListSearch;
  setSearch: (update: (s: DocumentListSearch) => DocumentListSearch) => void;
}) {
  const config = DOC_CONFIG[type];
  const navigate = useNavigate();
  const [q, setQ] = useState(search.q ?? "");
  const debouncedQ = useDebouncedValue(q.trim(), 200);

  useEffect(() => {
    if (debouncedQ !== (search.q ?? "")) setSearch((s) => ({ ...s, q: debouncedQ || undefined }));
  }, [debouncedQ, search.q, setSearch]);

  const { data = EMPTY, isFetching } = useQuery(documentsQuery({ ...search, type }));
  const columns = COLUMNS[type];
  const table = useTable({
    features,
    columns,
    data,
    initialState: { sorting: [{ id: "issueDate", desc: true }] },
    enableSortingRemoval: false,
  });

  const filtered = !!(search.q || search.status || search.clientId || search.from || search.to);
  const statusOptions = [...STATUSES_BY_TYPE[type]];
  const totalCents = data.reduce((s, d) => s + d.grossCents, 0);

  return (
    <Page
      title={config.plural}
      actions={
        type !== "credit_note" && (
          <Button asChild size="sm">
            <Link to={config.create}>
              <Plus />
              {config.newLabel}
            </Link>
          </Button>
        )
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Suchen: Nummer, Kunde, Betreff…"
            className="h-8 pl-8"
            aria-label={`${config.plural} suchen`}
          />
        </div>
        <Select
          value={search.status ?? ALL}
          onValueChange={(v) =>
            setSearch((s) => ({ ...s, status: v === ALL ? undefined : (v as DocumentListSearch["status"]) }))
          }
        >
          <SelectTrigger size="sm" className="w-40" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Alle Status</SelectItem>
            <SelectSeparator />
            {statusOptions.map((s) => (
              <SelectItem key={s} value={s}>
                {DOCUMENT_STATUS_LABELS[s]}
              </SelectItem>
            ))}
            {type === "invoice" && <SelectItem value="overdue">{OVERDUE_LABEL}</SelectItem>}
          </SelectContent>
        </Select>
        <ClientPicker
          value={search.clientId}
          onChange={(c) => setSearch((s) => ({ ...s, clientId: c?.id }))}
          placeholder="Alle Kunden"
          className="h-8 w-52"
        />
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
            }}
          >
            <X />
            Filter zurücksetzen
          </Button>
        )}
        <span className={cn("ml-auto text-sm text-muted-foreground tabular", isFetching && "opacity-60")}>
          {data.length === 1 ? `1 ${config.singular}` : `${data.length} ${config.plural}`}
        </span>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  const right = header.column.id === "grossCents";
                  return (
                    <TableHead
                      key={header.id}
                      className={cn("h-9 text-xs font-medium text-muted-foreground", right && "text-right")}
                    >
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
            {table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                tabIndex={0}
                onClick={() => navigate(docLink(type, row.original.id))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") navigate(docLink(type, row.original.id));
                }}
                className="cursor-pointer focus-visible:bg-muted/50 focus-visible:outline-none"
              >
                {row.getAllCells().map((cell) => (
                  <TableCell key={cell.id} className={cn("py-2.5", cell.column.id === "grossCents" && "text-right")}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="py-16 text-center text-sm text-muted-foreground">
                  {filtered ? (
                    `Keine ${config.plural} gefunden.`
                  ) : (
                    <div className="space-y-3">
                      <p>{config.empty}</p>
                      {type !== "credit_note" && (
                        <Button asChild size="sm" variant="outline">
                          <Link to={config.create}>
                            <Plus />
                            {config.newLabel}
                          </Link>
                        </Button>
                      )}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
          {data.length > 0 && (
            <TableFooter className="bg-transparent">
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length - 2} className="py-2.5 text-xs font-normal text-muted-foreground">
                  Summe
                </TableCell>
                <TableCell className="tabular py-2.5 text-right">{formatCents(totalCents)}</TableCell>
                <TableCell />
              </TableRow>
            </TableFooter>
          )}
        </Table>
      </div>
    </Page>
  );
}

const EMPTY: DocumentListItem[] = [];
