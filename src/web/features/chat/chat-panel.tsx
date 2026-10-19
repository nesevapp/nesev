import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { chatApi, chatStatusQuery } from "@/sdk";
import { cn } from "@/lib/utils";
import { ChatComposer, type ComposerHandle } from "./chat-composer";
import { ChatHeader } from "./chat-header";
import { ConfirmCard, EmptyState, MessageList } from "./chat-messages";
import { chatUi, returnFocusTarget, setChatActivity, useChatUi } from "./chat-store";
import { usePageContext } from "./page-context";
import { useChatSession } from "./use-chat-session";

// Assistent side panel (right edge of the app shell). Stays mounted once opened, so a running answer keeps
// streaming while the panel is closed. ⌘J / Ctrl+J toggles it, Esc closes it.

const overlayOpen = () =>
  !!document.querySelector(':is([role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]):not([data-state="closed"])');

/** ⌘J / Ctrl+J anywhere (also while typing) toggles the panel. */
function useToggleShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        chatUi.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

let lastWarm = 0;

/**
 * While the panel is open and the model usable: start it (and fill its prompt cache) in the background, so the first
 * question doesn't wait for the model to load. At most every 30 s; repeats are cheap on the server anyway.
 */
function useWarmUp(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      if (Date.now() - lastWarm < 30_000) return;
      lastWarm = Date.now();
      chatApi.warm().catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [active]);
}

export function ChatPanel() {
  useToggleShortcut();
  const { open } = useChatUi();
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  return mounted ? <ChatPanelBody open={open} /> : null;
}

function ChatPanelBody({ open }: { open: boolean }) {
  const { conversationId } = useChatUi();
  const session = useChatSession(conversationId);
  const status = useQuery(chatStatusQuery(open));
  useWarmUp(open && !!status.data?.enabled && !!status.data.ready);
  const page = usePageContext();
  const [draft, setDraft] = useState("");
  const [dropContext, setDropContext] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const restoreFocus = useRef<HTMLElement | null>(null);

  const detail = session.detail.data;
  const pending = detail?.pending ?? null;
  const context = dropContext ? null : page;

  // for the floating button's status dot while the panel is closed
  useEffect(() => {
    setChatActivity({ busy: session.streaming, pending: !!pending && !session.streaming });
  }, [session.streaming, pending]);

  // a new page brings its context back
  useEffect(() => setDropContext(false), [page.path]);

  // focus the composer on open, give focus back on close (to the floating button when it opened the panel: it is
  // hidden while the panel is open, so it has lost the focus by now)
  useEffect(() => {
    if (open) {
      restoreFocus.current = returnFocusTarget() ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      requestAnimationFrame(() => composer.current?.focus());
    } else if (restoreFocus.current?.isConnected) {
      // the hidden panel dropped the focus to <body>: give it back to where it was before opening
      const active = document.activeElement;
      if (!active || active === document.body || scroller.current?.closest("aside")?.contains(active)) restoreFocus.current.focus();
    }
  }, [open]);

  useEffect(() => {
    stickToBottom.current = true;
  }, [conversationId]);

  // keep the newest content in view unless the user scrolled up
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [detail, session.live, session.streaming, session.error, open]);

  const blocked = !status.data
    ? null
    : !status.data.enabled
      ? { text: "Der Assistent ist deaktiviert.", settingsLink: true }
      : !status.data.ready
        ? { text: status.data.problem ?? "Das Modell ist nicht bereit.", settingsLink: true }
        : pending
          ? { text: "Bitte zuerst die Aktion oben ausführen oder abbrechen." }
          : null;

  const send = (text = draft) => {
    const trimmed = text.trim();
    if (!trimmed || session.streaming || blocked) return;
    stickToBottom.current = true;
    setDraft("");
    void session.send(trimmed, context ? { path: context.path, title: context.title } : undefined);
    setDropContext(false);
  };

  const empty = conversationId == null || (detail && detail.messages.length === 0 && !session.streaming);

  return (
    <aside
      aria-label="Assistent"
      hidden={!open}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented && !overlayOpen()) {
          e.preventDefault();
          chatUi.setOpen(false);
        }
      }}
      className={cn(
        "relative flex w-[420px] shrink-0 flex-col border-l bg-background",
        // below lg the panel overlays the page from the right instead of squeezing it (full width on phones)
        "max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-40 max-lg:max-w-full max-lg:shadow-xl",
        !open && "hidden",
      )}
    >
      <ChatHeader conversation={detail} status={status.data} busyText={session.streaming ? session.live.statusText : null} />
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="flex-1 overflow-y-auto px-4 py-4"
      >
        {empty ? (
          <EmptyState
            disabled={!!blocked || session.streaming}
            onPick={(p) => {
              if (p.fill) {
                setDraft(p.text);
                composer.current?.focus();
              } else send(p.text);
            }}
          />
        ) : detail ? (
          <div className="space-y-3">
            <MessageList detail={detail} live={session.live} streaming={session.streaming} />
            {pending && !session.streaming && <ConfirmCard pending={pending} busy={session.streaming} onAnswer={(a) => void session.confirm(a)} />}
          </div>
        ) : null}
        {session.error && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <span className="flex-1">{session.error}</span>
            <button type="button" onClick={session.dismissError} aria-label="Fehler ausblenden">
              <X className="size-3.5" />
            </button>
          </div>
        )}
      </div>
      <ChatComposer
        ref={composer}
        value={draft}
        onChange={setDraft}
        onSend={() => send()}
        onStop={session.stop}
        streaming={session.streaming}
        blocked={blocked}
        context={context}
        onDropContext={() => setDropContext(true)}
      />
    </aside>
  );
}
