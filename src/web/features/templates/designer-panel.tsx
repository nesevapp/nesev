import { useMemo, useState } from "react";
import type { Schema, Template } from "@pdfme/common";
import {
  ArrowDown,
  ArrowUp,
  Circle,
  Copy,
  Image,
  List,
  Minus,
  Plus,
  QrCode,
  Shapes,
  Square,
  Table,
  Type,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { outlineTemplate } from "@shared/pdf/layout";
import { PDF_VARIABLES, type PdfInput, type PdfVariable } from "@shared/pdf/variables";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const VARIABLES_BY_NAME = new Map(PDF_VARIABLES.map((v) => [v.name, v]));

const TYPES: Record<string, { label: string; icon: LucideIcon }> = {
  text: { label: "Text", icon: Type },
  multiVariableText: { label: "Text", icon: Type },
  table: { label: "Tabelle", icon: Table },
  list: { label: "Liste", icon: List },
  image: { label: "Bild", icon: Image },
  svg: { label: "SVG", icon: Shapes },
  qrcode: { label: "QR-Code", icon: QrCode },
  line: { label: "Linie", icon: Minus },
  rectangle: { label: "Rechteck", icon: Square },
  ellipse: { label: "Ellipse", icon: Circle },
};

/** Human-readable name: the variable label for bound fields, otherwise the text (or the element type). */
function schemaLabel(s: Schema): string {
  const variable = VARIABLES_BY_NAME.get(s.name);
  if (variable && !s.readOnly) return variable.label;
  if (s.name === "pageNumber") return "Seitenzahl";
  const content = typeof s.content === "string" ? s.content.trim() : "";
  if (s.type !== "text" || !content) return TYPES[s.type]?.label ?? s.type;
  const single = /^\{(\w+)\}$/.exec(content);
  if (single && VARIABLES_BY_NAME.has(single[1]!)) return VARIABLES_BY_NAME.get(single[1]!)!.label;
  const firstLine = content.split("\n")[0]!;
  return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
}

export function DesignerPanel({
  template,
  sample,
  disabled,
  onSelect,
  onMoveSection,
  onInsert,
}: {
  template: Template;
  sample?: PdfInput;
  disabled: boolean;
  onSelect: (name: string) => void;
  onMoveSection: (index: number, direction: -1 | 1) => void;
  onInsert: (v: PdfVariable) => void;
}) {
  const usedNames = useMemo(() => new Set(template.schemas.flat().map((s) => s.name)), [template]);
  return (
    <Tabs defaultValue="structure" className="h-full gap-0">
      <div className="border-b p-3">
        <TabsList className="w-full">
          <TabsTrigger value="structure">Aufbau</TabsTrigger>
          <TabsTrigger value="variables">Variablen</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="structure" className="min-h-0">
        <StructureTab template={template} disabled={disabled} onSelect={onSelect} onMoveSection={onMoveSection} />
      </TabsContent>
      <TabsContent value="variables" className="min-h-0">
        <VariablesTab usedNames={usedNames} sample={sample} disabled={disabled} onInsert={onInsert} />
      </TabsContent>
    </Tabs>
  );
}

function StructureTab({
  template,
  disabled,
  onSelect,
  onMoveSection,
}: {
  template: Template;
  disabled: boolean;
  onSelect: (name: string) => void;
  onMoveSection: (index: number, direction: -1 | 1) => void;
}) {
  const outline = useMemo(() => outlineTemplate(template), [template]);
  const elements = (schemas: Schema[]) => (
    <ul className="space-y-px">
      {schemas.map((s) => {
        const Icon = TYPES[s.type]?.icon ?? Square;
        return (
          <li key={s.name}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSelect(s.name)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-sidebar-accent"
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{schemaLabel(s)}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
  const heading = (title: string, note?: string) => (
    <div className="mb-1 flex items-baseline justify-between px-2 text-[11px] font-medium tracking-wider text-muted-foreground/80 uppercase">
      {title}
      {note && <span className="font-normal tracking-normal normal-case">{note}</span>}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        {outline.header.length > 0 && (
          <section>
            {heading("Kopfbereich", "auf jeder Seite")}
            {elements(outline.header)}
          </section>
        )}
        <section>
          {heading("Inhalt", "von oben nach unten")}
          <ol className="space-y-1.5">
            {outline.sections.map((section, i) => (
              <li key={section.map((s) => s.name).join()} className="group rounded-lg border bg-background py-1">
                <div className="flex items-start gap-1 pr-1">
                  <div className="min-w-0 flex-1">{elements(section)}</div>
                  <div className="flex opacity-40 group-hover:opacity-100 focus-within:opacity-100">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      disabled={disabled || i === 0}
                      onClick={() => onMoveSection(i, -1)}
                      aria-label="Abschnitt nach oben"
                    >
                      <ArrowUp className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      disabled={disabled || i === outline.sections.length - 1}
                      onClick={() => onMoveSection(i, 1)}
                      aria-label="Abschnitt nach unten"
                    >
                      <ArrowDown className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
        {outline.footer.length > 0 && (
          <section>
            {heading("Fußbereich", "auf jeder Seite")}
            {elements(outline.footer)}
          </section>
        )}
      </div>
      <div className="space-y-2 border-t p-3 text-xs leading-relaxed text-muted-foreground">
        <p>
          Die Reihenfolge ergibt sich aus der Position auf der Seite. Wächst ein Abschnitt (z. B. viele Positionen),
          rutscht alles darunter nach und fließt auf Folgeseiten. Mit den Pfeilen tauschst du Abschnitte.
        </p>
        <p>Neue Texte, Linien oder Bilder aus der linken Leiste auf die Seite ziehen. Element anklicken zum Bearbeiten.</p>
      </div>
    </div>
  );
}

function VariablesTab({
  usedNames,
  sample,
  disabled,
  onInsert,
}: {
  usedNames: Set<string>;
  sample?: PdfInput;
  disabled: boolean;
  onInsert: (v: PdfVariable) => void;
}) {
  const [filter, setFilter] = useState("");
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const map = new Map<string, PdfVariable[]>();
    for (const v of PDF_VARIABLES) {
      if (q && !v.label.toLowerCase().includes(q) && !v.name.toLowerCase().includes(q)) continue;
      map.set(v.group, [...(map.get(v.group) ?? []), v]);
    }
    return [...map.entries()];
  }, [filter]);

  const copy = async (v: PdfVariable) => {
    await navigator.clipboard.writeText(`{${v.name}}`).catch(() => {});
    toast.success(`{${v.name}} kopiert`);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pt-3">
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Suchen…" className="h-8 bg-background" />
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        {groups.map(([group, vars]) => (
          <div key={group}>
            <div className="mb-1 px-2 text-[11px] font-medium tracking-wider text-muted-foreground/80 uppercase">{group}</div>
            <ul className="space-y-0.5">
              {vars.map((v) => {
                const used = usedNames.has(v.name);
                const example = sample?.[v.name];
                return (
                  <li key={v.name} className="group flex items-center gap-1 rounded-md px-2 py-1 hover:bg-sidebar-accent">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="min-w-0 flex-1 cursor-default">
                          <div className="flex items-center gap-1.5 truncate text-sm">
                            {used && <span className="size-1.5 shrink-0 rounded-full bg-success-solid" />}
                            <span className="truncate">{v.label}</span>
                          </div>
                          <div className="truncate font-mono text-[11px] text-muted-foreground">{`{${v.name}}`}</div>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="max-w-72 whitespace-pre-wrap">
                        {used ? "In der Vorlage verwendet. " : ""}
                        {example && v.kind === "text" ? `Beispiel:\n${example.slice(0, 200)}` : v.label}
                      </TooltipContent>
                    </Tooltip>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => copy(v)}
                      aria-label={`{${v.name}} kopieren`}
                    >
                      <Copy className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={() => onInsert(v)}
                      disabled={disabled || (used && v.kind !== "text")}
                      aria-label={`${v.label} einfügen`}
                    >
                      <Plus className="size-3.5" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t p-3 text-xs leading-relaxed text-muted-foreground">
        <strong className="font-medium text-foreground">+</strong> fügt ein Feld mit dem Wert der Variable ein. In
        Texten lassen sich Platzhalter wie <code className="font-mono">{"{documentNumber}"}</code> kombinieren
        (kopieren und in einen Text einfügen).
      </div>
    </div>
  );
}
