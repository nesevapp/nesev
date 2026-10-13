import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
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
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@shared/dates";
import { formatBp, formatCents } from "@shared/money";
import { ARTICLE_ARCHIVED_FILTERS, formatArticleNumber } from "@shared/schemas/article";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDebouncedValue } from "@/features/clients/use-debounced-value";
import { cn } from "@/lib/utils";
import { apiErrorMessage, type Article, articlesQuery, useDeleteArticle, useSetArticleArchived } from "@/sdk";
import { ArticleFormDialog } from "./components/article-form-dialog";

const route = getRouteApi("/articles");

const ARCHIVED_LABELS: Record<typeof ARTICLE_ARCHIVED_FILTERS[number], string> = {
  active: "Aktiv",
  archived: "Archiviert",
  all: "Alle",
};

type Dialog = { kind: "edit"; article: Article | null } | { kind: "delete"; article: Article } | null;

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, basic: sortFn_basic },
});
const col = createColumnHelper<typeof features, Article>();

const NUMERIC_COLUMNS = new Set(["unitPriceCents", "usageCount"]);

export function ArticlesPage() {
  const search = route.useSearch();
  const navigate = useNavigate({ from: "/articles" });
  const [q, setQ] = useState(search.q ?? "");
  const debouncedQ = useDebouncedValue(q.trim(), 200);
  const [dialog, setDialog] = useState<Dialog>(null);
  const archive = useSetArticleArchived();

  useEffect(() => {
    if (debouncedQ !== (search.q ?? "")) {
      navigate({ search: (s) => ({ ...s, q: debouncedQ || undefined }), replace: true });
    }
  }, [debouncedQ, search.q, navigate]);

  const { mutate: setArchived } = archive;
  const columns = useMemo(() => {
    const toggleArchived = (a: Article) =>
      setArchived(
        { id: a.id, archived: !a.archivedAt },
        {
          onSuccess: (saved) => toast.success(saved.archivedAt ? "Artikel archiviert" : "Artikel wiederhergestellt"),
          onError: (err) => toast.error(apiErrorMessage(err)),
        },
      );

    return col.columns([
      col.accessor("number", {
        header: "Nr.",
        sortFn: "basic",
        cell: (info) => <span className="tabular text-muted-foreground">{formatArticleNumber(info.getValue())}</span>,
      }),
      col.accessor("title", {
        header: "Bezeichnung",
        sortFn: "text",
        cell: ({ row }) => {
          const a = row.original;
          return (
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{a.title}</span>
                {a.archivedAt && (
                  <Badge variant="secondary" className="font-normal">
                    Archiviert
                  </Badge>
                )}
              </div>
              {a.description && <div className="line-clamp-1 text-xs text-muted-foreground">{a.description}</div>}
            </div>
          );
        },
      }),
      col.accessor("unit", {
        header: "Einheit",
        sortFn: "text",
        cell: (info) => info.getValue() || <span className="text-muted-foreground/60">–</span>,
      }),
      col.accessor("unitPriceCents", {
        header: "Preis netto",
        sortFn: "basic",
        cell: (info) => <span className="tabular">{formatCents(info.getValue())}</span>,
      }),
      col.accessor("taxRateBp", {
        header: "USt.",
        sortFn: "basic",
        cell: (info) => <span className="tabular text-muted-foreground">{formatBp(info.getValue())}</span>,
      }),
      col.accessor("usageCount", {
        header: "Verwendet",
        sortFn: "basic",
        sortDescFirst: true,
        cell: ({ row }) => {
          const a = row.original;
          return (
            <span
              className="tabular text-muted-foreground"
              title={a.lastUsedAt ? `Zuletzt verwendet am ${formatDate(a.lastUsedAt.slice(0, 10))}` : undefined}
            >
              {a.usageCount === 0 ? "–" : `${a.usageCount}×`}
            </span>
          );
        },
      }),
      col.display({
        id: "actions",
        cell: ({ row }) => {
          const a = row.original;
          return (
            // keep row clicks (= edit) from firing for the menu
            <div onClick={(e) => e.stopPropagation()} className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Aktionen für ${a.title}`}
                    className="text-muted-foreground"
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setDialog({ kind: "edit", article: a })}>
                    <Pencil />
                    Bearbeiten
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => toggleArchived(a)}>
                    {a.archivedAt ? <ArchiveRestore /> : <Archive />}
                    {a.archivedAt ? "Wiederherstellen" : "Archivieren"}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setDialog({ kind: "delete", article: a })}>
                    <Trash2 />
                    Löschen
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        },
      }),
    ]);
  }, [setArchived]);

  const { data = EMPTY, isFetching } = useQuery(articlesQuery({ q: search.q, archived: search.archived }));
  const table = useTable({
    features,
    columns,
    data,
    initialState: { sorting: [{ id: "title", desc: false }] },
    enableSortingRemoval: false,
  });

  const filtered = !!(search.q || search.archived);
  const newArticle = () => setDialog({ kind: "edit", article: null });

  return (
    <Page
      title="Artikel"
      description="Leistungen und Produkte zum schnellen Einfügen in Angebote und Rechnungen."
      actions={
        <Button size="sm" onClick={newArticle}>
          <Plus />
          Neuer Artikel
        </Button>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Suchen: Bezeichnung, Nummer…"
            className="h-8 pl-8"
            aria-label="Artikel suchen"
          />
        </div>
        <div role="radiogroup" aria-label="Status" className="flex h-8 rounded-md border bg-muted/40 p-0.5">
          {ARTICLE_ARCHIVED_FILTERS.map((value) => {
            const checked = (search.archived ?? "active") === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() =>
                  navigate({
                    search: (s) => ({ ...s, archived: value === "active" ? undefined : value }),
                    replace: true,
                  })
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
          {data.length === 1 ? "1 Artikel" : `${data.length} Artikel`}
        </span>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  const id = header.column.id;
                  return (
                    <TableHead
                      key={header.id}
                      className={cn(
                        "h-9 text-xs font-medium text-muted-foreground",
                        id === "number" && "w-24",
                        id === "unit" && "w-24",
                        id === "taxRateBp" && "w-20",
                        id === "usageCount" && "w-28",
                        id === "actions" && "w-12",
                        NUMERIC_COLUMNS.has(id) && "text-right",
                      )}
                    >
                      {header.column.getCanSort() ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={cn(
                            "-ml-1 inline-flex items-center gap-1 rounded px-1 hover:text-foreground",
                            NUMERIC_COLUMNS.has(id) && "-mr-1 ml-0 flex-row-reverse",
                          )}
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
                onClick={() => setDialog({ kind: "edit", article: row.original })}
                className={cn("cursor-pointer", row.original.archivedAt && "text-muted-foreground")}
              >
                {row.getAllCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className={cn(
                      "py-2.5",
                      NUMERIC_COLUMNS.has(cell.column.id) && "text-right",
                      cell.column.id === "title" && "max-w-0 w-full",
                    )}
                  >
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="py-16 text-center text-sm text-muted-foreground">
                  {filtered ? (
                    "Keine Artikel gefunden."
                  ) : (
                    <div className="space-y-3">
                      <p>Noch keine Artikel angelegt.</p>
                      <Button size="sm" variant="outline" onClick={newArticle}>
                        <Plus />
                        Ersten Artikel anlegen
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <ArticleFormDialog
        open={dialog?.kind === "edit"}
        onOpenChange={(open) => !open && setDialog(null)}
        article={dialog?.kind === "edit" ? dialog.article : null}
      />
      <DeleteArticleDialog
        article={dialog?.kind === "delete" ? dialog.article : null}
        onClose={() => setDialog(null)}
      />
    </Page>
  );
}

function DeleteArticleDialog({ article, onClose }: { article: Article | null; onClose: () => void }) {
  const del = useDeleteArticle();
  return (
    <AlertDialog open={!!article} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Artikel löschen?</AlertDialogTitle>
          <AlertDialogDescription>
            „{article?.title}“ wird endgültig aus dem Katalog gelöscht. Positionen in bestehenden Belegen bleiben
            unverändert.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Abbrechen</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={del.isPending}
            onClick={(e) => {
              e.preventDefault();
              if (!article) return;
              del.mutate(article.id, {
                onSuccess: () => {
                  toast.success("Artikel gelöscht");
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

const EMPTY: Article[] = [];
