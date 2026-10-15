import { useEffect } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  annualAfaCents,
  assetSchedule,
  CAR_MIN_USEFUL_LIFE_YEARS,
  formatAssetNumber,
  GWG_LIMIT_CENTS,
  isFirstHalf,
  USEFUL_LIFE_SUGGESTIONS,
} from "@shared/assets";
import { todayIso } from "@shared/dates";
import { formatCents } from "@shared/money";
import { type AssetCreate, type AssetFormValues, assetCreateSchema } from "@shared/schemas/asset";
import { TextField, TextareaField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CODECS, NumericInput } from "@/features/documents/components/numeric-input";
import { apiErrorMessage, type Asset, nextAssetNumberQuery, useCreateAsset, useUpdateAsset } from "@/sdk";
import { ScheduleTable } from "./schedule-table";

export function emptyAssetValues(): AssetFormValues {
  const today = todayIso();
  return { name: "", expenseId: null, acquisitionDate: today, inServiceDate: today, costCents: 0, usefulLifeYears: 3, notes: "" };
}

function assetToFormValues(a: Asset): AssetFormValues {
  const { number, name, expenseId, acquisitionDate, inServiceDate, costCents, usefulLifeYears, notes } = a;
  return { number, name, expenseId, acquisitionDate, inServiceDate, costCents, usefulLifeYears, notes };
}

/**
 * Create or edit an asset with a live AfA preview. `asset` set = edit; otherwise create, prefilled from
 * `defaults` (e.g. an expense's "anlagen" lines). `source` labels where the prefill came from.
 */
