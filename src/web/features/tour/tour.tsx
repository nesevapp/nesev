import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Kbd, modKey } from "@/features/search/kbd";
import { cn } from "@/lib/utils";
import { SIDEBAR_OPEN_EVENT, tour, tourSeen, useTourOpen } from "./tour-store";

// Guided tour for first-time users: a dimmed overlay with a cut-out around one part of the shell (elements marked
// with data-tour="…") and a card that explains it. Steps without a target (welcome, finish) show the card centred.
// A step whose target isn't on screen (e.g. the assistant button while the assistant is off) is skipped.
// Keys: → / Enter next, ← back, Esc ends. It never navigates; it only opens the sidebar group it points at.

interface Step {
  /** data-tour value of the element to highlight; none → centred card. */
  target?: string;
  /** Sidebar group to open before measuring. */
  group?: string;
  title: string;
  body: ReactNode;
}

function Where({ items }: { items: [string, string][] }) {
  return (
    <dl className="mt-3 space-y-1.5 text-xs">
      {items.map(([name, text]) => (
        <div key={name} className="grid grid-cols-[6.5rem_1fr] gap-2">
          <dt className="font-medium text-foreground">{name}</dt>
          <dd className="text-muted-foreground">{text}</dd>
        </div>
      ))}
    </dl>
  );
}

const STEPS: Step[] = [
  {
    title: "Willkommen bei nesev",
    body: (
      <>
        <p>
          Rechnungen und Buchhaltung für österreichische Einzelunternehmen. nesev läuft nur auf diesem Rechner: keine
          Cloud, kein Konto, alle Daten bleiben lokal.
        </p>
        <p className="mt-2">In einer Minute zeigen wir Ihnen, wo Sie was finden.</p>
      </>
    ),
  },
  {
    target: "overview",
    title: "Überblick",
    body: (
      <Where
        items={[
          ["Dashboard", "Umsatz im Jahresverlauf, offene und überfällige Rechnungen, Kleinunternehmergrenze."],
          ["Zahlungsprognose", "Erwartete Ein- und Ausgänge der nächsten Monate und Ihr voraussichtlicher Kontostand."],
        ]}
      />
    ),
  },
  {
    target: "group-Belege",
    group: "Belege",
    title: "Belege schreiben",
    body: (
      <>
        <p>Vom Angebot zur Rechnung: ein Angebot lässt sich mit einem Klick in eine Rechnung umwandeln.</p>
        <Where
          items={[
            ["Rechnungen", "Beim Abschließen fortlaufend nummeriert und als PDF festgeschrieben, auch als E-Rechnung."],
            ["Gutschriften", "Korrigieren abgeschlossene Rechnungen, die selbst nicht mehr änderbar sind."],
            ["Mahnungen", "Zahlungserinnerungen und Mahnstufen für überfällige Rechnungen."],
            ["Serien", "Wiederkehrende Rechnungen, die nesev zum Termin erstellt."],
          ]}
        />
      </>
    ),
  },
  {
    target: "group-Finanzen",
    group: "Finanzen",
    title: "Ausgaben, Bank und Steuern",
    body: (
      <Where
        items={[
          ["Ausgaben", "Belege als Foto oder PDF ablegen; die Belegerkennung liest sie lokal aus, wenn Sie es wollen."],
          ["Fixkosten", "Regelmäßige Ausgaben wie Miete oder Abos, auch für die Prognose."],
          ["Anlagen", "Anschaffungen über 1.000 € mit Abschreibung (AfA)."],
          ["Bank", "Kontoauszüge importieren und Zahlungen Rechnungen und Ausgaben zuordnen."],
          ["Steuern", "UVA, ZM und Einnahmen-Ausgaben-Rechnung, mit Export für FinanzOnline."],
        ]}
      />
    ),
  },
  {
    target: "group-Stammdaten",
    group: "Stammdaten",
    title: "Kunden und Artikel",
    body: (
      <Where
        items={[
          ["Kunden", "Aus Österreich, der EU oder dem Drittland; die Steuerbehandlung ergibt sich daraus."],
          ["Artikel", "Leistungen und Produkte, die Sie oft verrechnen, mit Preis und Einheit."],
        ]}
      />
    ),
  },
  {
    target: "search",
    title: "Alles finden",
    body: (
      <p>
        <Kbd>{modKey}</Kbd> <Kbd>K</Kbd> öffnet die Suche nach Kunden, Belegen, Seiten und Aktionen von überall.{" "}
        <Kbd>?</Kbd> zeigt alle Tastenkürzel.
      </p>
    ),
  },
  {
    target: "settings",
    title: "Einstellungen",
    body: (
      <>
        <p>Hier beginnen Sie am besten: Ihre Firmendaten erscheinen auf jedem Beleg.</p>
        <Where
          items={[
            ["Unternehmen", "Name, Adresse, UID, Bankverbindung, Logo."],
            ["Belege", "Kleinunternehmerregelung, Zahlungsziel, Texte."],
            ["PDF-Vorlagen", "Das Layout Ihrer Belege im Designer anpassen."],
            ["Export", "Backups und Export für Ihre Steuerberatung (BMD, RZL)."],
          ]}
        />
        <p className="mt-3">Das Fragezeichen daneben startet diesen Rundgang neu.</p>
      </>
    ),
  },
  {
    target: "assistant",
    title: "Assistent",
    body: (
      <p>
        Fragen Sie in eigenen Worten, etwa „Welche Rechnungen sind offen?“, oder lassen Sie ihn Entwürfe anlegen. Das
        Sprachmodell läuft lokal, und bevor er etwas ändert, fragt er nach. Öffnen mit <Kbd>{modKey}</Kbd> <Kbd>J</Kbd>.
      </p>
    ),
  },
  {
    title: "Los geht's",
    body: (
      <p>
        Am einfachsten starten Sie mit Ihren Firmendaten, dann legen Sie einen Kunden und die erste Rechnung an. Solange
        es noch keine Belege gibt, führt eine Checkliste auf dem Dashboard durch diese Schritte.
      </p>
    ),
  },
];

