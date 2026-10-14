import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { History, Plus, Settings, Trash2, X } from "lucide-react";
import { toast } from "sonner";
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
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  apiErrorMessage,
  type ChatConversationSummary,
  type ChatStatus,
  chatConversationsQuery,
  useDeleteChatConversation,
  useRenameChatConversation,
} from "@/sdk";
import { chatUi } from "./chat-store";

export const UNTITLED = "Neue Unterhaltung";

const dateTime = new Intl.DateTimeFormat("de-AT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function StatusDot({ status, busyText }: { status: ChatStatus | undefined; busyText: string | null }) {
  const [color, text] = !status
    ? ["bg-muted-foreground/40", "Status wird geladen …"]
    : busyText
      ? ["bg-amber-500 animate-pulse", busyText]
      : !status.enabled
        ? ["bg-muted-foreground/40", "Assistent ist in den Einstellungen deaktiviert"]
        : !status.ready
          ? ["bg-destructive", status.problem ?? "Nicht bereit"]
          : status.running
            ? ["bg-emerald-500", `Modell geladen: ${status.model?.label ?? "?"}`]
            : ["bg-emerald-500/50", `Bereit: ${status.model?.label ?? "?"} (lädt bei der ersten Frage)`];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="grid size-6 shrink-0 place-items-center" aria-label={text} role="img">
          <span className={cn("size-2 rounded-full", color)} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72">
        {text}
      </TooltipContent>
    </Tooltip>
  );
}

function TitleEditor({ conversation }: { conversation: ChatConversationSummary | undefined }) {
  const rename = useRenameChatConversation();
  const [editing, setEditing] = useState<string | null>(null);
  const title = conversation?.title || UNTITLED;

  if (!conversation) return <span className="truncate text-sm font-medium">{UNTITLED}</span>;
  if (editing !== null) {
    const save = () => {
      const next = editing.trim();
      setEditing(null);
      if (next && next !== conversation.title) {
        rename.mutate({ id: conversation.id, title: next }, { onError: (err) => toast.error(apiErrorMessage(err)) });
      }
    };
    return (
      <Input
        autoFocus
        value={editing}
        maxLength={120}
        onChange={(e) => setEditing(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            e.stopPropagation();
            setEditing(null);
          }
        }}
        className="h-7 text-sm"
        aria-label="Titel der Unterhaltung"
      />
    );
  }
  return (
    <button
      type="button"
      onClick={() => setEditing(conversation.title)}
      title="Klicken zum Umbenennen"
      className="min-w-0 truncate rounded px-1 text-left text-sm font-medium hover:bg-accent"
    >
      {title}
    </button>
  );
}

export function ChatHeader({
  conversation,
  status,
  busyText,
}: {
  conversation: ChatConversationSummary | undefined;
  status: ChatStatus | undefined;
  busyText: string | null;
}) {
  const list = useQuery(chatConversationsQuery);
  const del = useDeleteChatConversation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [toDelete, setToDelete] = useState<ChatConversationSummary | null>(null);

  return (
    <div className="flex h-14 shrink-0 items-center gap-1 border-b px-3">
      <StatusDot status={status} busyText={busyText} />
      <div className="flex min-w-0 flex-1">
        <TitleEditor conversation={conversation} />
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" onClick={() => chatUi.select(null)} aria-label="Neue Unterhaltung">
            <Plus />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Neu</TooltipContent>
      </Tooltip>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Verlauf">
                <History />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Verlauf</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="max-h-96 w-80 overflow-y-auto">
          <DropdownMenuLabel>Unterhaltungen</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {(list.data ?? []).length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">Noch keine Unterhaltungen.</p>}
          {(list.data ?? []).map((c) => (
            <DropdownMenuItem
              key={c.id}
              onSelect={() => chatUi.select(c.id)}
              className={cn("group items-start gap-2", c.id === conversation?.id && "bg-accent/60")}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{c.title || UNTITLED}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {dateTime.format(new Date(c.updatedAt))}
                  {c.preview ? ` · ${c.preview}` : ""}
                </div>
              </div>
              <button
                type="button"
                aria-label="Unterhaltung löschen"
                className="rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 group-data-[highlighted]:opacity-100 hover:text-destructive focus-visible:opacity-100"
                onPointerDown={(e) => e.stopPropagation()}
                onPointerUp={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenuOpen(false);
                  setToDelete(c);
                }}
              >
                <Trash2 className="size-3.5" />
              </button>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" asChild>
            <Link to="/settings" hash="assistent" aria-label="Einstellungen">
              <Settings />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Einstellungen</TooltipContent>
      </Tooltip>
      <Button variant="ghost" size="icon-sm" onClick={() => chatUi.setOpen(false)} aria-label="Schließen (Esc)">
        <X />
      </Button>

      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unterhaltung löschen?</AlertDialogTitle>
            <AlertDialogDescription>
              „{toDelete?.title || UNTITLED}“ wird endgültig gelöscht. Angelegte Belege und Entwürfe bleiben erhalten.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={del.isPending}
              onClick={() => {
                const target = toDelete;
                if (!target) return;
                del.mutate(target.id, {
                  onSuccess: () => {
                    if (target.id === conversation?.id) chatUi.select(null);
                    setToDelete(null);
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
    </div>
  );
}
