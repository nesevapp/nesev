import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@shared/dates";
import { formatCents } from "@shared/money";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api";
import { documentPaymentsQuery, useUnmatch } from "../api";

/** "teilbezahlt € 100,00 von € 240,00" / "Überzahlung" — null when nothing is paid or due. */
export function paymentStateLabel(p: { dueCents: number; paidCents: number; openCents: number; partial: boolean }): string | null {
  if (p.partial) return `teilbezahlt ${formatCents(p.paidCents)} von ${formatCents(p.dueCents)}`;
  if (p.paidCents > 0 && p.openCents < 0) return `Überzahlung ${formatCents(-p.openCents)}`;
  return null;
}

/** Bank payments allocated to an invoice (document view). Hidden while there are none. */
export function InvoicePayments({ documentId }: { documentId: number }) {
  const { data } = useQuery(documentPaymentsQuery(documentId));
  const unmatch = useUnmatch();
  if (!data || data.payments.length === 0) return null;
  const state = paymentStateLabel(data);

  return (
    <section className="border-t pt-6">
      <h2 className="mb-3 flex items-baseline gap-3 text-sm font-medium">
        Zahlungen
        {state && <span className="text-xs font-normal text-amber-700">{state}</span>}
        {data.openCents > 0 && (
          <span className="text-xs font-normal text-muted-foreground tabular">offen {formatCents(data.openCents)}</span>
        )}
      </h2>
      <ul className="divide-y rounded-lg border text-sm">
        {data.payments.map((p) => (
          <li key={p.matchId} className="grid grid-cols-[6rem_1fr_auto_auto] items-center gap-4 px-3 py-2">
            <span className="tabular">{formatDate(p.bookingDate)}</span>
            <Link
              to="/bank"
              search={{ account: p.accountId, status: "all", q: p.counterpartyName || undefined }}
              className="min-w-0 truncate hover:underline"
              title={p.purpose}
            >
              {p.counterpartyName || p.purpose || "Bankbuchung"}
              <span className="ml-2 text-xs text-muted-foreground">
                {p.accountName}
                {p.source === "auto" && " · automatisch zugeordnet"}
              </span>
            </Link>
            <span className="tabular">{formatCents(p.amountCents)}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Zuordnung lösen"
              title="Zuordnung lösen"
              disabled={unmatch.isPending}
              onClick={() =>
                unmatch.mutate(
                  { matchId: p.matchId },
                  { onSuccess: () => toast.success("Zuordnung gelöst"), onError: (err) => toast.error(apiErrorMessage(err)) },
                )
              }
            >
              <X />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
