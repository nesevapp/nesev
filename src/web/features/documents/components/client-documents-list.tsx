import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { formatDate } from "@shared/dates";
import { DOCUMENT_TYPE_LABELS } from "@shared/documents";
import { formatCents } from "@shared/money";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { documentsQuery } from "@/sdk";
import { DOC_CONFIG, docLink } from "../config";
import { StatusBadge } from "./status-badge";

/**
 * All offers, invoices and credit notes of one client (newest first), for the client detail page:
 *   <ClientDocumentsList clientId={client.id} title="Dokumente" />
 * `title` is shown on the same row as the "new offer/invoice" buttons.
 */
export function ClientDocumentsList({ clientId, title }: { clientId: number; title?: string }) {
  const navigate = useNavigate();
  const { data = [], isPending } = useQuery(documentsQuery({ clientId }));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        {title && <h2 className="text-sm font-medium">{title}</h2>}
        <Button asChild size="sm" variant="outline" className="ml-auto">
          <Link to={DOC_CONFIG.offer.create} search={{ clientId }}>
            <Plus />
            Angebot
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to={DOC_CONFIG.invoice.create} search={{ clientId }}>
            <Plus />
            Rechnung
          </Link>
        </Button>
      </div>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-9 text-xs font-medium text-muted-foreground">Beleg</TableHead>
              <TableHead className="h-9 text-xs font-medium text-muted-foreground">Nummer</TableHead>
              <TableHead className="h-9 text-xs font-medium text-muted-foreground">Datum</TableHead>
              <TableHead className="h-9 text-right text-xs font-medium text-muted-foreground">Brutto</TableHead>
              <TableHead className="h-9 text-xs font-medium text-muted-foreground">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((d) => (
              <TableRow
                key={d.id}
                tabIndex={0}
                className="cursor-pointer"
                onClick={() => navigate(docLink(d.type, d.id))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") navigate(docLink(d.type, d.id));
                }}
              >
                <TableCell className="py-2.5">{DOCUMENT_TYPE_LABELS[d.type]}</TableCell>
                <TableCell className="tabular py-2.5">
                  {d.number ?? <span className="text-muted-foreground">Entwurf</span>}
                </TableCell>
                <TableCell className="tabular py-2.5">{formatDate(d.issueDate)}</TableCell>
                <TableCell className="tabular py-2.5 text-right">{formatCents(d.grossCents)}</TableCell>
                <TableCell className="py-2.5">
                  <StatusBadge status={d.status} overdue={d.overdue} />
                </TableCell>
              </TableRow>
            ))}
            {!isPending && data.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                  Noch keine Belege für diesen Kunden.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
