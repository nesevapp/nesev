import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Loader2, Mic, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { voiceStatusQuery } from "@/sdk";
import { CodeText } from "@/features/receipts/code-text";
import { useVoiceRecorder } from "./voice-recorder";

/** pressed longer than this: push-to-talk (release stops); shorter: click toggles */
const HOLD_MS = 450;

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Mic button for the chat composer: click to start/stop, or hold to talk. The transcript goes to `onText`
 * (into the input, never sent). Hidden when voice input is disabled in the settings.
 */
export function VoiceInput({ onText, disabled }: { onText: (text: string) => void; disabled?: boolean }) {
  const status = useQuery(voiceStatusQuery);
  const rec = useVoiceRecorder({
    onText,
    onError: (message) => toast.error(<CodeText text={message} />),
  });
  /** pointer press that started the recording (for hold-to-talk); the click that follows it is ignored */
  const press = useRef<number | null>(null);

  const s = status.data;
  if (!s?.enabled) return null;

  const notReady = () => toast.error(<CodeText text={s.problem ?? "Spracheingabe ist nicht bereit"} />);

  if (rec.phase === "recording" || rec.phase === "transcribing") {
    const recording = rec.phase === "recording";
    return (
      <div className="flex shrink-0 items-center gap-1.5">
        <span
          className="flex h-6 items-center gap-1.5 rounded-full bg-muted px-2 text-xs text-muted-foreground tabular"
          aria-live="polite"
        >
          {recording ? (
            <>
              <span className="size-2 animate-pulse rounded-full bg-red-500" aria-hidden />
              {clock(rec.elapsedMs)}
              <LevelBars level={rec.level} />
            </>
          ) : (
            <>
              <Loader2 className="size-3 animate-spin" aria-hidden />
              Wird erkannt …
            </>
          )}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={() => {
            press.current = null;
            rec.cancel();
          }}
          aria-label="Aufnahme verwerfen"
          title="Verwerfen"
        >
          <X />
        </Button>
        {recording && (
          <Button
            size="icon-xs"
            variant="secondary"
            onPointerUp={() => {
              if (press.current !== null && performance.now() - press.current > HOLD_MS) void rec.stop();
              press.current = null;
            }}
            onClick={() => void rec.stop()}
            aria-label="Aufnahme beenden"
            title="Aufnahme beenden"
          >
            <Check />
          </Button>
        )}
      </div>
    );
  }

  return (
    <Button
      size="icon-xs"
      variant="ghost"
      disabled={disabled || rec.phase === "starting"}
      className={cn(!s.ready && "opacity-50")}
      onPointerDown={(e) => {
        if (e.button !== 0 || !s.ready) return;
        press.current = performance.now();
        void rec.start();
      }}
      onClick={() => {
        if (!s.ready) return notReady();
        // keyboard activation (a pointer press already started the recording)
        if (press.current === null) void rec.start();
        else press.current = null;
      }}
      aria-label="Spracheingabe"
      title={s.ready ? "Spracheingabe (klicken oder gedrückt halten)" : (s.problem ?? undefined)}
    >
      <Mic />
    </Button>
  );
}

function LevelBars({ level }: { level: number }) {
  return (
    <span className="flex h-3 items-end gap-px" aria-hidden>
      {[0.15, 0.35, 0.55, 0.75].map((threshold) => (
        <span
          key={threshold}
          className={cn("w-0.5 rounded-full transition-colors", level >= threshold ? "bg-foreground/70" : "bg-foreground/15")}
          style={{ height: `${40 + threshold * 80}%` }}
        />
      ))}
    </span>
  );
}
