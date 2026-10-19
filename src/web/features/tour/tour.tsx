import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Kbd, modKey } from "@/features/search/kbd";
import { cn } from "@/lib/utils";
import { SIDEBAR_OPEN_EVENT, tour, tourSeen, useTourOpen } from "./tour-store";

// Guided tour for first-time users: a dimmed overlay with a cut-out around one part of the shell (elements marked
// with data-tour="…") and a card that explains it. Steps without a target (welcome, finish) show the card centred.
// A step whose target isn't on screen (e.g. the assistant button while the assistant is off) is skipped. On small
// screens the sidebar sits in a sheet behind the menu button: its steps then point at that button instead.
// Keys: → / Enter next, ← back, Esc ends; Tab stays inside the card (aria-modal). It never navigates; it only opens
// the sidebar group it points at.

interface Step {
  /** data-tour value of the element to highlight; none → centred card. */
  target?: string;
  /** Sidebar group to open before measuring. */
  group?: string;
  /** Part of the sidebar: highlight the menu button when the sidebar is collapsed into it (small screens). */
  sidebar?: boolean;
  title: string;
  body: ReactNode;
}

function Where({ items }: { items: [string, string][] }) {
  return (
    <dl className="mt-3 space-y-1.5 text-xs">
      {items.map(([name, text]) => (
        <div key={name} className="grid grid-cols-[7.5rem_1fr] gap-2">
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
        <p className="mt-2">In einer Minute zeigen wir dir, wo du was findest.</p>
      </>
    ),
  },
  {
    target: "overview",
    sidebar: true,
    title: "Überblick",
    body: (
      <Where
        items={[
          ["Dashboard", "Umsatz im Jahresverlauf, offene und überfällige Rechnungen, Kleinunternehmergrenze."],
          ["Zahlungsprognose", "Erwartete Ein- und Ausgänge der nächsten Monate und dein voraussichtlicher Kontostand."],
        ]}
      />
    ),
  },
  {
    target: "group-Belege",
    sidebar: true,
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
            ["Serienrechnungen", "Wiederkehrende Rechnungen, die nesev zum Termin erstellt."],
          ]}
        />
      </>
    ),
  },
  {
    target: "group-Finanzen",
    sidebar: true,
    group: "Finanzen",
    title: "Ausgaben, Bank und Steuern",
    body: (
      <Where
        items={[
          ["Ausgaben", "Belege als Foto oder PDF ablegen; die Belegerkennung liest sie lokal aus, wenn du es willst."],
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
    sidebar: true,
    group: "Stammdaten",
    title: "Kunden und Artikel",
    body: (
      <Where
        items={[
          ["Kunden", "Aus Österreich, der EU oder einem Drittland; die Steuerbehandlung ergibt sich daraus."],
          ["Artikel", "Leistungen und Produkte, die du oft verrechnest, mit Preis und Einheit."],
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
    sidebar: true,
    title: "Einstellungen",
    body: (
      <>
        <p>Hier beginnst du am besten: Deine Firmendaten erscheinen auf jedem Beleg.</p>
        <Where
          items={[
            ["Unternehmen", "Name, Adresse, UID, Bankverbindung, Logo."],
            ["Belege", "Kleinunternehmerregelung, Zahlungsziel, Texte."],
            ["PDF-Vorlagen", "Das Layout deiner Belege im Designer anpassen."],
            ["Export", "Backups und Export für deine Steuerberatung (BMD, RZL)."],
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
        Frag in eigenen Worten, etwa „Welche Rechnungen sind offen?“, oder lass ihn Entwürfe anlegen. Das
        Sprachmodell läuft lokal, und bevor er etwas ändert, fragt er nach. Öffnen mit <Kbd>{modKey}</Kbd> <Kbd>J</Kbd>.
      </p>
    ),
  },
  {
    title: "Los geht's",
    body: (
      <p>
        Am einfachsten startest du mit deinen Firmendaten, dann legst du einen Kunden und die erste Rechnung an. Solange
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

const MENU_TARGET = "menu";

const findTarget = (target: string) => {
  // hidden (display:none / the `hidden` attribute) elements have no box
  const all = document.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`);
  return [...all].find((el) => el.getClientRects().length > 0) ?? null;
};

/** The element a step highlights right now: its own target, or the menu button for sidebar steps on small screens. */
const stepTarget = (step: Step) => {
  if (!step.target) return null;
  return findTarget(step.target) ?? (step.sidebar ? findTarget(MENU_TARGET) : null);
};

const cardWidth = () => Math.min(CARD_WIDTH, window.innerWidth - 2 * MARGIN);

function measure(step: Step): Rect | null {
  const el = stepTarget(step);
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
  const width = cardWidth();
  const clampTop = (t: number) => Math.max(MARGIN, Math.min(t, vh - cardHeight - MARGIN));
  if (rect.left + rect.width + GAP + width + MARGIN <= vw) {
    return { top: clampTop(rect.top), left: rect.left + rect.width + GAP };
  }
  const left = Math.max(MARGIN, Math.min(rect.left + rect.width - width, vw - width - MARGIN));
  // above the target, or below it when there's no room above (the menu button in the top bar)
  const above = rect.top - GAP - cardHeight;
  return { top: clampTop(above >= MARGIN ? above : rect.top + rect.height + GAP), left };
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
  const [steps] = useState(() => STEPS.filter((s) => !s.target || s.group || stepTarget(s)));
  const [index, setIndex] = useState(0);
  const step = steps[index];
  const last = index === steps.length - 1;
  const [rect, setRect] = useState<Rect | null>(null);
  const [cardHeight, setCardHeight] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  const next = () => (last ? tour.close() : setIndex((i) => i + 1));
  const back = () => setIndex((i) => Math.max(0, i - 1));

  // open the group, then follow the target while it animates open and on resize
  useLayoutEffect(() => {
    if (step.group) window.dispatchEvent(new CustomEvent(SIDEBAR_OPEN_EVENT, { detail: step.group }));
    let frame = 0;
    const started = performance.now();
    const follow = () => {
      setRect(measure(step));
      if (performance.now() - started < 400) frame = requestAnimationFrame(follow);
    };
    follow();
    const onResize = () => setRect(measure(step));
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
    (primaryRef.current ?? el).focus();
  }, [step]);

  useEffect(() => {
    const card = cardRef.current;
    const focusables = () => [...(card?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
    const onKey = (e: KeyboardEvent) => {
      const inCard = !!card && e.target instanceof Node && card.contains(e.target);
      if (e.key === "Escape") tour.close();
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") back();
      else if (e.key === "Tab") {
        // focus trap: cycle through the card's buttons
        const items = focusables();
        if (!items.length) return;
        const i = items.indexOf(document.activeElement as HTMLElement);
        const to = e.shiftKey ? (i <= 0 ? items.length - 1 : i - 1) : i === -1 || i === items.length - 1 ? 0 : i + 1;
        items[to]!.focus();
      } else if (e.key === "Enter") {
        // a focused card button handles Enter itself (Zurück, Überspringen); anywhere else Enter means "next"
        if (inCard && e.target instanceof HTMLButtonElement) {
          e.stopPropagation();
          return;
        }
        next();
      } else {
        // nothing else reaches the page (global shortcuts like g d would navigate under the overlay); default actions
        // such as Space on a focused card button still happen
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    // focus that lands outside the card (a click on the backdrop, a programmatic focus) goes back to it
    const onFocusIn = (e: FocusEvent) => {
      if (card && e.target instanceof Node && !card.contains(e.target)) (primaryRef.current ?? card).focus();
    };
    // capture: before the global shortcuts and Radix layers see the key
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn);
    };
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
        style={{ width: `min(${CARD_WIDTH}px, calc(100vw - ${2 * MARGIN}px))`, ...(pos ?? {}) }}
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
          <Button ref={primaryRef} size="sm" onClick={next}>
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
