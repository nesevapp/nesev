import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, Building2, Plus, Search, User } from "lucide-react";
import { COUNTRY_OPTIONS, countryName } from "@shared/countries";
import { CLIENT_ARCHIVED_FILTERS, formatClientNumber } from "@shared/schemas/client";
import { Page } from "@/components/page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { type Client, clientsQuery } from "@/sdk";
import { useDebouncedValue } from "./use-debounced-value";

const route = getRouteApi("/clients");

const ARCHIVED_LABELS: Record<(typeof CLIENT_ARCHIVED_FILTERS)[number], string> = {
  active: "Aktiv",
  archived: "Archiviert",
  all: "Alle",
};
const ALL_COUNTRIES = "all";

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
});
const col = createColumnHelper<typeof features, Client>();
const columns = col.columns([
  col.accessor("number", {
    header: "Nr.",
    cell: (info) => <span className="tabular text-muted-foreground">{formatClientNumber(info.getValue())}</span>,
  }),
  col.accessor("name", {
    header: "Name",
    sortFn: "text",
    cell: ({ row }) => {
      const c = row.original;
      const Icon = c.type === "company" ? Building2 : User;
      return (
        <div className="flex items-center gap-2.5">
          <Icon className="size-4 shrink-0 text-muted-foreground/70" strokeWidth={1.75} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{c.name}</span>
              {c.archivedAt && (
                <Badge variant="secondary" className="font-normal">
                  Archiviert
                </Badge>
              )}
            </div>
            {c.contactPerson && <div className="truncate text-xs text-muted-foreground">{c.contactPerson}</div>}
          </div>
        </div>
      );
    },
  }),
  col.accessor((c) => [c.zip, c.city].filter(Boolean).join(" "), {
    id: "city",
    header: "Ort",
    sortFn: "text",
    cell: (info) => info.getValue() || <span className="text-muted-foreground/60">–</span>,
  }),
  col.accessor((c) => countryName(c.country), {
    id: "country",
    header: "Land",
    sortFn: "text",
  }),
  col.accessor("email", {
    header: "E-Mail",
    enableSorting: false,
    cell: (info) => <span className="text-muted-foreground">{info.getValue()}</span>,
  }),
]);

export function ClientsPage() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/clients" });
  const [q, setQ] = useState(search.q ?? "");
  const debouncedQ = useDebouncedValue(q.trim(), 200);

  useEffect(() => {
    if (debouncedQ !== (search.q ?? "")) {
      navigate({ search: (s) => ({ ...s, q: debouncedQ || undefined }), replace: true });
    }
  }, [debouncedQ, search.q, navigate]);

  const { data = EMPTY, isFetching } = useQuery(clientsQuery(search));
  const table = useTable({
    features,
    columns,
    data,
    initialState: { sorting: [{ id: "name", desc: false }] },
    enableSortingRemoval: false,
  });

  const filtered = !!(search.q || search.country || search.archived);

  return (
    <Page
      title="Kunden"
      actions={
        <Button asChild size="sm">
          <Link to="/clients/new">
            <Plus />
            Neuer Kunde
          </Link>
        </Button>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Suchen: Name, Nummer, E-Mail, Ort…"
            className="h-8 pl-8"
            aria-label="Kunden suchen"
          />
        </div>
        <Select
          value={search.country ?? ALL_COUNTRIES}
          onValueChange={(v) => navigate({ search: (s) => ({ ...s, country: v === ALL_COUNTRIES ? undefined : v }), replace: true })}
        >
          <SelectTrigger size="sm" className="w-44" aria-label="Land">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_COUNTRIES}>Alle Länder</SelectItem>
            <SelectSeparator />
            {COUNTRY_OPTIONS.map((c) => (
              <SelectItem key={c.code} value={c.code}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div role="radiogroup" aria-label="Status" className="flex h-8 rounded-md border bg-muted/40 p-0.5">
          {CLIENT_ARCHIVED_FILTERS.map((value) => {
            const checked = (search.archived ?? "active") === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() =>
                  navigate({ search: (s) => ({ ...s, archived: value === "active" ? undefined : value }), replace: true })
                }
                className={cn(
                  "rounded-[5px] px-2.5 text-sm text-muted-foreground transition-colors",
                  checked && "bg-background font-medium text-foreground shadow-xs",
                )}
              >
                {ARCHIVED_LABELS[value]}
              </button>
            );
          })}
        </div>
        <span className={cn("ml-auto text-sm text-muted-foreground tabular", isFetching && "opacity-60")}>
          {data.length === 1 ? "1 Kunde" : `${data.length} Kunden`}
        </span>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead
                      key={header.id}
                      className={cn("h-9 text-xs font-medium text-muted-foreground", header.column.id === "number" && "w-24")}
                    >
                      {header.column.getCanSort() ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="-ml-1 inline-flex items-center gap-1 rounded px-1 hover:text-foreground"
                        >
                          <table.FlexRender header={header} />
                          {sorted === "asc" && <ArrowUp className="size-3" />}
                          {sorted === "desc" && <ArrowDown className="size-3" />}
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
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
                onClick={() => navigate({ to: "/clients/$id", params: { id: row.original.id } })}
                className={cn("cursor-pointer", row.original.archivedAt && "text-muted-foreground")}
              >
                {row.getAllCells().map((cell) => (
                  <TableCell key={cell.id} className="py-2.5">
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="py-16 text-center text-sm text-muted-foreground">
                  {filtered ? (
                    "Keine Kunden gefunden."
                  ) : (
                    <div className="space-y-3">
                      <p>Noch keine Kunden angelegt.</p>
                      <Button asChild size="sm" variant="outline">
                        <Link to="/clients/new">
                          <Plus />
                          Ersten Kunden anlegen
                        </Link>
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </Page>
  );
}

const EMPTY: Client[] = [];