const CARD_WIDTH = 360;
const GAP = 14;
const MARGIN = 16;
const PAD = 6;

type Rect = { top: number; left: number; width: number; height: number };

const findTarget = (target: string) => {
  const el = document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
  // hidden (display:none / the `hidden` attribute) elements have no box
  return el && el.getClientRects().length > 0 ? el : null;
};

function measure(target: string | undefined): Rect | null {
  const el = target ? findTarget(target) : null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // keep the ring on screen for targets at the window edge (the settings bar, the assistant button)
  const top = Math.max(2, r.top - PAD);
  const left = Math.max(2, r.left - PAD);
  const bottom = Math.min(window.innerHeight - 2, r.bottom + PAD);
  const right = Math.min(window.innerWidth - 2, r.right + PAD);
  return { top, left, width: right - left, height: bottom - top };
}

/** Card position next to the spotlight: to its right if there's room, else above it, right-aligned. */
function place(rect: Rect, cardHeight: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampTop = (t: number) => Math.max(MARGIN, Math.min(t, vh - cardHeight - MARGIN));
  if (rect.left + rect.width + GAP + CARD_WIDTH + MARGIN <= vw) {
    return { top: clampTop(rect.top), left: rect.left + rect.width + GAP };
  }
  const left = Math.max(MARGIN, Math.min(rect.left + rect.width - CARD_WIDTH, vw - CARD_WIDTH - MARGIN));
  return { top: clampTop(rect.top - GAP - cardHeight), left };
}

/** Starts the tour once per browser, outside the full-screen template designer. */
function useAutoStart() {
  const designer = useRouterState({ select: (s) => /^\/templates\/\d+/.test(s.location.pathname) });
  useEffect(() => {
    if (designer || tourSeen()) return;
    // after the first paint, so the shell (and the assistant button) is laid out
    const t = setTimeout(() => tour.start(), 400);
    return () => clearTimeout(t);
  }, [designer]);
}

export function Tour() {
  useAutoStart();
  const open = useTourOpen();
  return open ? <TourOverlay /> : null;
}

function TourOverlay() {
  // only steps whose target exists right now; welcome/finish always
  const [steps] = useState(() => STEPS.filter((s) => !s.target || s.group || findTarget(s.target)));
  const [index, setIndex] = useState(0);
  const step = steps[index];
  const last = index === steps.length - 1;
  const [rect, setRect] = useState<Rect | null>(null);
  const [cardHeight, setCardHeight] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);

  const next = () => (last ? tour.close() : setIndex((i) => i + 1));
  const back = () => setIndex((i) => Math.max(0, i - 1));

  // open the group, then follow the target while it animates open and on resize
  useLayoutEffect(() => {
    if (step.group) window.dispatchEvent(new CustomEvent(SIDEBAR_OPEN_EVENT, { detail: step.group }));
    let frame = 0;
    const started = performance.now();
    const follow = () => {
      setRect(measure(step.target));
      if (performance.now() - started < 400) frame = requestAnimationFrame(follow);
    };
    follow();
    const onResize = () => setRect(measure(step.target));
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, [step]);

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    setCardHeight(el.offsetHeight);
    el.focus();
  }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") tour.close();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") back();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    // capture: before the global shortcuts and Radix layers see the key
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const centred = !rect;
  const pos = rect && place(rect, cardHeight);
  const titleId = "tour-title";

  return (
    <div className="fixed inset-0 z-[60]" role="presentation">
      {/* the dimmed backdrop: the cut-out's huge shadow, or a plain layer for centred steps */}
      {rect ? (
        <div
          aria-hidden
          className="pointer-events-none absolute rounded-lg shadow-[0_0_0_9999px_rgb(0_0_0/0.55)] ring-2 ring-brand transition-all duration-200 ease-out motion-reduce:transition-none"
          style={rect}
        />
      ) : (
        <div aria-hidden className="absolute inset-0 bg-black/55" />
      )}
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          "absolute rounded-xl border bg-popover p-5 text-sm text-popover-foreground shadow-xl outline-none",
          "transition-[top,left] duration-200 ease-out motion-reduce:transition-none",
          centred && "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
        )}
        style={{ width: CARD_WIDTH, ...(pos ?? {}) }}
      >
        {index === 0 && <Logo className="mb-4 h-6 text-foreground" aria-hidden />}
        <h2 id={titleId} className="text-base font-semibold">
          {step.title}
        </h2>
        <div className="mt-2 leading-relaxed text-muted-foreground">{step.body}</div>
        <div className="mt-5 flex items-center gap-2">
          <div className="flex flex-1 items-center gap-1" aria-label={`Schritt ${index + 1} von ${steps.length}`}>
            {steps.map((s, i) => (
              <span
                key={s.title}
                aria-hidden
                className={cn("h-1.5 rounded-full transition-all", i === index ? "w-4 bg-brand" : "w-1.5 bg-border")}
              />
            ))}
          </div>
          {index === 0 ? (
            <Button size="sm" variant="ghost" onClick={tour.close}>
              Später
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={back}>
              Zurück
            </Button>
          )}
          <Button size="sm" onClick={next}>
            {index === 0 ? "Rundgang starten" : last ? "Fertig" : "Weiter"}
          </Button>
        </div>
        {index > 0 && !last && (
          <button
            type="button"
            onClick={tour.close}
            className="absolute top-3 right-3 rounded px-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Überspringen
          </button>
        )}
      </div>
    </div>
  );
}
