import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@shared/dates";
import { centsToInput, formatCents, parseMoneyToCents } from "@shared/money";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/features/clients/use-debounced-value";
import { cn } from "@/lib/utils";
import {
  apiErrorMessage,
  type BankTransaction,
  matchCandidatesQuery,
  type MatchSuggestion,
  useApplyMatch,
} from "@/sdk";
import { Amount } from "../format";

type Selected = { s: MatchSuggestion; input: string };
const keyOf = (s: Pick<MatchSuggestion, "kind" | "id">) => `${s.kind}-${s.id}`;

/** Manual matching: search open invoices (incoming) or expenses (outgoing), split the amount across several. */
export function MatchDialog({ tx, onClose }: { tx: BankTransaction | null; onClose: () => void }) {
  return (
    <Dialog open={!!tx} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] grid-rows-[auto_auto_minmax(0,1fr)_auto] sm:max-w-3xl">
        {tx && <MatchForm key={tx.id} tx={tx} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function MatchForm({ tx, onClose }: { tx: BankTransaction; onClose: () => void }) {
  const incoming = tx.amountCents > 0;
  const [q, setQ] = useState("");
  const debounced = useDebouncedValue(q, 200);
  const { data: candidates = [], isFetching } = useQuery(
    matchCandidatesQuery({ direction: incoming ? "in" : "out", q: debounced, transactionId: tx.id }),
  );
  const [selected, setSelected] = useState<Map<string, Selected>>(new Map());
  const apply = useApplyMatch();

  const amounts = [...selected.values()].map((x) => parseMoneyToCents(x.input));
  const invalid = amounts.some((a) => a === null || a <= 0);
  const total = amounts.reduce<number>((s, a) => s + (a ?? 0), 0);
  const rest = tx.remainingCents - total;

  const toggle = (s: MatchSuggestion) =>
    setSelected((cur) => {
      const next = new Map(cur);
      if (next.has(keyOf(s))) next.delete(keyOf(s));
      else {
        const used = [...cur.values()].reduce((sum, x) => sum + (parseMoneyToCents(x.input) ?? 0), 0);
        const free = Math.max(tx.remainingCents - used, 0);
        // up to the open amount; an overpayment is entered by editing the amount
        // expenses without amounts yet take the free amount
        const cents = s.dueCents === 0 ? free : free > 0 ? Math.min(free, s.openCents) : s.openCents;
        next.set(keyOf(s), { s, input: centsToInput(cents) });
      }
      return next;
    });

  const submit = () => {
    const allocations = [...selected.values()].map(({ s, input }) => ({
      ...(s.kind === "document" ? { documentId: s.id } : { expenseId: s.id }),
      amountCents: parseMoneyToCents(input)!,
    }));
    apply.mutate(
      { transactionId: tx.id, json: { allocations } },
      {
        onSuccess: () => {
          toast.success(allocations.length === 1 ? "Zugeordnet" : `${allocations.length} Belegen zugeordnet`);
          onClose();
        },
        onError: (err) => toast.error(apiErrorMessage(err)),
      },
    );
  };

  // selected entries stay visible even when the search no longer finds them
  const listed = [...[...selected.values()].map((x) => x.s).filter((s) => !candidates.some((c) => keyOf(c) === keyOf(s))), ...candidates];

  return (
    <>
      <DialogHeader>
        <DialogTitle>{incoming ? "Zahlungseingang zuordnen" : "Zahlungsausgang zuordnen"}</DialogTitle>
        <DialogDescription asChild>
          <div className="grid gap-0.5 text-sm">
            <div className="flex items-baseline gap-3">
              <span className="tabular">{formatDate(tx.bookingDate)}</span>
              <span className="font-medium text-foreground">{tx.counterpartyName || "–"}</span>
              <Amount cents={tx.amountCents} className="ml-auto font-medium" />
            </div>
            {tx.purpose && <div className="line-clamp-2">{tx.purpose}</div>}
            {tx.allocatedCents > 0 && (
              <div>
                Bereits zugeordnet: <span className="tabular">{formatCents(tx.allocatedCents)}</span> · offen{" "}
                <span className="tabular">{formatCents(tx.remainingCents)}</span>
              </div>
            )}
          </div>
        </DialogDescription>
      </DialogHeader>

      <div className="relative">
        <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
        <Input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={incoming ? "Rechnungsnummer, Kunde oder Betrag suchen…" : "Lieferant, Belegnummer oder Betrag suchen…"}
          className="pl-8"
        />
      </div>

      <div className={cn("-mx-6 min-h-48 overflow-y-auto px-6", isFetching && "opacity-70")}>
        <ul className="divide-y rounded-lg border text-sm">
          {listed.map((s) => {
            const sel = selected.get(keyOf(s));
            const amount = sel ? parseMoneyToCents(sel.input) : null;
            const over = amount !== null && s.dueCents > 0 && amount > s.openCents ? amount - s.openCents : 0;
            return (
              <li key={keyOf(s)} className={cn("grid gap-1 px-3 py-2", sel && "bg-muted/40")}>
                <div className="flex items-center gap-3">
                  <Checkbox checked={!!sel} onCheckedChange={() => toggle(s)} aria-label={`${s.number} auswählen`} />
                  <button type="button" className="grid min-w-0 flex-1 text-left" onClick={() => toggle(s)}>
                    <span className="flex items-baseline gap-2">
                      <span className="font-medium tabular">{s.number || "ohne Nummer"}</span>
                      <span className="truncate">{s.name}</span>
                      <span className="text-xs text-muted-foreground tabular">{formatDate(s.issueDate)}</span>
                    </span>
                    {s.reasons.length > 0 && (
                      <span className="truncate text-xs text-muted-foreground">
                        {s.reasons.filter((r) => r.code !== "overpaid" && r.code !== "partial").map((r) => r.label).join(" · ")}
                      </span>
                    )}
                  </button>
                  <div className="text-right text-xs">
                    <div className="tabular text-sm">{formatCents(s.openCents)}</div>
                    {s.paidCents > 0 && <div className="text-muted-foreground">offen von {formatCents(s.dueCents)}</div>}
                  </div>
                  {sel && (
                    <Input
                      value={sel.input}
                      onChange={(e) =>
                        setSelected((cur) => new Map(cur).set(keyOf(s), { s, input: e.target.value }))
                      }
                      aria-label="Zugeordneter Betrag"
                      className="h-8 w-28 text-right tabular"
                      aria-invalid={amount === null || amount <= 0 || undefined}
                    />
                  )}
                </div>
                {over > 0 && (
                  <div className="pl-7 text-xs text-amber-700">Überzahlung um {formatCents(over)}</div>
                )}
              </li>
            );
          })}
          {listed.length === 0 && (
            <li className="px-3 py-10 text-center text-muted-foreground">
              {incoming ? "Keine offenen Rechnungen gefunden." : "Keine offenen Ausgaben gefunden."}
            </li>
          )}
        </ul>
      </div>

      <DialogFooter className="items-center">
        <span className={cn("mr-auto text-sm tabular", rest < 0 ? "text-red-600" : "text-muted-foreground")}>
          {selected.size === 0
            ? "Beleg(e) auswählen – Betrag lässt sich aufteilen."
            : rest < 0
              ? `Übersteigt die Buchung um ${formatCents(-rest)}`
              : rest > 0
                ? `Zugeordnet ${formatCents(total)} · Rest ${formatCents(rest)} bleibt offen`
                : `Zugeordnet ${formatCents(total)} – vollständig`}
          {selected.size > 0 && rest > 0 && !invalid && (
            <Button
              variant="link"
              size="sm"
              className="h-auto px-2 py-0 text-xs"
              onClick={() => {
                const [k, last] = [...selected.entries()].at(-1)!;
                setSelected(new Map(selected).set(k, { ...last, input: centsToInput(parseMoneyToCents(last.input)! + rest) }));
              }}
            >
              Rest als Überzahlung zuordnen
            </Button>
          )}
        </span>
        <Button variant="outline" onClick={onClose}>
          Abbrechen
        </Button>
        <Button onClick={submit} disabled={selected.size === 0 || invalid || rest < 0 || apply.isPending}>
          Zuordnen
        </Button>
      </DialogFooter>
    </>
  );
}
