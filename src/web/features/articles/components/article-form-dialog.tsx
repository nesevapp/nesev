import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatBp } from "@shared/money";
import {
  type ArticleCreate,
  type ArticleFormValues,
  articleCreateSchema,
  formatArticleNumber,
} from "@shared/schemas/article";
import { AT_TAX_RATES_BP, DEFAULT_TAX_RATE_BP } from "@shared/tax";
import { TextField, TextareaField } from "@/components/form-fields";
import { UnitSelect } from "@/components/unit-select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CODECS, NumericInput } from "@/features/documents/components/numeric-input";
import { apiErrorMessage, type Article, nextArticleNumberQuery, useCreateArticle, useUpdateArticle } from "@/sdk";

export const EMPTY_ARTICLE: ArticleFormValues = {
  title: "",
  description: "",
  unit: "",
  unitPriceCents: 0,
  taxRateBp: DEFAULT_TAX_RATE_BP,
  notes: "",
};

export function articleToFormValues(a: Article): ArticleFormValues {
  const { number, title, description, unit, unitPriceCents, taxRateBp, notes } = a;
  return { number, title, description, unit, unitPriceCents, taxRateBp, notes };
}

/**
 * Create or edit an article. `article` set = edit; otherwise create, prefilled from `defaults`
 * (e.g. a document line for "Als Artikel speichern"). Safe to render inside another <form>.
 */
export function ArticleFormDialog({
  open,
  onOpenChange,
  article,
  defaults,
  title,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  article?: Article | null;
  defaults?: Partial<ArticleFormValues>;
  title?: string;
  onSaved?: (article: Article) => void;
}) {
  const isEdit = !!article;
  const form = useForm<ArticleFormValues, unknown, ArticleCreate>({
    resolver: zodResolver(articleCreateSchema),
    defaultValues: EMPTY_ARTICLE,
  });
  const create = useCreateArticle();
  const update = useUpdateArticle();
  const nextNumber = useQuery({ ...nextArticleNumberQuery, enabled: open && !isEdit });

  useEffect(() => {
    if (!open) return;
    const values = article ? articleToFormValues(article) : { ...EMPTY_ARTICLE, ...defaults };
    // the select only offers the Austrian rates
    if (!(AT_TAX_RATES_BP as readonly number[]).includes(values.taxRateBp)) values.taxRateBp = DEFAULT_TAX_RATE_BP;
    form.reset(values);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when (re)opened
  }, [open, article?.id]);

  const onSubmit = (values: ArticleCreate) => {
    const done = {
      onSuccess: (saved: Article) => {
        toast.success(isEdit ? "Artikel gespeichert" : `Artikel ${formatArticleNumber(saved.number)} angelegt`);
        onSaved?.(saved);
        onOpenChange(false);
      },
      onError: (err: unknown) => toast.error(apiErrorMessage(err)),
    };
    if (article) update.mutate({ id: article.id, json: values }, done);
    else create.mutate(values, done);
  };
  const pending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title ?? (isEdit ? "Artikel bearbeiten" : "Neuer Artikel")}</DialogTitle>
          <DialogDescription>
            Werte werden beim Auswählen in die Position kopiert. Spätere Änderungen wirken sich nicht auf bestehende
            Belege aus.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            // the dialog is portaled, but React still bubbles submit to an enclosing document form
            onSubmit={(e) => {
              e.stopPropagation();
              void form.handleSubmit(onSubmit)(e);
            }}
            className="grid gap-4"
          >
            <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
              <TextField control={form.control} name="title" label="Bezeichnung" autoFocus autoComplete="off" />
              <FormField
                control={form.control}
                name="number"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nummer</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        inputMode="numeric"
                        className="tabular"
                        value={field.value ?? ""}
                        placeholder={nextNumber.data ? String(nextNumber.data.number) : "auto"}
                        onChange={(e) => {
                          const digits = e.target.value.replace(/\D/g, "");
                          field.onChange(digits ? Number(digits) : undefined);
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <TextareaField
              control={form.control}
              name="description"
              label="Beschreibung"
              rows={2}
              className="[&_textarea]:min-h-16"
            />
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField
                control={form.control}
                name="unit"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Einheit</FormLabel>
                    <UnitSelect value={field.value} onChange={field.onChange} onBlur={field.onBlur} aria-label="Einheit" />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="unitPriceCents"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Preis netto (€)</FormLabel>
                    <FormControl>
                      <NumericInput
                        ref={field.ref}
                        name={field.name}
                        value={field.value}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        codec={CODECS.money}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="taxRateBp"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>USt.-Satz</FormLabel>
                    <Select value={String(field.value)} onValueChange={(v) => field.onChange(Number(v))}>
                      <FormControl>
                        <SelectTrigger ref={field.ref} className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {AT_TAX_RATES_BP.map((bp) => (
                          <SelectItem key={bp} value={String(bp)}>
                            {formatBp(bp)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <TextareaField
              control={form.control}
              name="notes"
              label="Interne Notizen"
              rows={2}
              placeholder="Erscheint nicht auf Belegen"
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Abbrechen
              </Button>
              <Button type="submit" disabled={pending}>
                {isEdit ? "Speichern" : "Artikel anlegen"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
