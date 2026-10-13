import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useBlocker } from "@tanstack/react-router";
import type { Plugins, Schema, Template } from "@pdfme/common";
import type { Designer } from "@pdfme/ui";
import { ArrowLeft, Eye, FileUp, Loader2, Save, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { TEMPLATE_DOC_TYPE_LABELS, TEMPLATE_DOC_TYPES, type TemplateDocType } from "@shared/documents";
import { defaultTemplate } from "@shared/pdf/default-template";
import { FONT_REGULAR, PDF_PLUGINS } from "@shared/pdf/plugins";
import { moveSection, nextFreeY } from "@shared/pdf/layout";
import type { PdfInput, PdfVariable } from "@shared/pdf/variables";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  apiErrorMessage,
  fileUrl,
  templateQuery,
  templateSampleQuery,
  useRemoveBasePdf,
  useUpdateTemplate,
  useUploadBasePdf,
} from "@/sdk";
import { DesignerPanel } from "./designer-panel";
import { loadFonts, openPreview } from "./pdf-runtime";
import "./designer.css";

const route = getRouteApi("/templates/$id");

const schemaNames = (t: Template) => new Set(t.schemas.flat().map((s) => s.name));

const TEXT_DEFAULTS = {
  fontName: FONT_REGULAR,
  fontSize: 9,
  lineHeight: 1.3,
  fontColor: "#1f2328",
};

/**
 * Designer-only plugin variants: a text dragged from the palette is static (read-only, so `{placeholders}` work)
 * and uses the document font. Types and rendering are unchanged, so generator and Designer stay compatible.
 */
const DESIGNER_PLUGINS: Plugins = {
  ...PDF_PLUGINS,
  Text: {
    ...PDF_PLUGINS.Text!,
    propPanel: {
      ...PDF_PLUGINS.Text!.propPanel,
      defaultSchema: {
        ...PDF_PLUGINS.Text!.propPanel.defaultSchema,
        ...TEXT_DEFAULTS,
        content: "Text",
        width: 60,
        height: 6,
        readOnly: true,
      },
    },
  },
};

