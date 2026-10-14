import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarClock, Unlink } from "lucide-react";
import { toast } from "sonner";
import { slotLabel } from "@shared/recurring-expenses";
import { Button } from "@/components/ui/button";
import {
  apiErrorMessage,
  expenseFixedCostLinkQuery,
  fixedCostSuggestionsQuery,
  useLinkFixedCostPayment,
  useUnlinkFixedCostPayment,
} from "@/sdk";

/**
 * One quiet line in the expense editor: the Fixkosten payment this expense books ("Fixkosten: Miete · Nov 2026",
 * with unlink), or — when unlinked — the best matching scheduled payment as a one-click suggestion.
 * New expenses only show the pending link from "Ausgabe erfassen".
 */
export function FixedCostHint({
  expenseId,
  pending,
}: {
  expenseId: number | null;
  pending?: { name: string; scheduledDate: string };
}) {
  const link = useQuery({ ...expenseFixedCostLinkQuery(expenseId ?? 0), enabled: expenseId != null });
  const unlinked = expenseId != null && link.isSuccess && link.data === null;
  const suggestions = useQuery({ ...fixedCostSuggestionsQuery(expenseId ?? 0), enabled: unlinked });
  const doLink = useLinkFixedCostPayment();
  const doUnlink = useUnlinkFixedCostPayment();

  if (expenseId == null) {
    if (!pending) return null;
    return (
      <Line>
        Wird beim Speichern mit Fixkosten <span className="font-medium text-foreground">{pending.name}</span> · {slotLabel(pending.scheduledDate)} verknüpft.
      </Line>
    );
  }

  if (link.data) {
    const l = link.data;
    return (
      <Line>
        Fixkosten:{" "}
        <Link to="/fixed-costs" className="font-medium text-foreground underline-offset-4 hover:underline">
          {l.name}
        </Link>{" "}
        · {slotLabel(l.scheduledDate)}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-1 h-6 px-1.5 text-xs text-muted-foreground"
          disabled={doUnlink.isPending}
          onClick={() =>
            doUnlink.mutate(expenseId, {
              onSuccess: () => toast.success("Verknüpfung gelöst"),
              onError: (err) => toast.error(apiErrorMessage(err)),
            })
          }
        >
          <Unlink className="size-3" />
          lösen
        </Button>
      </Line>
    );
  }

  const best = suggestions.data?.[0];
  if (!unlinked || !best) return null;
  return (
    <Line>
      Passt zu Fixkosten <span className="font-medium text-foreground">{best.name}</span> ({slotLabel(best.scheduledDate)}) –
      <button
        type="button"
        className="ml-1 font-medium text-foreground underline underline-offset-4 hover:no-underline disabled:opacity-50"
        disabled={doLink.isPending}
        onClick={() =>
          doLink.mutate(
            { recurringExpenseId: best.recurringExpenseId, expenseId, scheduledDate: best.scheduledDate },
            {
              onSuccess: () => toast.success(`Mit Fixkosten ${best.name} · ${slotLabel(best.scheduledDate)} verknüpft`),
              onError: (err) => toast.error(apiErrorMessage(err)),
            },
          )
        }
      >
        verknüpfen
      </button>
    </Line>
  );
}

function Line({ children }: { children: React.ReactNode }) {
  return (
    // sits as its own row in the editor's header grid
    <p className="-mt-2 flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground sm:col-span-2">
      <CalendarClock className="mr-0.5 size-3.5" />
      {children}
    </p>
  );
}
