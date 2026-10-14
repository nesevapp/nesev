import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FilePlus2, Link2, Unlink } from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@shared/dates";
import { formatCents } from "@shared/money";
import { intervalLabel } from "@shared/recurring";
import { slotLabel } from "@shared/recurring-expenses";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  apiErrorMessage,
  type RecurringExpense,
  recurringExpenseCandidatesQuery,
  recurringExpenseScheduleQuery,
  type RecurringExpenseSlot,
  useLinkFixedCostPayment,
  useUnlinkFixedCostPayment,
} from "@/sdk";

/** Payment slots of one Fixkosten entry: linked expense, open, or past without a receipt. */
export function FixedCostScheduleDialog({ item, onClose }: { item: RecurringExpense | null; onClose: () => void }) {
  const [shown, setShown] = useState<RecurringExpense | null>(null);
  if (item && item !== shown) setShown(item);
  const current = item ?? shown;
  return (
    <Dialog open={!!item} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Zahlungen · {current?.name}</DialogTitle>
          <DialogDescription>
            {current && `${intervalLabel(current)} · ${formatCents(current.grossCents)}`}. Verknüpfte Termine plant die
            Prognose nicht mehr ein – dort zählt die erfasste Ausgabe.
          </DialogDescription>
        </DialogHeader>
        {current && <Schedule id={current.id} />}
      </DialogContent>
    </Dialog>
  );
}

function Schedule({ id }: { id: number }) {
  const { data } = useQuery(recurringExpenseScheduleQuery(id));
  const [picking, setPicking] = useState<string | null>(null);
  if (!data) return <div className="h-40" />;
  // newest first: upcoming at the top
  const slots = [...data.slots].reverse();
  return (
    <div className="-mx-1 max-h-[60vh] divide-y overflow-y-auto px-1">
      {slots.map((slot) => (
        <SlotRow
          key={slot.date}
          fixedCostId={id}
          slot={slot}
          picking={picking === slot.date}
          onPick={(on) => setPicking(on ? slot.date : null)}
        />
      ))}
    </div>
  );
}

function StatusBadge({ slot }: { slot: RecurringExpenseSlot }) {
  if (slot.status === "linked") {
    return slot.expense?.paidAt ? (
      <Badge variant="secondary" className="font-normal">bezahlt</Badge>
    ) : (
      <Badge variant="outline" className="font-normal">verknüpft · offen</Badge>
    );
  }
  if (slot.status === "missing") return <Badge variant="outline" className="border-amber-300 font-normal text-amber-800">überfällig – ohne Beleg</Badge>;
  return <span className="text-xs text-muted-foreground">geplant</span>;
}

function SlotRow({
  fixedCostId,
  slot,
  picking,
  onPick,
}: {
  fixedCostId: number;
  slot: RecurringExpenseSlot;
  picking: boolean;
  onPick: (on: boolean) => void;
}) {
  const unlink = useUnlinkFixedCostPayment();
  const e = slot.expense;
  return (
    <div className="py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <div className="w-28">
          <div className="text-sm font-medium">{slotLabel(slot.date)}</div>
          <div className="text-xs text-muted-foreground tabular">{formatDate(slot.date)}</div>
        </div>
        <div className="w-40">
          <StatusBadge slot={slot} />
        </div>
        <div className="min-w-0 flex-1 text-sm">
          {e && (
            <>
              <Link to="/expenses/$id" params={{ id: e.id }} className="font-medium underline-offset-4 hover:underline">
                {e.number ?? "Ausgabe"}
              </Link>
              <span className="ml-2 text-muted-foreground">
                {formatDate(e.issueDate)} · <span className="tabular">{formatCents(e.grossCents)}</span>
              </span>
            </>
          )}
        </div>
        <div className="flex gap-1">
          {e ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={unlink.isPending}
              onClick={() =>
                unlink.mutate(e.id, {
                  onSuccess: () => toast.success("Verknüpfung gelöst"),
                  onError: (err) => toast.error(apiErrorMessage(err)),
                })
              }
            >
              <Unlink />
              Verknüpfung lösen
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/expenses/new" search={{ fixedCost: fixedCostId, slot: slot.date }}>
                  <FilePlus2 />
                  Ausgabe erfassen
                </Link>
              </Button>
              <Button variant={picking ? "secondary" : "ghost"} size="sm" onClick={() => onPick(!picking)}>
                <Link2 />
                Verknüpfen
              </Button>
            </>
          )}
        </div>
      </div>
      {picking && <CandidatePicker fixedCostId={fixedCostId} date={slot.date} onDone={() => onPick(false)} />}
    </div>
  );
}

function CandidatePicker({ fixedCostId, date, onDone }: { fixedCostId: number; date: string; onDone: () => void }) {
  const { data } = useQuery(recurringExpenseCandidatesQuery(fixedCostId, date));
  const link = useLinkFixedCostPayment();
  if (!data) return <div className="mt-2 h-10" />;
  if (data.length === 0) {
    return <p className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">Keine unverknüpften Ausgaben ± 60 Tage um diesen Termin.</p>;
  }
  return (
    <div className="mt-2 rounded-md border bg-muted/20 p-1">
      <p className="px-2 py-1 text-xs text-muted-foreground">Unverknüpfte Ausgaben ± 60 Tage · passende zuerst</p>
      <ul className="max-h-56 overflow-y-auto">
        {data.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              disabled={link.isPending}
              onClick={() =>
                link.mutate(
                  { recurringExpenseId: fixedCostId, expenseId: c.id, scheduledDate: date },
                  {
                    onSuccess: () => {
                      toast.success(`${c.number ?? "Ausgabe"} verknüpft`);
                      onDone();
                    },
                    onError: (err) => toast.error(apiErrorMessage(err)),
                  },
                )
              }
              className="flex w-full items-center gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-background"
            >
              <span className={cn("size-1.5 shrink-0 rounded-full", c.match ? "bg-emerald-600" : "bg-transparent")} aria-hidden />
              <span className="w-28 shrink-0 tabular text-muted-foreground">{c.number}</span>
              <span className="min-w-0 flex-1 truncate">{c.supplierName}</span>
              <span className="tabular text-muted-foreground">{formatDate(c.issueDate)}</span>
              <span className="w-24 text-right tabular">{formatCents(c.grossCents)}</span>
              {c.match && <span className="text-xs text-emerald-700">passt</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
