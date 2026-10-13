import { useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Copy, FileText, MoreHorizontal, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { TEMPLATE_DOC_TYPE_LABELS, TEMPLATE_DOC_TYPES, type TemplateDocType } from "@shared/documents";
import { Page } from "@/components/page";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  apiErrorMessage,
  type TemplateListItem,
  templatesQuery,
  useCreateTemplate,
  useDeleteTemplate,
  useSetDefaultTemplate,
} from "@/sdk";

const SECTION_TITLES: Record<TemplateDocType, string> = {
  offer: "Angebote",
  invoice: "Rechnungen",
  credit_note: "Gutschriften",
  reminder: "Mahnungen",
};

const dateFormatter = new Intl.DateTimeFormat("de-AT", { dateStyle: "medium" });

export function TemplatesPage() {
  const { data: templates } = useSuspenseQuery(templatesQuery);
  const [createOpen, setCreateOpen] = useState<{ docType: TemplateDocType; sourceId?: number; name: string } | null>(null);
  const [toDelete, setToDelete] = useState<TemplateListItem | null>(null);
  const setDefault = useSetDefaultTemplate();
  const remove = useDeleteTemplate();

  const onSetDefault = (t: TemplateListItem) =>
    setDefault.mutate(t.id, {
      onSuccess: () => toast.success(`„${t.name}“ ist jetzt Standard für ${SECTION_TITLES[t.docType]}`),
      onError: (err) => toast.error(apiErrorMessage(err)),
    });

  return (
    <Page
      title="PDF-Vorlagen"
      description="Layouts für Angebote, Rechnungen und Gutschriften. Die Standardvorlage wird verwendet, wenn ein Beleg keine eigene Vorlage hat."
      actions={
        <Button size="sm" onClick={() => setCreateOpen({ docType: "invoice", name: "" })}>
          <Plus /> Neue Vorlage
        </Button>
      }
    >
      <div className="space-y-8">
        {TEMPLATE_DOC_TYPES.map((docType) => {
          const rows = templates.filter((t) => t.docType === docType);
          return (
            <section key={docType}>
              <h2 className="mb-3 text-sm font-medium text-muted-foreground">{SECTION_TITLES[docType]}</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {rows.map((t) => (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    onDuplicate={() => setCreateOpen({ docType: t.docType, sourceId: t.id, name: `${t.name} (Kopie)` })}
                    onSetDefault={() => onSetDefault(t)}
                    onDelete={() => setToDelete(t)}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {createOpen && (
        <CreateTemplateDialog initial={createOpen} templates={templates} onClose={() => setCreateOpen(null)} />
      )}

      <AlertDialog open={!!toDelete} onOpenChange={(open) => !open && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Vorlage löschen?</AlertDialogTitle>
            <AlertDialogDescription>
              „{toDelete?.name}“ wird endgültig gelöscht. Belege, die diese Vorlage verwenden, nutzen danach die
              Standardvorlage. Bereits finalisierte PDFs bleiben unverändert.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                toDelete &&
                remove.mutate(toDelete.id, {
                  onSuccess: () => toast.success("Vorlage gelöscht"),
                  onError: (err) => toast.error(apiErrorMessage(err)),
                })
              }
            >
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

function TemplateCard({
  template: t,
  onDuplicate,
  onSetDefault,
  onDelete,
}: {
  template: TemplateListItem;
  onDuplicate: () => void;
  onSetDefault: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group relative flex flex-col overflow-hidden rounded-lg border bg-card transition-colors hover:border-foreground/20">
      <Link
        to="/templates/$id"
        params={{ id: t.id }}
        className="flex h-36 items-center justify-center bg-muted/40 transition-colors group-hover:bg-muted/70"
        aria-label={`${t.name} bearbeiten`}
      >
        <PagePreview letterhead={!!t.basePdfPath} />
      </Link>
      <div className="flex items-start justify-between gap-2 border-t p-3">
        <div className="min-w-0">
          <Link to="/templates/$id" params={{ id: t.id }} className="block truncate text-sm font-medium hover:underline">
            {t.name}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {t.isDefault && (
              <Badge variant="secondary" className="font-normal">
                <Star className="fill-current" /> Standard
              </Badge>
            )}
            {t.basePdfPath && (
              <Badge variant="outline" className="font-normal">
                Briefpapier
              </Badge>
            )}
            <span>Geändert {dateFormatter.format(new Date(t.updatedAt))}</span>
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label="Aktionen">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link to="/templates/$id" params={{ id: t.id }}>
                <Pencil /> Bearbeiten
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onDuplicate}>
              <Copy /> Duplizieren
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onSetDefault} disabled={t.isDefault}>
              <Star /> Als Standard festlegen
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete} disabled={t.isDefault}>
              <Trash2 /> Löschen
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/** Small stylised A4 page as card thumbnail. */
function PagePreview({ letterhead }: { letterhead: boolean }) {
  return (
    <div className="relative h-28 w-20 rounded-[3px] border bg-white p-2 shadow-sm">
      {letterhead && <div className="absolute inset-x-0 top-0 h-2 rounded-t-[3px] bg-primary/15" />}
      <div className="ml-auto h-1.5 w-5 rounded-sm bg-foreground/15" />
      <div className="mt-2 space-y-0.5">
        <div className="h-0.5 w-7 bg-foreground/20" />
        <div className="h-0.5 w-6 bg-foreground/20" />
        <div className="h-0.5 w-5 bg-foreground/20" />
      </div>
      <div className="mt-2 h-1 w-9 bg-foreground/40" />
      <div className="mt-1.5 space-y-[3px]">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex gap-1">
            <div className="h-0.5 flex-1 bg-foreground/15" />
            <div className="h-0.5 w-2 bg-foreground/15" />
          </div>
        ))}
      </div>
      <div className="mt-1.5 ml-auto h-0.5 w-6 bg-foreground/30" />
      <FileText className="absolute right-1.5 bottom-1.5 size-2.5 text-foreground/20" />
    </div>
  );
}

const DEFAULT_SOURCE = "default";

function CreateTemplateDialog({
  initial,
  templates,
  onClose,
}: {
  initial: { docType: TemplateDocType; sourceId?: number; name: string };
  templates: TemplateListItem[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const create = useCreateTemplate();
  const [name, setName] = useState(initial.name);
  const [docType, setDocType] = useState<TemplateDocType>(initial.docType);
  const [source, setSource] = useState(initial.sourceId ? String(initial.sourceId) : DEFAULT_SOURCE);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    create.mutate(
      { name: name.trim(), docType, sourceId: source === DEFAULT_SOURCE ? undefined : Number(source) },
      {
        onSuccess: (saved) => {
          onClose();
          navigate({ to: "/templates/$id", params: { id: saved.id } });
        },
        onError: (err) => toast.error(apiErrorMessage(err)),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{initial.sourceId ? "Vorlage duplizieren" : "Neue Vorlage"}</DialogTitle>
            <DialogDescription>Das Layout kann danach im Designer angepasst werden.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="template-name">Name</Label>
            <Input id="template-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Belegart</Label>
              <Select value={docType} onValueChange={(v) => setDocType(v as TemplateDocType)}>
                <SelectTrigger className="w-full">
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
            </div>
            <div className="space-y-2">
              <Label>Ausgangsbasis</Label>
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_SOURCE}>Standardlayout</SelectItem>
                  <SelectSeparator />
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Abbrechen
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              Erstellen
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