export function TemplateDesignerPage() {
  const { id } = route.useParams();
  const { data: row } = useSuspenseQuery(templateQuery(id));
  const { data: sample } = useQuery(templateSampleQuery(id));
  const update = useUpdateTemplate(id);
  const uploadBasePdf = useUploadBasePdf(id);
  const removeBasePdf = useRemoveBasePdf(id);

  const containerRef = useRef<HTMLDivElement>(null);
  const designerRef = useRef<Designer | null>(null);
  const savedJsonRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [name, setName] = useState(row.name);
  const [docType, setDocType] = useState<TemplateDocType>(row.docType);
  // Latest template from the Designer, for the outline and the "used" markers in the panel.
  const [template, setTemplate] = useState(() => row.template as Template);
  const [hasSelection, setHasSelection] = useState(false);

  const metaDirty = name !== row.name || docType !== row.docType;
  const hasChanges = dirty || metaDirty;

  // Mount the pdfme Designer once per template id (later saves must not reset the canvas).
  useEffect(() => {
    let disposed = false;
    let designer: Designer | undefined;
    setReady(false);
    (async () => {
      const [{ Designer }, fonts] = await Promise.all([import("@pdfme/ui"), loadFonts()]);
      if (disposed || !containerRef.current) return;
      designer = new Designer({
        domContainer: containerRef.current,
        template: row.template as Template,
        plugins: DESIGNER_PLUGINS,
        options: {
          font: fonts,
          lang: "de",
          labels: { editField: "Eigenschaften" },
          // Always open: when nothing is selected, our panel covers pdfme's field list (see below).
          sidebarOpen: true,
          theme: { token: { colorPrimary: "#18181b", borderRadius: 6, fontSize: 13 } },
        },
      });
      // The Designer normalises the template asynchronously after mounting and reports that as a change,
      // so the "saved" state is captured once it has settled.
      const created = designer;
      savedJsonRef.current = null;
      setTimeout(() => {
        if (!disposed) savedJsonRef.current = JSON.stringify(created.getTemplate());
      }, 500);
      designer.onChangeTemplate((t) => {
        if (savedJsonRef.current !== null) setDirty(JSON.stringify(t) !== savedJsonRef.current);
        setTemplate(t);
      });
      designer.onChangeSelection((selection) => setHasSelection(selection.schemas.length > 0));
      designer.onSaveTemplate(() => saveRef.current());
      designerRef.current = designer;
      setReady(true);
    })().catch((err) => toast.error(apiErrorMessage(err)));
    return () => {
      disposed = true;
      designer?.destroy();
      designerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remount only for another template
  }, [row.id]);

  const save = useCallback(() => {
    const designer = designerRef.current;
    if (!designer) return;
    const template = designer.getTemplate();
    update.mutate(
      { name: name.trim() || row.name, docType, template },
      {
        onSuccess: () => {
          savedJsonRef.current = JSON.stringify(template);
          setDirty(false);
          toast.success("Vorlage gespeichert");
        },
        onError: (err) => toast.error(apiErrorMessage(err)),
      },
    );
  }, [update, name, docType, row.name]);
  const saveRef = useRef(save);
  saveRef.current = save;

  useBlocker({
    shouldBlockFn: () => hasChanges && !window.confirm("Ungespeicherte Änderungen verwerfen?"),
    enableBeforeUnload: () => hasChanges,
  });

  const preview = async () => {
    const designer = designerRef.current;
    if (!designer || !sample) return;
    setPreviewing(true);
    try {
      await openPreview(designer.getTemplate(), sample.input, row.basePdfPath);
    } catch (err) {
      toast.error(`Vorschau fehlgeschlagen: ${apiErrorMessage(err)}`);
    } finally {
      setPreviewing(false);
    }
  };

  // updateTemplate() does not fire onChangeTemplate, so mirror the change here.
  const applyTemplate = (next: Template) => {
    designerRef.current?.updateTemplate(next);
    setTemplate(next);
    setDirty(savedJsonRef.current === null || JSON.stringify(next) !== savedJsonRef.current);
  };

  const insertVariable = (v: PdfVariable) => {
    const designer = designerRef.current;
    if (!designer) return;
    const current = designer.getTemplate();
    const result = createVariableSchema(v, current, row.docType, sample?.input ?? {});
    if (!result) {
      toast.info(`„${v.label}“ ist bereits in der Vorlage. Platzhalter {${v.name}} in einem Text verwenden.`);
      return;
    }
    const [first = [], ...rest] = current.schemas;
    applyTemplate({ ...current, schemas: [[...first, result], ...rest] });
    // the Designer applies updateTemplate() on its next render, select the new element after that
    setTimeout(() => designer.selectSchemas({ name: result.name, pageIndex: 0 }, { scroll: true }), 50);
  };

  const moveTemplateSection = (index: number, direction: -1 | 1) => {
    const designer = designerRef.current;
    if (designer) applyTemplate(moveSection(designer.getTemplate(), index, direction));
  };

  const selectElement = (name: string) => designerRef.current?.selectSchemas({ name, pageIndex: 0 }, { scroll: true });

  const onUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    uploadBasePdf.mutate(file, {
      onSuccess: () => toast.success("Briefpapier hochgeladen – sichtbar in der Vorschau und im fertigen PDF"),
      onError: (err) => toast.error(apiErrorMessage(err)),
    });
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <Button variant="ghost" size="icon" className="size-8" asChild>
          <Link to="/templates" aria-label="Zurück">
            <ArrowLeft />
          </Link>
        </Button>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-8 w-64 font-medium"
          aria-label="Name der Vorlage"
        />
        <Select value={docType} onValueChange={(v) => setDocType(v as TemplateDocType)} disabled={row.isDefault}>
          <SelectTrigger size="sm" className="w-36" aria-label="Belegart">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TEMPLATE_DOC_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {TEMPLATE_DOC_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {row.isDefault && (
          <Badge variant="secondary" className="font-normal">
            <Star className="fill-current" /> Standard
          </Badge>
        )}
        {hasChanges && <span className="text-xs text-muted-foreground">Ungespeicherte Änderungen</span>}
        <div className="ml-auto flex items-center gap-2">
          <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden" onChange={onUpload} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={uploadBasePdf.isPending || removeBasePdf.isPending}>
                <FileUp /> Briefpapier{row.basePdfPath ? " ✓" : ""}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onSelect={() => fileInputRef.current?.click()}>
                <FileUp /> {row.basePdfPath ? "Briefpapier ersetzen…" : "Briefpapier hochladen (PDF)…"}
              </DropdownMenuItem>
              {row.basePdfPath && (
                <>
                  <DropdownMenuItem asChild>
                    <a href={fileUrl(row.basePdfPath)} target="_blank" rel="noreferrer">
                      <Eye /> Briefpapier anzeigen
                    </a>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() =>
                      removeBasePdf.mutate(undefined, {
                        onSuccess: () => toast.success("Briefpapier entfernt"),
                        onError: (err) => toast.error(apiErrorMessage(err)),
                      })
                    }
                  >
                    <Trash2 /> Briefpapier entfernen
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" size="sm" onClick={preview} disabled={!ready || !sample || previewing}>
            {previewing ? <Loader2 className="animate-spin" /> : <Eye />} Vorschau
          </Button>
          <Button size="sm" onClick={save} disabled={!ready || update.isPending || !hasChanges}>
            {update.isPending ? <Loader2 className="animate-spin" /> : <Save />} Speichern
          </Button>
        </div>
      </header>

      <div className="nesev-designer relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        {!ready && (
          <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        )}
        {/* One right panel: structure/variables, replaced by pdfme's properties (same 400px slot) while an
            element is selected. pdfme's own field list underneath only reorders z-order, so it stays covered. */}
        {ready && !hasSelection && (
          <aside className="absolute inset-y-0 right-0 z-10 w-[400px] border-l bg-sidebar">
            <DesignerPanel
              template={template}
              sample={sample?.input}
              disabled={!ready}
              onSelect={selectElement}
              onMoveSection={moveTemplateSection}
              onInsert={insertVariable}
            />
          </aside>
        )}
      </div>
    </div>
  );
}

