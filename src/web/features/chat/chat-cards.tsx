import type { ReactNode } from "react";
import { ArrowUpRight, FileText } from "lucide-react";
import { formatDate } from "@shared/dates";
import { DOCUMENT_STATUS_LABELS, type DocumentStatus, OVERDUE_LABEL } from "@shared/documents";
import { formatCents } from "@shared/money";
import { Button } from "@/components/ui/button";
import { PartialLabel, StatusBadge } from "@/features/documents/components/status-badge";
import { cn } from "@/lib/utils";
import type { ChatCard, ChatLink, ChatTone } from "@/sdk";
import { openTab, useOpenPath } from "./chat-actions";
import { ChatChart, TONE_COLOR } from "./chat-chart";

// Generative UI under a tool result (contract: ChatCard in src/shared/chat.ts). Compact for the 420px panel;
// amounts arrive as cents and are formatted here. Rows and links navigate inside the SPA.

/** Value color by tone; negative amounts are red like in the charts. */
function valueClass(cents: number, tone: ChatTone | undefined) {
  if (cents < 0 || tone === "negative") return "text-red-700";
  if (tone === "positive") return "text-emerald-700";
  if (tone === "muted") return "text-muted-foreground";
  return "text-foreground";
}

function CardShell({ title, link, children }: { title?: ReactNode; link?: ChatLink; children: ReactNode }) {
  const open = useOpenPath();
  return (
    <div className="overflow-hidden rounded-lg border bg-card text-xs">
      {(title || link) && (
        <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{title}</span>
          {link && (
            <button
              type="button"
              onClick={() => open(link.path)}
              className="flex shrink-0 items-center gap-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
              <ArrowUpRight className="size-3" />
            </button>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

function KpisCard({ card }: { card: Extract<ChatCard, { kind: "kpis" }> }) {
  return (
    <CardShell title={card.title} link={card.link}>
      <div className="grid grid-cols-2 gap-px border-t bg-border">
        {card.items.map((item, i) => (
          <div
            key={i}
            // an odd last tile spans both columns so the grid has no hole
            className={cn("space-y-0.5 bg-card px-3 py-2", card.items.length % 2 === 1 && i === card.items.length - 1 && "col-span-2")}
          >
            <div className="flex items-center gap-1.5 text-muted-foreground">
              {item.tone && item.tone !== "neutral" && item.tone !== "muted" && (
                <span className="size-2 shrink-0 rounded-[2px]" style={{ background: TONE_COLOR[item.tone] }} />
              )}
              <span className="truncate">{item.label}</span>
            </div>
            <div className={cn("text-sm font-semibold tabular", valueClass(item.cents, item.tone))}>{formatCents(item.cents)}</div>
            {item.hint && <div className="truncate text-[11px] text-muted-foreground">{item.hint}</div>}
          </div>
        ))}
      </div>
    </CardShell>
  );
}

function ChartCard({ card }: { card: Extract<ChatCard, { kind: "chart" }> }) {
  return (
    <CardShell title={card.title} link={card.link}>
      <div className="px-2 pb-2.5">
        <ChatChart card={card} />
      </div>
    </CardShell>
  );
}

const STATUS_BY_LABEL = new Map(Object.entries(DOCUMENT_STATUS_LABELS).map(([k, v]) => [v.toLowerCase(), k as DocumentStatus]));

/** German status text from the card ("Versendet", "Überfällig", "Bezahlt · teilbezahlt" …) → the app's badges. */
function DocumentStatusView({ status }: { status: string }) {
  const parts = status.split(/\s*[,·/]\s*|\s+–\s+/).filter(Boolean);
  const partial = parts.some((p) => p.toLowerCase() === "teilbezahlt");
  const badges = parts
    .filter((p) => p.toLowerCase() !== "teilbezahlt")
    .map((p, i) => {
      if (p.toLowerCase() === OVERDUE_LABEL.toLowerCase()) return <StatusBadge key={i} status="sent" overdue />;
      const known = STATUS_BY_LABEL.get(p.toLowerCase());
      return known ? (
        <StatusBadge key={i} status={known} />
      ) : (
        <span key={i} className="inline-flex h-5 items-center rounded-full border px-2 text-xs font-medium whitespace-nowrap text-muted-foreground">
          {p}
        </span>
      );
    });
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {badges}
      {partial && <PartialLabel />}
    </span>
  );
}

function DocumentCard({ card }: { card: Extract<ChatCard, { kind: "document" }> }) {
  const open = useOpenPath();
  const dates = [card.date && formatDate(card.date), card.dueDate && `fällig ${formatDate(card.dueDate)}`].filter(Boolean).join(" · ");
  return (
    <div className="space-y-2 rounded-lg border bg-card px-3 py-2.5 text-xs">
      <div className="flex items-start gap-2">
        <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {card.typeLabel} {card.number ?? <span className="font-normal text-muted-foreground">Entwurf</span>}
          </div>
          {card.client && <div className="truncate text-muted-foreground">{card.client}</div>}
        </div>
        <DocumentStatusView status={card.status} />
      </div>
      <div className="flex items-end gap-3 pl-5.5">
        <div className="min-w-0 flex-1 text-muted-foreground">{dates}</div>
        <div className="text-right">
          <div className="text-sm font-semibold tabular">{formatCents(card.grossCents)}</div>
          {card.openCents !== null && (
            <div className={cn("tabular", card.openCents > 0 ? "text-amber-700" : "text-muted-foreground")}>
              {card.openCents > 0 ? `offen ${formatCents(card.openCents)}` : "nichts offen"}
            </div>
          )}
        </div>
      </div>
      <div className="flex gap-1 pl-5.5">
        <Button variant="outline" size="xs" onClick={() => open(card.path)}>
          Öffnen
          <ArrowUpRight />
        </Button>
        {card.pdfUrl && (
          <Button variant="outline" size="xs" onClick={() => openTab(card.pdfUrl!, "PDF öffnen")}>
            PDF
            <ArrowUpRight />
          </Button>
        )}
      </div>
    </div>
  );
}

function TableCard({ card }: { card: Extract<ChatCard, { kind: "table" }> }) {
  const open = useOpenPath();
  const right = (c: (typeof card.columns)[number]) => c.align === "right" || (c.align === undefined && c.money);
  const cell = (c: (typeof card.columns)[number], v: string | number | null | undefined) =>
    v == null || v === "" ? "–" : c.money && typeof v === "number" ? formatCents(v) : String(v);
  const moneyKey = card.columns.findLast((c) => c.money)?.key;
  // the panel is narrow: the text column with the longest values takes the remaining width and truncates
  const textLength = (key: string) => Math.max(0, ...card.rows.map((r) => String(r.cells[key] ?? "").length));
  const flexKey = card.columns
    .filter((c) => !right(c))
    .reduce<{ key: string; len: number } | null>((best, c) => {
      const len = textLength(c.key);
      return !best || len > best.len ? { key: c.key, len } : best;
    }, null)?.key;

  return (
    <CardShell title={card.title}>
      <div className="border-t">
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-muted-foreground">
              {card.columns.map((c) => (
                <th key={c.key} className={cn("px-3 py-1.5 font-normal whitespace-nowrap", right(c) ? "text-right" : "text-left")}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {card.rows.map((row, i) => (
              <tr
                key={i}
                tabIndex={row.path ? 0 : undefined}
                onClick={row.path ? () => open(row.path!) : undefined}
                onKeyDown={
                  row.path
                    ? (e) => {
                        if (e.key === "Enter") open(row.path!);
                      }
                    : undefined
                }
                className={cn("border-t", row.path && "cursor-pointer outline-none hover:bg-accent/60 focus-visible:bg-accent/60")}
              >
                {card.columns.map((c, k) => {
                  const v = row.cells[c.key];
                  return (
                    <td
                      key={c.key}
                      className={cn(
                        "px-3 py-1.5",
                        right(c) ? "text-right whitespace-nowrap tabular" : c.key === flexKey ? "w-full max-w-0 truncate" : "whitespace-nowrap",
                        k === 0 && "font-medium",
                        c.money && typeof v === "number" && v < 0 && "text-red-700",
                      )}
                      title={!right(c) && typeof v === "string" ? v : undefined}
                    >
                      {cell(c, v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          {card.total && (
            <tfoot>
              <tr className="border-t font-medium">
                {card.columns.map((c, k) => (
                  <td key={c.key} className={cn("px-3 py-1.5", right(c) && "text-right whitespace-nowrap tabular")}>
                    {k === 0 ? card.total!.label : c.key === moneyKey ? formatCents(card.total!.cents) : null}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {(!!card.more || card.link) && (
        <div className="flex items-center gap-2 border-t px-3 py-1.5 text-muted-foreground">
          {!!card.more && <span>+ {card.more} weitere</span>}
          {card.link && (
            <button
              type="button"
              onClick={() => open(card.link!.path)}
              className="ml-auto flex items-center gap-0.5 transition-colors hover:text-foreground"
            >
              {card.link.label}
              <ArrowUpRight className="size-3" />
            </button>
          )}
        </div>
      )}
    </CardShell>
  );
}

export function ChatCardView({ card }: { card: ChatCard }) {
  switch (card.kind) {
    case "kpis":
      return <KpisCard card={card} />;
    case "chart":
      return <ChartCard card={card} />;
    case "document":
      return <DocumentCard card={card} />;
    case "table":
      return <TableCard card={card} />;
    default:
      return null;
  }
}

/** Paths a card already links to (the tool card hides duplicate link buttons). */
export function cardPaths(card: ChatCard): Set<string> {
  const paths = new Set<string>();
  if (card.kind === "document") paths.add(card.path);
  else if (card.link) paths.add(card.link.path);
  if (card.kind === "document" && card.pdfUrl) paths.add(card.pdfUrl);
  return paths;
}
