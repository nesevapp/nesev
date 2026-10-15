import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, ChevronRight, Download } from "lucide-react";
import { formatDate } from "@shared/dates";
import { formatCents } from "@shared/money";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { taxCsvUrls, zmQuery } from "@/sdk";
import { CopyButton, dueLabel, PeriodNav, SectionHeader, SourcesTable, th, Warnings } from "./components";
import { FinanzOnlineButton } from "./finanzonline-button";

export function ZmSection({ period, setPeriod }: { period?: string; setPeriod: (key: string) => void }) {
  const { data, isFetching } = useQuery(zmQuery(period));
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return null;
  const due = dueLabel(data.dueDate, data.today);
  const isYear = data.period.kind === "year";

  return (
    <div className={cn("space-y-6 transition-opacity", isFetching && "opacity-70")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {!isYear && data.rows.length > 0 ? (
          <p className={cn("flex items-center gap-1.5 text-sm", due.tone === "overdue" ? "text-red-700" : due.tone === "soon" ? "text-amber-800" : "text-muted-foreground")}>
            <CalendarClock className="size-4" />
            ZM fällig am <span className="font-medium tabular">{formatDate(data.dueDate)}</span> ({due.text})
          </p>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <PeriodNav periodKey={data.period.key} onChange={setPeriod} />
          <Button variant="outline" size="sm" asChild>
            <a href={taxCsvUrls.zm(data.period.key)} download>
              <Download /> CSV
            </a>
          </Button>
          {!isYear && <FinanzOnlineButton kind="zm" period={data.period.key} />}
        </div>
      </div>

      <Warnings items={data.warnings} />

      <section>
        <SectionHeader
          title="Zusammenfassende Meldung"
          hint="Sonstige Leistungen an Unternehmer in anderen EU-Staaten (Reverse Charge), je UID des Empfängers. Meldezeitraum wie die UVA (Monat oder Quartal)."
        />
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={th}>UID-Nummer</TableHead>
                <TableHead className={th}>Kunde</TableHead>
                <TableHead className={cn(th, "text-right")}>Summe Bemessungsgrundlagen</TableHead>
                <TableHead className={cn(th, "text-center")}>Dreiecksgeschäft</TableHead>
                <TableHead className={cn(th, "text-center")}>Sonstige Leistung</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    Keine EU-Reverse-Charge-Umsätze in diesem Zeitraum — keine ZM nötig.
                  </TableCell>
                </TableRow>
              )}
              {data.rows.map((r) => {
                const key = r.uid || r.clientNames.join();
                return (
                  <Fragment key={key}>
                    <TableRow className="cursor-pointer" onClick={() => setOpen(open === key ? null : key)} aria-expanded={open === key}>
                      <TableCell className="py-1.5 font-medium tabular">
                        <span className="flex items-center gap-1">
                          <ChevronRight className={cn("size-3.5 text-muted-foreground transition-transform", open === key && "rotate-90")} />
                          {r.uid || <span className="text-red-600">UID fehlt</span>}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-64 truncate py-1.5">{r.clientNames.join(", ")}</TableCell>
                      <TableCell className="py-1 text-right tabular">
                        <span className="inline-flex items-center gap-0.5">
                          {formatCents(r.amountCents)}
                          <CopyButton cents={r.amountCents} label={r.uid || "Summe"} />
                        </span>
                      </TableCell>
                      <TableCell className="py-1.5 text-center text-muted-foreground">{r.triangular ? "ja" : "nein"}</TableCell>
                      <TableCell className="py-1.5 text-center">{r.services ? "ja" : "nein"}</TableCell>
                    </TableRow>
                    {open === key && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={5} className="bg-muted/20 px-6 py-2">
                          <SourcesTable sources={r.documents} showTax={false} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
            {data.rows.length > 0 && (
              <TableFooter>
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={2} className="py-2 font-medium">
                    Summe
                  </TableCell>
                  <TableCell className="py-2 pr-11 text-right font-medium tabular">{formatCents(data.totalCents)}</TableCell>
                  <TableCell colSpan={2} />
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </div>
      </section>
    </div>
  );
}
