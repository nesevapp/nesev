import { type ReactNode, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, ChevronRight, CircleAlert, CircleSlash, Clock, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ChatCard, ChatConversationDetail, ChatMessageView, ChatToolCall } from "@/sdk";
import { ActionButton } from "./chat-actions";
import { ChatCardView, cardPaths } from "./chat-cards";
import { MarkdownView, type LinkRenderer } from "./markdown-view";
import { appPath, isFilePath } from "./markdown";
import { isIrreversibleTool, summarizeArgs, toolMeta } from "./tools";
import type { LiveState } from "./use-chat-session";

/** Markdown links: app paths (and links to a local nesev) navigate in-app, other URLs open a new tab. */
function useLinkRenderer(): LinkRenderer {
  const navigate = useNavigate();
  return (href, children, key) => {
    const path = appPath(href, window.location.origin);
    if (!path || isFilePath(path)) {
      return (
        <a key={key} href={path ?? href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
          {children}
        </a>
      );
    }
    return (
      <a
        key={key}
        href={path}
        className="text-primary underline underline-offset-2"
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          void navigate({ href: path });
        }}
      >
        {children}
      </a>
    );
  };
}

function UserBubble({ message }: { message: ChatMessageView }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground">
        {message.content}
      </div>
    </div>
  );
}

type CallState = "running" | "ok" | "error" | "pending" | "cancelled" | "unknown";

const CARD_LABELS: Record<ChatCard["kind"], string> = {
  kpis: "Kennzahlen anzeigen",
  chart: "Diagramm anzeigen",
  document: "Beleg anzeigen",
  table: "Tabelle anzeigen",
};

