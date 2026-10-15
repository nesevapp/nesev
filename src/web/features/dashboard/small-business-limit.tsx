import { formatDate } from "@shared/dates";
import { formatCents } from "@shared/money";
import type { SmallBusinessLevel } from "@shared/small-business";
import { cn } from "@/lib/utils";
import type { Dashboard } from "@/sdk";

type Limit = NonNullable<Dashboard["smallBusiness"]>;

const BAR: Record<SmallBusinessLevel, string> = {
  ok: "bg-primary",
  warn: "bg-amber-500",
  tolerance: "bg-orange-500",
  exceeded: "bg-red-600",
};

const FRAME: Record<SmallBusinessLevel, string> = {
  ok: "",
  warn: "border-amber-200 bg-amber-50/60",
  tolerance: "border-orange-200 bg-orange-50/60",
  exceeded: "border-red-200 bg-red-50/60",
};

const pct = (part: number, whole: number) => Math.round((part / whole) * 100);

/** Kleinunternehmer: gross turnover of the year vs. the € 55.000 limit (shown only when the setting is on). */
export function SmallBusinessLimitCard({ limit, isCurrentYear }: { limit: Limit; isCurrentYear: boolean }) {
  const { year, turnoverCents, projectedCents, limitCents, toleranceCents } = limit;
  const level: SmallBusinessLevel = limit.previousYearExceeded ? "exceeded" : limit.level;
  const showProjection = isCurrentYear && projectedCents > turnoverCents;
  const scale = Math.max(toleranceCents * 1.1, projectedCents, turnoverCents);
  const at = (cents: number) => `${Math.min(100, Math.max(0, (cents / scale) * 100))}%`;

  return (
    <section className={cn("space-y-3 rounded-lg border px-4 py-3", FRAME[level])} aria-label="Kleinunternehmergrenze">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-sm font-medium">Kleinunternehmergrenze {year}</h2>
        <span className="text-sm tabular">
          <span className="font-medium">{formatCents(turnoverCents)}</span>
          <span className="text-muted-foreground">
            {" "}
            von {formatCents(limitCents)} · {pct(turnoverCents, limitCents)} %
          </span>
        </span>
      </div>

      <div className="relative h-2 rounded-full bg-muted" role="img" aria-label={`${pct(turnoverCents, limitCents)} % der Umsatzgrenze`}>
        {showProjection && (
          <div className={cn("absolute inset-y-0 left-0 rounded-full opacity-30", BAR[limit.projectedLevel])} style={{ width: at(projectedCents) }} />
        )}
        <div className={cn("absolute inset-y-0 left-0 rounded-full", BAR[level])} style={{ width: at(turnoverCents) }} />
        <Marker left={at(limitCents)} />
        <Marker left={at(toleranceCents)} dashed />
      </div>
      <div className="relative h-3 text-[11px] text-muted-foreground tabular">
        <span className="absolute -translate-x-1/2" style={{ left: at(limitCents) }}>
          55.000
        </span>
        <span className="absolute -translate-x-1/2" style={{ left: at(toleranceCents) }}>
          60.500
        </span>
      </div>

      <Message limit={limit} level={level} showProjection={showProjection} />

      <p className="text-xs text-muted-foreground">
        Bruttoumsatz nach Rechnungsdatum (Rechnungen abzgl. Gutschriften). Grenze € 55.000 pro Jahr, bis € 60.500
        (10 % Toleranz) bleibt das laufende Jahr steuerfrei. Nicht jeder Umsatz zählt mit (z. B. Hilfsgeschäfte). Eine
        Hilfe zur Planung, keine Steuerberatung.
      </p>
    </section>
  );
}

function Marker({ left, dashed }: { left: string; dashed?: boolean }) {
  return (
    <div
      className={cn("absolute -top-1 -bottom-1 w-0 border-l border-foreground/60", dashed && "border-dashed border-foreground/40")}
      style={{ left }}
    />
  );
}

function Message({ limit, level, showProjection }: { limit: Limit; level: SmallBusinessLevel; showProjection: boolean }) {
  const { year, turnoverCents, projectedCents, limitCents } = limit;
  const lines: string[] = [];

  if (limit.previousYearExceeded) {
    lines.push(
      `Der Umsatz ${year - 1} lag mit ${formatCents(limit.previousYearCents)} über € 55.000 – die Kleinunternehmerregelung gilt ${year} nicht. Rechnungen sind umsatzsteuerpflichtig.`,
    );
  } else if (level === "exceeded") {
    lines.push(
      `Grenze samt Toleranz (€ 60.500)${limit.exceededOn ? ` am ${formatDate(limit.exceededOn)}` : ""} überschritten: Die Befreiung endete mit dieser Rechnung – sie und alle weiteren sind umsatzsteuerpflichtig. Bitte mit der Steuerberatung klären.`,
    );
  } else if (level === "tolerance") {
    lines.push(
      `€ 55.000 überschritten, aber innerhalb der 10 % Toleranz: ${year} bleibt steuerfrei, solange € 60.500 nicht überschritten werden. Ab ${year + 1} gilt die Regelung nicht mehr.`,
    );
  } else if (level === "warn") {
    lines.push(`${pct(turnoverCents, limitCents)} % der Grenze erreicht – noch ${formatCents(limitCents - turnoverCents)} bis € 55.000.`);
  }

  if (showProjection && !limit.previousYearExceeded && level !== "exceeded") {
    const outlook =
      limit.projectedLevel === "exceeded"
        ? " – damit würde die Toleranzgrenze von € 60.500 überschritten"
        : limit.projectedLevel === "tolerance"
          ? " – damit würde die Grenze von € 55.000 überschritten"
          : "";
    lines.push(`Mit Entwürfen und Serienrechnungen bis 31.12. voraussichtlich ${formatCents(projectedCents)}${outlook}.`);
  }

  if (lines.length === 0) return null;
  return (
    <div className={cn("space-y-1 text-sm", level === "exceeded" && "font-medium text-red-800", level === "tolerance" && "text-orange-900", level === "warn" && "text-amber-900")}>
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </div>
  );
}
