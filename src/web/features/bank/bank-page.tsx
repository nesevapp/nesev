import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Ban, History, Landmark, Link2, Link2Off, MoreHorizontal, RotateCcw, Search, Settings2, Sparkles, Upload, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { BANK_TX_STATUS_LABELS, type BankTxStatus, formatIban } from "@shared/bank";
import { formatDate } from "@shared/dates";
import { formatCents } from "@shared/money";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDebouncedValue } from "@/features/clients/use-debounced-value";
import { cn } from "@/lib/utils";
import {
  apiErrorMessage,
  bankAccountsQuery,
  bankSummaryQuery,
  type BankTransaction,
  bankTransactionsQuery,
  type MatchSuggestion,
  useApplyMatch,
  useAutoMatch,
  useSetTransactionIgnored,
  useUnmatch,
} from "@/sdk";
import { AccountForm, AccountsDialog } from "./components/account-form";
import { ImportDialog } from "./components/import-dialog";
import { ImportsDialog } from "./components/imports-dialog";
import { MatchDialog } from "./components/match-dialog";
import { Amount, type Period, PERIOD_LABELS, PERIODS, periodRange } from "./format";

export interface BankSearch {
  account?: number;
  status?: BankTxStatus | "all";
  dir?: "in" | "out";
  q?: string;
  period?: Period;
}

const th = "h-9 text-xs font-medium text-muted-foreground";
const ACCEPT = ".xml,.csv,.txt,.json,.tsv";