function ToolCard({
  call,
  result,
  state,
  collapsed = false,
}: {
  call: ChatToolCall;
  result: ChatMessageView | undefined;
  state: CallState;
  /** card of an intermediate step (not the turn's last card): one-line toggle instead of the full card */
  collapsed?: boolean;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [showCard, setShowCard] = useState(false);
  const { label, icon: Icon } = toolMeta(call.name);
  const args = summarizeArgs(call.arguments);
  const r = result?.toolResult;
  const status: Record<CallState, ReactNode> = {
    running: (
      <span className="flex items-center gap-1 text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> läuft …
      </span>
    ),
    pending: (
      <span className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
        <Clock className="size-3" /> wartet auf Bestätigung
      </span>
    ),
    cancelled: (
      <span className="flex items-center gap-1 text-muted-foreground">
        <CircleSlash className="size-3" /> {r?.summary || "abgebrochen"}
      </span>
    ),
    error: (
      <span className="flex items-center gap-1 text-destructive">
        <CircleAlert className="size-3" /> {r?.summary || result?.content || "Fehler"}
      </span>
    ),
    ok: <span className="text-muted-foreground">{r?.summary}</span>,
    unknown: null,
  };

  const card = state === "ok" ? r?.card : null;
  const action = state === "ok" ? r?.action : null;
  const covered = card ? cardPaths(card) : null;
  const links = (r?.links ?? []).filter((l) => !covered?.has(l.path));

  return (
    <div className="space-y-1.5">
      <div className={cn("rounded-lg border bg-card text-xs", state === "error" && "border-destructive/40 bg-destructive/5")}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-start gap-2 px-2.5 py-2 text-left"
          aria-expanded={open}
        >
          <Icon className="mt-px size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex items-center gap-1.5">
              <span className="shrink-0 font-medium">{label}</span>
              {args && <span className="truncate text-muted-foreground">{args}</span>}
            </div>
            {status[state]}
          </div>
          <ChevronRight className={cn("mt-px size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        </button>
        {(links.length > 0 || action) && (
          <div className="flex flex-wrap gap-1 px-2.5 pb-2 pl-8">
            {action && <ActionButton action={action} />}
            {links.map((l) => (
              <Button
                key={l.path}
                variant="outline"
                size="xs"
                onClick={() => (isFilePath(l.path) ? window.open(l.path, "_blank", "noopener") : void navigate({ href: l.path }))}
              >
                {l.label}
                <ArrowUpRight />
              </Button>
            ))}
          </div>
        )}
        {open && (
          <pre className="max-h-48 overflow-auto border-t bg-muted/40 px-2.5 py-2 font-mono text-[11px] whitespace-pre-wrap">
            {call.name}({JSON.stringify(call.arguments, null, 2)})
          </pre>
        )}
      </div>
      {card && collapsed && (
        <button
          type="button"
          onClick={() => setShowCard((v) => !v)}
          aria-expanded={showCard}
          className="flex items-center gap-1 pl-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRight className={cn("size-3.5 transition-transform", showCard && "rotate-90")} />
          {CARD_LABELS[card.kind]}
        </button>
      )}
      {card && (!collapsed || showCard) && <ChatCardView card={card} />}
    </div>
  );
}

function callState(call: ChatToolCall, result: ChatMessageView | undefined, pendingId: string | null, live: LiveState, streaming: boolean): CallState {
  if (result) {
    if (result.status === "cancelled") return "cancelled";
    if (result.status === "pending") return "pending";
    if (result.status === "error" || result.toolResult?.ok === false) return "error";
    return "ok";
  }
  if (call.id === pendingId) return "pending";
  if (live.runningCalls.has(call.id) || streaming) return "running";
  return "unknown";
}

/**
 * Tool call ids whose card is shown expanded: per turn (messages from one user message to the next) only the last
 * tool result with a card; cards of intermediate lookups (search before open/download) collapse to a toggle.
 */
function lastCardPerTurn(messages: ChatMessageView[], results: Map<string, ChatMessageView>): Set<string> {
  const expanded = new Set<string>();
  const shown = new Set<string>();
  let lastInTurn: string | null = null;
  const flush = () => {
    if (lastInTurn) expanded.add(lastInTurn);
    lastInTurn = null;
  };
  for (const m of messages) {
    if (m.role === "user") flush();
    else if (m.role === "assistant") {
      for (const c of m.toolCalls ?? []) {
        shown.add(c.id);
        if (results.get(c.id)?.toolResult?.card) lastInTurn = c.id;
      }
    } else if (m.toolResult?.card) {
      // a result without its call in an assistant message is rendered on its own (same id as in MessageList)
      const id = m.toolCallId ?? String(m.id);
      if (!m.toolCallId || !shown.has(m.toolCallId)) lastInTurn = id;
    }
  }
  flush();
  return expanded;
}

/** Nothing visible yet for the newest step: the user's message or a tool result, or an assistant message still empty. */
const waitingForText = (last: ChatMessageView | undefined) =>
  !!last && (last.role !== "assistant" || (!last.content && !last.toolCalls?.length));

const Thinking = ({ text }: { text: string }) => (
  <div className="flex items-center gap-2 text-xs text-muted-foreground">
    <span className="flex gap-0.5">
      {[0, 1, 2].map((i) => (
        <span key={i} className="size-1 animate-pulse rounded-full bg-current" style={{ animationDelay: `${i * 150}ms` }} />
      ))}
    </span>
    {text}
  </div>
);

export function MessageList({
  detail,
  live,
  streaming,
}: {
  detail: ChatConversationDetail;
  live: LiveState;
  streaming: boolean;
}) {
  const renderLink = useLinkRenderer();
  const results = new Map<string, ChatMessageView>();
  for (const m of detail.messages) if (m.role === "tool" && m.toolCallId) results.set(m.toolCallId, m);
  const shownCalls = new Set<string>();
  const pendingId = detail.pending?.toolCall.id ?? null;
  const last = detail.messages[detail.messages.length - 1];
  const expanded = lastCardPerTurn(detail.messages, results);

  return (
    <div className="space-y-3">
      {detail.messages.map((m) => {
        if (m.role === "user") return <UserBubble key={m.id} message={m} />;
        if (m.role === "tool") {
          if (m.toolCallId && shownCalls.has(m.toolCallId)) return null;
          // a result whose call isn't part of an assistant message (shouldn't happen): show it on its own
          const call: ChatToolCall = { id: m.toolCallId ?? String(m.id), name: m.toolName ?? "tool", arguments: {} };
          return (
            <ToolCard
              key={m.id}
              call={call}
              result={m}
              state={callState(call, m, pendingId, live, false)}
              collapsed={!!m.toolResult?.card && !expanded.has(call.id)}
            />
          );
        }
        for (const c of m.toolCalls ?? []) shownCalls.add(c.id);
        const thinking = live.thinkingId === m.id && !m.content;
        return (
          <div key={m.id} className="space-y-2">
            {thinking && <Thinking text="denkt nach …" />}
            {m.content && <MarkdownView source={m.content} renderLink={renderLink} className="text-sm leading-relaxed" />}
            {m.status === "error" && !m.content && <p className="text-sm text-destructive">Antwort fehlgeschlagen.</p>}
            {m.status === "cancelled" && <p className="text-xs text-muted-foreground italic">abgebrochen</p>}
            {(m.toolCalls ?? []).map((c) => (
              <ToolCard
                key={c.id}
                call={c}
                result={results.get(c.id)}
                state={callState(c, results.get(c.id), pendingId, live, streaming)}
                collapsed={!expanded.has(c.id)}
              />
            ))}
          </div>
        );
      })}
      {streaming && live.statusText && <Thinking text={live.statusText} />}
      {streaming && !live.statusText && live.thinkingId === null && live.runningCalls.size === 0 && waitingForText(last) && (
        <Thinking text="Antwort wird erstellt …" />
      )}
    </div>
  );
}

export function ConfirmCard({
  pending,
  busy,
  onAnswer,
}: {
  pending: NonNullable<ChatConversationDetail["pending"]>;
  busy: boolean;
  onAnswer: (approve: boolean) => void;
}) {
  const { label } = toolMeta(pending.toolCall.name);
  const irreversible = isIrreversibleTool(pending.toolCall.name);
  return (
    <div
      role="group"
      aria-label="Bestätigung erforderlich"
      className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700/60 dark:bg-amber-950/30"
    >
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400" />
        <div className="space-y-1">
          <p className="font-medium">{label} – bestätigen?</p>
          <p className="text-muted-foreground">{pending.summary}</p>
          {irreversible && <p className="text-xs text-muted-foreground">Kann nicht rückgängig gemacht werden.</p>}
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAnswer(false)}>
          Abbrechen
        </Button>
        <Button variant={irreversible ? "destructive" : "default"} size="sm" disabled={busy} onClick={() => onAnswer(true)}>
          Ausführen
        </Button>
      </div>
    </div>
  );
}

export const EXAMPLE_PROMPTS: { text: string; fill?: boolean }[] = [
  { text: "Welche Rechnungen sind offen?" },
  { text: "Wie hoch ist meine USt-Zahllast im Quartal?" },
  { text: "Was kommt in den nächsten 3 Monaten rein und raus?" },
  { text: "Welche Kunden haben den meisten Umsatz gebracht?" },
  { text: "Was ist zum Mahnen fällig?" },
  { text: "Leg einen Rechnungsentwurf an für ", fill: true },
];

export function EmptyState({ onPick, disabled }: { onPick: (prompt: { text: string; fill?: boolean }) => void; disabled: boolean }) {
  return (
    <div className="flex h-full flex-col justify-end gap-4 pb-2">
      <div className="space-y-1">
        <p className="text-sm font-medium">Frag deine Buchhaltung</p>
        <p className="text-xs text-muted-foreground">
          Läuft lokal auf deinem Rechner. Liest Belege, Ausgaben und Auswertungen und legt Entwürfe an; alles, was Belege
          verändert, musst du bestätigen.
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {EXAMPLE_PROMPTS.map((p) => (
          <button
            key={p.text}
            type="button"
            disabled={disabled}
            onClick={() => onPick(p)}
            className="rounded-full border bg-background px-2.5 py-1 text-left text-xs transition-colors hover:bg-accent disabled:opacity-50"
          >
            {p.fill ? `${p.text.trim()} …` : p.text}
          </button>
        ))}
      </div>
    </div>
  );
}