/**
 * New schema for a variable: the default layout's element if it exists there, otherwise a plugin default.
 * If a bound field already exists, text variables get a read-only text with a `{placeholder}` instead.
 * Returns null when nothing sensible can be added (e.g. a second items table).
 */
function createVariableSchema(v: PdfVariable, template: Template, docType: TemplateDocType, sample: PdfInput): Schema | null {
  const names = schemaNames(template);
  const uniqueName = (base: string) => {
    let i = 2;
    while (names.has(`${base}_${i}`)) i++;
    return `${base}_${i}`;
  };
  const position = { x: 25, y: nextFreeY(template, 6) };
  const textDefaults = { ...(DESIGNER_PLUGINS.Text!.propPanel.defaultSchema as Schema), position };

  if (v.group === "Seite") {
    return { ...textDefaults, name: uniqueName("pageNumber"), readOnly: true, content: "Seite {currentPage} von {totalPages}" };
  }
  if (names.has(v.name)) {
    if (v.kind !== "text") return null;
    return { ...textDefaults, name: uniqueName(v.name), readOnly: true, content: `{${v.name}}` };
  }
  const fromDefault = defaultTemplate(docType).schemas[0]!.find((s) => s.name === v.name)
    ?? defaultTemplate("invoice").schemas[0]!.find((s) => s.name === v.name);
  if (fromDefault) return structuredClone(fromDefault);

  const content = sample[v.name] ?? "";
  if (v.kind === "image") {
    const image = PDF_PLUGINS.Bild!.propPanel.defaultSchema as Schema;
    return { ...image, name: v.name, content, position: { x: 25, y: nextFreeY(template, image.height) } };
  }
  if (v.kind !== "text") return null;
  return { ...textDefaults, name: v.name, readOnly: false, content: content || v.label };
}
