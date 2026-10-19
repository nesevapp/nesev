import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowUp, Loader2, Paperclip, Square, X } from "lucide-react";
import type { ChatContext } from "@shared/chat";
import { Button } from "@/components/ui/button";
import { VoiceInput } from "./voice-input";
import { appendTranscript } from "./voice-recorder";

export interface ComposerHandle {
  focus: () => void;
}

const MAX_HEIGHT = 200;

export const ChatComposer = forwardRef<
  ComposerHandle,
  {
    value: string;
    onChange: (value: string) => void;
    onSend: () => void;
    onStop: () => void;
    streaming: boolean;
    /** why sending isn't possible right now (model problem, pending confirmation); null = ready */
    blocked: { text: string; settingsLink?: boolean } | null;
    context: ChatContext | null;
    onDropContext: () => void;
    /** paperclip: pick receipts (one draft expense per file); null = not possible right now */
    onAttach: (() => void) | null;
    uploading: boolean;
  }
>(function ChatComposer({ value, onChange, onSend, onStop, streaming, blocked, context, onDropContext, onAttach, uploading }, ref) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => textarea.current?.focus() }), []);

  // autosize: grow with the content up to MAX_HEIGHT, then scroll
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  const canSend = !streaming && !blocked && value.trim().length > 0;

  return (
    <div className="shrink-0 space-y-2 border-t p-3">
      {blocked && (
        <p className="text-xs text-muted-foreground">
          {blocked.text}
          {blocked.settingsLink && (
            <>
              {" "}
              <Link to="/settings" hash="assistent" className="text-primary underline underline-offset-2">
                Einstellungen
              </Link>
            </>
          )}
        </p>
      )}
      {context && (
        <div className="flex">
          <span className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/50 py-0.5 pr-1 pl-2 text-xs text-muted-foreground">
            <span className="truncate" title={context.path}>
              Kontext: {context.title ?? context.path}
            </span>
            <button
              type="button"
              onClick={onDropContext}
              className="rounded-full p-0.5 hover:bg-accent hover:text-foreground"
              aria-label="Kontext für die nächste Nachricht entfernen"
            >
              <X className="size-3" />
            </button>
          </span>
        </div>
      )}
      <div className="flex items-end gap-2 rounded-lg border bg-background px-2 py-1.5 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
        <textarea
          ref={textarea}
          rows={1}
          value={value}
          disabled={!!blocked && !streaming}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
          placeholder="Deine Frage … (Enter senden, Shift+Enter neue Zeile)"
          aria-label="Nachricht an den Assistenten"
          className="max-h-[200px] min-h-6 flex-1 resize-none bg-transparent py-0.5 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
        />
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={!onAttach || uploading}
          onClick={() => onAttach?.()}
          aria-label="Belege hochladen"
          title="Belege hochladen (PDF, JPG, PNG, WebP) – oder auf den Chat ziehen"
          className="text-muted-foreground"
        >
          {uploading ? <Loader2 className="animate-spin" /> : <Paperclip />}
        </Button>
        <VoiceInput
          disabled={!!blocked && !streaming}
          onText={(text) => {
            onChange(appendTranscript(textarea.current?.value ?? value, text));
            textarea.current?.focus();
          }}
        />
        {streaming ? (
          <Button size="icon-xs" variant="secondary" onClick={onStop} aria-label="Stopp" title="Stopp">
            <Square className="fill-current" />
          </Button>
        ) : (
          <Button size="icon-xs" disabled={!canSend} onClick={onSend} aria-label="Senden" title="Senden (Enter)">
            <ArrowUp />
          </Button>
        )}
      </div>
    </div>
  );
});