export function AssetFormDialog({
  open,
  onOpenChange,
  asset,
  defaults,
  source,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset?: Asset | null;
  defaults?: Partial<AssetFormValues>;
  source?: string;
  onSaved?: (asset: Asset) => void;
}) {
  const isEdit = !!asset;
  const form = useForm<AssetFormValues, unknown, AssetCreate>({
    resolver: zodResolver(assetCreateSchema),
    defaultValues: emptyAssetValues(),
  });
  const create = useCreateAsset();
  const update = useUpdateAsset();
  const nextNumber = useQuery({ ...nextAssetNumberQuery, enabled: open && !isEdit });

  useEffect(() => {
    if (!open) return;
    form.reset(asset ? assetToFormValues(asset) : { ...emptyAssetValues(), ...defaults });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when (re)opened
  }, [open, asset?.id]);

  const [costCents, usefulLifeYears, inServiceDate] = useWatch({ control: form.control, name: ["costCents", "usefulLifeYears", "inServiceDate"] });
  const life = Number(usefulLifeYears) || 0;
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(inServiceDate ?? "");
  const schedule =
    validDate && life >= 1 && life <= 50 && costCents > 0
      ? assetSchedule({ costCents, usefulLifeYears: life, inServiceDate, disposalDate: asset?.disposalDate })
      : [];

  const onSubmit = (values: AssetCreate) => {
    const done = {
      onSuccess: (saved: Asset) => {
        toast.success(isEdit ? "Anlage gespeichert" : `Anlage ${formatAssetNumber(saved.number)} angelegt`);
        onSaved?.(saved);
        onOpenChange(false);
      },
      onError: (err: unknown) => toast.error(apiErrorMessage(err)),
    };
    if (asset) update.mutate({ id: asset.id, json: { ...values, expenseId: values.expenseId ?? null, notes: values.notes ?? "" } }, done);
    else create.mutate(values, done);
  };
  const pending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Anlage ${formatAssetNumber(asset.number)} bearbeiten` : "Neue Anlage"}</DialogTitle>
          <DialogDescription>
            {source ? `${source}. ` : ""}Lineare AfA über die Nutzungsdauer; Inbetriebnahme bis 30.6. volle, danach halbe Jahres-AfA.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            // the dialog is portaled, but React still bubbles submit to an enclosing form (expense editor)
            onSubmit={(e) => {
              e.stopPropagation();
              void form.handleSubmit(onSubmit)(e);
            }}
            className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]"
          >
            <div className="grid content-start gap-4">
              <div className="grid gap-4 sm:grid-cols-[1fr_110px]">
                <TextField control={form.control} name="name" label="Bezeichnung" autoFocus autoComplete="off" />
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
              <div className="grid gap-4 sm:grid-cols-2">
                <DateField form={form} name="acquisitionDate" label="Anschaffung" />
                <DateField form={form} name="inServiceDate" label="Inbetriebnahme" />
              </div>
              <FormField
                control={form.control}
                name="costCents"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Anschaffungskosten (€)</FormLabel>
                    <FormControl>
                      <NumericInput ref={field.ref} name={field.name} value={field.value} onChange={field.onChange} onBlur={field.onBlur} codec={CODECS.money} min={0} />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">Netto zuzüglich nicht abziehbarer Vorsteuer.</p>
                    {costCents > 0 && costCents <= GWG_LIMIT_CENTS && (
                      <p className="text-xs text-warning">
                        Bis {formatCents(GWG_LIMIT_CENTS)} als geringwertiges Wirtschaftsgut sofort absetzbar (Kategorie „Hardware / GWG“) — AfA optional.
                      </p>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="usefulLifeYears"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nutzungsdauer (Jahre)</FormLabel>
                    <div className="flex gap-2">
                      <FormControl>
                        <Input
                          ref={field.ref}
                          name={field.name}
                          type="number"
                          min={1}
                          max={50}
                          className="w-24 tabular"
                          value={field.value ?? ""}
                          onBlur={field.onBlur}
                          onChange={(e) => field.onChange(e.target.value === "" ? undefined : Number(e.target.value))}
                        />
                      </FormControl>
                      <Select
                        value=""
                        onValueChange={(key) => {
                          const s = USEFUL_LIFE_SUGGESTIONS.find((x) => x.key === key);
                          if (s) form.setValue("usefulLifeYears", s.years, { shouldDirty: true, shouldValidate: true });
                        }}
                      >
                        <SelectTrigger className="flex-1" aria-label="Vorschlag für die Nutzungsdauer">
                          <SelectValue placeholder="Vorschlag …" />
                        </SelectTrigger>
                        <SelectContent>
                          {USEFUL_LIFE_SUGGESTIONS.map((s) => (
                            <SelectItem key={s.key} value={s.key}>
                              {s.label}: {s.years} Jahre
                              {"hint" in s ? <span className="text-muted-foreground"> ({s.hint})</span> : null}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Vorschläge, keine verbindlichen Werte. PKW: mindestens {CAR_MIN_USEFUL_LIFE_YEARS} Jahre (§ 8 Abs. 6 EStG).
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <TextareaField control={form.control} name="notes" label="Notizen" rows={2} placeholder="z. B. Seriennummer, Standort" />
            </div>

            <div className="min-w-0">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium">AfA-Plan (Vorschau)</h3>
                {schedule.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {formatCents(annualAfaCents({ costCents, usefulLifeYears: life }))} / Jahr
                    {validDate && !isFirstHalf(inServiceDate) ? " · Halbjahres-AfA im 1. Jahr" : ""}
                  </span>
                )}
              </div>
              <div className="rounded-lg border">
                <ScheduleTable rows={schedule} compact />
              </div>
            </div>

            <DialogFooter className="md:col-span-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Abbrechen
              </Button>
              <Button type="submit" disabled={pending}>
                {isEdit ? "Speichern" : "Anlage anlegen"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function DateField({
  form,
  name,
  label,
}: {
  form: ReturnType<typeof useForm<AssetFormValues, unknown, AssetCreate>>;
  name: "acquisitionDate" | "inServiceDate";
  label: string;
}) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type="date"
              {...field}
              className="tabular"
              onChange={(e) => {
                field.onChange(e.target.value);
                // Inbetriebnahme follows the acquisition date until set apart
                if (name === "acquisitionDate" && form.getValues("inServiceDate") < e.target.value) form.setValue("inServiceDate", e.target.value);
              }}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