export function BankPage({ search, setSearch }: { search: BankSearch; setSearch: (patch: Partial<BankSearch>) => void }) {
  const { data: accounts } = useQuery(bankAccountsQuery);
  const active = (accounts ?? []).filter((a) => !a.archivedAt);
  const account = accounts?.find((a) => a.id === search.account);
  const importAccount = account ?? active[0];

  const [file, setFile] = useState<File | null>(null);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [importsOpen, setImportsOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const autoMatch = useAutoMatch();
  const [dragging, setDragging] = useState(false);

  if (accounts && accounts.length === 0) {
    return (
      <Page title="Bank" description="Kontoauszüge importieren und Zahlungen Rechnungen und Ausgaben zuordnen.">
        <div className="mx-auto max-w-lg rounded-lg border p-6">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium">
            <Landmark className="size-4" />
            Erstes Bankkonto anlegen
          </div>
          <AccountForm submitLabel="Konto anlegen" onSaved={(a) => setSearch({ account: a.id })} />
        </div>
      </Page>
    );
  }

  const openFilePicker = () => fileInput.current?.click();

  return (
    <Page
      title="Bank"
      description="Kontoauszüge importieren und Zahlungen Rechnungen und Ausgaben zuordnen."
      actions={
        <>
          <Select
            value={search.account ? String(search.account) : "all"}
            onValueChange={(v) => setSearch({ account: v === "all" ? undefined : Number(v) })}
          >
            <SelectTrigger size="sm" className="w-56" aria-label="Konto">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Alle Konten</SelectItem>
              <SelectSeparator />
              {(accounts ?? []).map((a) => (
                <SelectItem key={a.id} value={String(a.id)}>
                  {a.name}
                  {a.archivedAt && " (archiviert)"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon-sm" aria-label="Weitere Aktionen">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setAccountsOpen(true)}>
                <Settings2 />
                Konten verwalten
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setImportsOpen(true)}>
                <History />
                Importverlauf
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  autoMatch.mutate(search.account, {
                    onSuccess: (r) =>
                      r.matched ? toast.success(`${r.matched} Buchung(en) automatisch zugeordnet`) : toast.info("Keine eindeutigen Treffer gefunden"),
                    onError: (err) => toast.error(apiErrorMessage(err)),
                  })
                }
              >
                <Wand2 />
                Automatisch zuordnen
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" onClick={openFilePicker} disabled={!importAccount} title={importAccount ? `Import in ${importAccount.name}` : undefined}>
            <Upload />
            Importieren
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              e.target.value = "";
            }}
          />
        </>
      }
    >
      <div
        onDragOver={(e) => {
          if (!importAccount || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files[0];
          if (f && importAccount) setFile(f);
        }}
        className={cn("relative", dragging && "after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:border-2 after:border-dashed after:border-primary/50 after:bg-primary/5")}
      >
        <Summary search={search} setSearch={setSearch} />
        <Transactions search={search} setSearch={setSearch} onImport={openFilePicker} hasAccount={!!importAccount} />
      </div>

      <ImportDialog file={file} account={importAccount} onClose={() => setFile(null)} />
      <AccountsDialog open={accountsOpen} onOpenChange={setAccountsOpen} />
      <ImportsDialog accountId={search.account} open={importsOpen} onOpenChange={setImportsOpen} />
    </Page>
  );
}

// ── Summary ─────────────────────────────────────────────────────────────────────

function Summary({ search, setSearch }: { search: BankSearch; setSearch: (patch: Partial<BankSearch>) => void }) {
  const period = search.period ?? "all";
  const { data: s } = useQuery(bankSummaryQuery({ accountId: search.account, ...periodRange(period) }));
  const stat = (label: string, value: React.ReactNode, onClick?: () => void) => (
    <button
      type="button"
      disabled={!onClick}
      onClick={onClick}
      className="grid gap-0.5 rounded-md px-3 py-2 text-left enabled:hover:bg-muted/60"
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-base font-medium">{value}</span>
    </button>
  );
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border px-2 py-1">
      {stat("Eingänge", <Amount cents={s?.inCents ?? 0} />, () => setSearch({ dir: "in", status: "all" }))}
      {stat("Ausgänge", <Amount cents={s?.outCents ?? 0} />, () => setSearch({ dir: "out", status: "all" }))}
      {stat(
        "Kontostand-Differenz",
        <span className={cn("tabular", (s?.netCents ?? 0) < 0 && "text-danger")}>{formatCents(s?.netCents ?? 0)}</span>,
      )}
      {stat(
        "Offen",
        <span className="tabular">
          {s?.openCount ?? 0}
          {s && s.openCount > 0 && (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              {s.openInCount} ein · {s.openOutCount} aus
            </span>
          )}
        </span>,
        () => setSearch({ status: "open", dir: undefined }),
      )}
      <div className="ml-auto flex items-center gap-2 pr-1">
        {s?.firstDate && (
          <span className="text-xs text-muted-foreground tabular">
            {formatDate(s.firstDate)} – {formatDate(s.lastDate)}
          </span>
        )}
        <Select value={period} onValueChange={(v) => setSearch({ period: v === "all" ? undefined : (v as Period) })}>
          <SelectTrigger size="sm" className="w-48" aria-label="Zeitraum">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map((p) => (
              <SelectItem key={p} value={p}>
                {PERIOD_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

// ── Transactions ────────────────────────────────────────────────────────────────

function Transactions({
  search,
  setSearch,
  onImport,
  hasAccount,
}: {
  search: BankSearch;
  setSearch: (patch: Partial<BankSearch>) => void;
  onImport: () => void;
  hasAccount: boolean;
}) {
  const status = search.status ?? "open";
  const [q, setQ] = useState(search.q ?? "");
  const debounced = useDebouncedValue(q, 250);
  useEffect(() => {
    if ((search.q ?? "") !== debounced) setSearch({ q: debounced || undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  useEffect(() => setQ(search.q ?? ""), [search.q]);

  const { data, isLoading } = useQuery(
    bankTransactionsQuery({
      accountId: search.account,
      status: status === "all" ? undefined : status,
      direction: search.dir,
      q: search.q,
      ...periodRange(search.period ?? "all"),
    }),
  );
  const rows = data ?? [];
  const [matching, setMatching] = useState<BankTransaction | null>(null);
  const apply = useApplyMatch();
  const unmatch = useUnmatch();
  const ignore = useSetTransactionIgnored();
  const searchRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLTableSectionElement>(null);

  // "/" focuses the search
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key !== "/" || el.closest("input, textarea, [contenteditable], [role=dialog]")) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const applySuggestion = (tx: BankTransaction, s: MatchSuggestion) =>
    apply.mutate(
      {
        transactionId: tx.id,
        json: { allocations: [s.kind === "document" ? { documentId: s.id, amountCents: s.amountCents } : { expenseId: s.id, amountCents: s.amountCents }] },
      },
      {
        onSuccess: () => toast.success(`${tx.counterpartyName || "Buchung"} → ${s.number || s.name}`),
        onError: (err) => toast.error(apiErrorMessage(err)),
      },
    );
  const toggleIgnore = (tx: BankTransaction) =>
    ignore.mutate(
      { id: tx.id, ignored: tx.status !== "ignored" },
      { onError: (err) => toast.error(apiErrorMessage(err)) },
    );
  const unmatchAll = (tx: BankTransaction) =>
    unmatch.mutate({ transactionId: tx.id }, { onSuccess: () => toast.success("Zuordnung gelöst"), onError: (err) => toast.error(apiErrorMessage(err)) });

  const focusRow = (from: HTMLElement, delta: number) => {
    const all = [...(tableRef.current?.querySelectorAll<HTMLElement>("tr[data-tx]") ?? [])];
    const next = all[all.indexOf(from) + delta];
    next?.focus();
  };

  const onRowKey = (e: KeyboardEvent<HTMLTableRowElement>, tx: BankTransaction) => {
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return;
    const top = tx.suggestions[0];
    const key = e.key.toLowerCase();
    if (key === "arrowdown" || key === "j") focusRow(e.currentTarget, 1);
    else if (key === "arrowup" || key === "k") focusRow(e.currentTarget, -1);
    else if ((key === "enter" || key === "z") && top && tx.status === "open") applySuggestion(tx, top);
    else if (key === "m" || (key === "enter" && tx.status === "open")) setMatching(tx);
    else if (key === "i" && tx.matches.length === 0) toggleIgnore(tx);
    else if (key === "u" && tx.matches.length > 0) unmatchAll(tx);
    else return;
    e.preventDefault();
  };

  const counts = { open: 0 };
  for (const r of rows) if (r.status === "open") counts.open++;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Tabs value={status} onValueChange={(v) => setSearch({ status: v === "open" ? undefined : (v as BankSearch["status"]) })}>
          <TabsList>
            {(["open", "matched", "ignored", "all"] as const).map((s) => (
              <TabsTrigger key={s} value={s}>
                {s === "all" ? "Alle" : BANK_TX_STATUS_LABELS[s]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Tabs value={search.dir ?? "both"} onValueChange={(v) => setSearch({ dir: v === "both" ? undefined : (v as "in" | "out") })}>
          <TabsList>
            <TabsTrigger value="both">Ein & Aus</TabsTrigger>
            <TabsTrigger value="in">Eingänge</TabsTrigger>
            <TabsTrigger value="out">Ausgänge</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative ml-auto w-72">
          <Search className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQ("");
              if (e.key === "ArrowDown") {
                e.preventDefault();
                tableRef.current?.querySelector<HTMLElement>("tr[data-tx]")?.focus();
              }
            }}
            placeholder="Name, Zweck, Betrag, RE-Nr. …  ( / )"
            className="h-8 pl-8"
          />
        </div>
      </div>

      <div className="rounded-lg border">
        {/* fixed columns add up to 840px: keep room for Verwendungszweck, scroll horizontally in a narrow content area */}
        <Table className="min-w-[60rem] table-fixed">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className={cn(th, "w-24")}>Datum</TableHead>
              <TableHead className={cn(th, "w-48")}>Gegenpartei</TableHead>
              <TableHead className={th}>Verwendungszweck</TableHead>
              <TableHead className={cn(th, "w-32 text-right")}>Betrag</TableHead>
              <TableHead className={cn(th, "w-96")}>Zuordnung</TableHead>
              <TableHead className={cn(th, "w-10")} />
            </TableRow>
          </TableHeader>
          <TableBody ref={tableRef}>
            {rows.map((tx) => (
              <TableRow
                key={tx.id}
                data-tx={tx.id}
                tabIndex={0}
                onKeyDown={(e) => onRowKey(e, tx)}
                className={cn("align-top focus-visible:bg-muted/60 focus-visible:outline-none", tx.status === "ignored" && "text-muted-foreground")}
              >
                <TableCell className="py-2.5 tabular">{formatDate(tx.bookingDate)}</TableCell>
                <TableCell className="py-2.5">
                  <div className="truncate font-medium" title={tx.counterpartyName}>
                    {tx.counterpartyName || <span className="font-normal text-muted-foreground">–</span>}
                  </div>
                  {tx.counterpartyIban && <div className="truncate text-xs text-muted-foreground tabular">{formatIban(tx.counterpartyIban)}</div>}
                  {!search.account && <div className="truncate text-xs text-muted-foreground">{tx.accountName}</div>}
                </TableCell>
                <TableCell className="py-2.5">
                  <div className="line-clamp-2 text-sm break-words whitespace-normal" title={tx.purpose}>
                    {tx.purpose || <span className="text-muted-foreground">–</span>}
                  </div>
                </TableCell>
                <TableCell className="py-2.5 text-right font-medium">
                  <Amount cents={tx.amountCents} />
                </TableCell>
                <TableCell className="overflow-hidden py-2 whitespace-normal">
                  <Assignment tx={tx} busy={apply.isPending} onApply={(s) => applySuggestion(tx, s)} onManual={() => setMatching(tx)} />
                </TableCell>
                <TableCell className="py-1.5 text-right">
                  <RowMenu tx={tx} onManual={() => setMatching(tx)} onIgnore={() => toggleIgnore(tx)} onUnmatch={() => unmatchAll(tx)} />
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="py-16 text-center text-sm whitespace-normal text-muted-foreground">
                  {isLoading ? (
                    "Laden…"
                  ) : status === "open" && !search.q ? (
                    <div className="grid justify-items-center gap-3">
                      <span>Keine offenen Buchungen{search.dir ? " in dieser Richtung" : ""}.</span>
                      {hasAccount && (
                        <Button variant="outline" size="sm" onClick={onImport}>
                          <Upload />
                          Kontoauszug importieren
                        </Button>
                      )}
                      <span className="text-xs">camt.053 (XML), George JSON oder CSV (George, ELBA, BAWAG, N26, Revolut, Wise, andere) – auch per Drag & Drop.</span>
                    </div>
                  ) : (
                    "Keine Buchungen gefunden."
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Tastatur: ↑ ↓ oder j k wählen · Enter/Z Vorschlag zuordnen · M manuell zuordnen · I ignorieren · U Zuordnung lösen · / suchen
        {counts.open > 0 && status !== "open" && ` · ${counts.open} offen in dieser Ansicht`}
      </p>

      <MatchDialog tx={matching} onClose={() => setMatching(null)} />
    </>
  );
}

function MatchChip({ m }: { m: BankTransaction["matches"][number] }) {
  const label = m.documentId ? m.documentNumber || "Beleg" : m.expenseNumber || m.supplierName || "Ausgabe";
  const sub = m.documentId ? m.clientName : m.supplierName;
  const cls = "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs hover:bg-muted";
  const content = (
    <>
      <Link2 className="size-3 shrink-0 text-muted-foreground" />
      <span className="font-medium tabular">{label}</span>
      {sub && <span className="truncate text-muted-foreground">{sub}</span>}
    </>
  );
  if (m.documentId) {
    const to = m.documentType === "credit_note" ? "/credit-notes/$id" : "/invoices/$id";
    return (
      <Link to={to} params={{ id: m.documentId }} className={cls} title={formatCents(m.amountCents)}>
        {content}
      </Link>
    );
  }
  return (
    <Link to="/expenses/$id" params={{ id: m.expenseId! }} className={cls} title={formatCents(m.amountCents)}>
      {content}
    </Link>
  );
}

const CONFIDENCE_DOT: Record<MatchSuggestion["confidence"], string> = {
  high: "bg-success-solid",
  medium: "bg-warning-solid",
  low: "bg-muted-foreground/40",
};

function Assignment({
  tx,
  busy,
  onApply,
  onManual,
}: {
  tx: BankTransaction;
  busy: boolean;
  onApply: (s: MatchSuggestion) => void;
  onManual: () => void;
}) {
  if (tx.status === "ignored") return <span className="text-xs">Ignoriert</span>;
  const split = tx.matches.length > 1;
  return (
    <div className="grid gap-1.5">
      {tx.matches.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {tx.matches.map((m) => (
            <span key={m.id} className="inline-flex max-w-full items-center gap-1">
              <MatchChip m={m} />
              {split && <span className="text-xs text-muted-foreground tabular">{formatCents(m.amountCents)}</span>}
            </span>
          ))}
        </div>
      )}
      {tx.status === "open" && tx.allocatedCents > 0 && (
        <span className="text-xs text-warning tabular">Rest {formatCents(tx.remainingCents)} nicht zugeordnet</span>
      )}
      {tx.status === "open" &&
        (tx.suggestions.length > 0 ? (
          <Suggestion s={tx.suggestions[0]!} remaining={tx.remainingCents} more={tx.suggestions.length - 1} busy={busy} onApply={onApply} onMore={onManual} />
        ) : (
          tx.matches.length === 0 && (
            <button type="button" onClick={onManual} className="w-fit text-xs text-muted-foreground hover:text-foreground hover:underline">
              Kein Vorschlag – manuell zuordnen
            </button>
          )
        ))}
    </div>
  );
}

function Suggestion({
  s,
  remaining,
  more,
  busy,
  onApply,
  onMore,
}: {
  s: MatchSuggestion;
  remaining: number;
  more: number;
  busy: boolean;
  onApply: (s: MatchSuggestion) => void;
  onMore: () => void;
}) {
  const reasons = s.reasons.filter((r) => r.code !== "overpaid" && r.code !== "partial").map((r) => r.label);
  const note =
    s.dueCents === 0
      ? null
      : s.amountCents < remaining
      ? `Teilbetrag ${formatCents(s.amountCents)}`
      : s.amountCents > s.openCents
        ? `Überzahlung ${formatCents(s.amountCents - s.openCents)}`
        : s.amountCents < s.openCents
          ? `Teilzahlung, offen ${formatCents(s.openCents)}`
          : null;
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Button
        size="sm"
        variant={s.confidence === "high" ? "default" : "outline"}
        className="h-7 shrink-0 px-2 text-xs"
        disabled={busy}
        onClick={() => onApply(s)}
        title={reasons.join(" · ")}
      >
        <Sparkles />
        Zuordnen
      </Button>
      <div className="min-w-0 text-xs leading-tight">
        <div className="flex items-center gap-1.5">
          <span className={cn("size-1.5 shrink-0 rounded-full", CONFIDENCE_DOT[s.confidence])} />
          <span className="font-medium whitespace-nowrap tabular">{s.number || "ohne Nr."}</span>
          <span className="truncate text-muted-foreground">{s.name}</span>
        </div>
        <div className="truncate text-muted-foreground" title={reasons.join(" · ")}>
          {reasons.join(" · ")}
        </div>
        {(note || more > 0) && (
          <div className="text-muted-foreground">
            {note && <span className="text-warning">{note}</span>}
            {note && more > 0 && " · "}
            {more > 0 && (
              <button type="button" className="hover:text-foreground hover:underline" onClick={onMore}>
                +{more} weitere
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function RowMenu({
  tx,
  onManual,
  onIgnore,
  onUnmatch,
}: {
  tx: BankTransaction;
  onManual: () => void;
  onIgnore: () => void;
  onUnmatch: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Aktionen" tabIndex={-1}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {tx.status !== "ignored" && tx.remainingCents > 0 && (
          <DropdownMenuItem onSelect={onManual}>
            <Link2 />
            Manuell zuordnen…
            <DropdownMenuShortcut>M</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        {tx.matches.length > 0 && (
          <DropdownMenuItem onSelect={onUnmatch}>
            <Link2Off />
            Zuordnung lösen
            <DropdownMenuShortcut>U</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        {tx.matches.length === 0 && (
          <>
            {tx.status !== "ignored" && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={onIgnore}>
              {tx.status === "ignored" ? <RotateCcw /> : <Ban />}
              {tx.status === "ignored" ? "Wieder öffnen" : "Ignorieren (privat / irrelevant)"}
              <DropdownMenuShortcut>I</DropdownMenuShortcut>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

