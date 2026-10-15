import { useState } from "react";
import { Flag } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { apiErrorMessage, type ChatFeedback, useDeleteChatFeedback, useSaveChatFeedback } from "@/sdk";

// "Antwort war falsch" under an assistant answer: on hover a flag button; it opens a small popover for an optional
// note on what should have happened. A flagged answer keeps a visible marker (click to edit or remove the flag).
// Flags become draft eval cases (bun run eval:feedback).

export function FeedbackAction({ conversationId, messageId, feedback }: { conversationId: number; messageId: number; feedback: ChatFeedback | undefined }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const save = useSaveChatFeedback(conversationId);
  const remove = useDeleteChatFeedback(conversationId);
  const flagged = !!feedback;

  const submit = () =>
    save.mutate(
      { messageId, note },
      {
        onSuccess: () => {
          setOpen(false);
          toast.success("Als falsch markiert – danke");
        },
        onError: (err) => toast.error(apiErrorMessage(err)),
      },
    );

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) setNote(feedback?.note ?? "");
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={flagged ? "Markierung „Antwort war falsch“ bearbeiten" : "Antwort war falsch"}
          title={flagged ? undefined : "Antwort war falsch"}
          className={cn(
            "flex items-center gap-1 rounded px-1 py-0.5 text-[11px] transition-colors",
            flagged
              ? "text-amber-700 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950/40"
              : "text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100",
          )}
        >
          <Flag className={cn("size-3", flagged && "fill-current")} />
          {flagged && <span>Als falsch markiert</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-2 p-3">
        <p className="text-sm font-medium">Antwort war falsch</p>
        <Textarea
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Was hätte passieren sollen? (optional)"
          maxLength={2000}
          rows={3}
          className="text-sm"
        />
        <div className="flex justify-between gap-2">
          {flagged ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(messageId, {
                  onSuccess: () => setOpen(false),
                  onError: (err) => toast.error(apiErrorMessage(err)),
                })
              }
            >
              Markierung entfernen
            </Button>
          ) : (
            <span />
          )}
          <Button size="sm" disabled={save.isPending} onClick={submit}>
            {flagged ? "Speichern" : "Melden"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
