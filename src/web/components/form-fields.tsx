import type { ReactNode } from "react";
import type { Control, FieldPath, FieldValues } from "react-hook-form";
import { FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

// Thin wrappers around shadcn <FormField> for the common cases. Use inside <Form {...form}>.

interface BaseProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: ReactNode;
  description?: ReactNode;
  className?: string;
}

export function TextField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  className,
  ...input
}: BaseProps<T> & Omit<React.ComponentProps<typeof Input>, "name">) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input {...input} {...field} value={field.value ?? ""} />
          </FormControl>
          {description && <FormDescription>{description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/** Integer input; empty → null. */
export function NumberField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  className,
  suffix,
  ...input
}: BaseProps<T> & { suffix?: ReactNode } & Omit<React.ComponentProps<typeof Input>, "name" | "type">) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <div className="relative">
            <FormControl>
              <Input
                type="number"
                inputMode="numeric"
                {...input}
                {...field}
                className={cn(suffix && "pr-12", "tabular")}
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.target.value === "" ? null : Number(e.target.value))}
              />
            </FormControl>
            {suffix && (
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
                {suffix}
              </span>
            )}
          </div>
          {description && <FormDescription>{description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function TextareaField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  className,
  ...input
}: BaseProps<T> & Omit<React.ComponentProps<typeof Textarea>, "name">) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Textarea {...input} {...field} value={field.value ?? ""} />
          </FormControl>
          {description && <FormDescription>{description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

export function SwitchField<T extends FieldValues>({ control, name, label, description, className }: BaseProps<T>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={cn("flex items-start justify-between gap-6 rounded-lg border p-4", className)}>
          <div className="space-y-1">
            <FormLabel>{label}</FormLabel>
            {description && <FormDescription>{description}</FormDescription>}
          </div>
          <FormControl>
            <Switch checked={!!field.value} onCheckedChange={field.onChange} />
          </FormControl>
        </FormItem>
      )}
    />
  );
}

/** Titled section used on settings/detail forms. */
export function FormSection({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-x-10 gap-y-4 border-b py-8 first:pt-0 last:border-b-0 md:grid-cols-[220px_1fr]">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      <div className="grid gap-4">{children}</div>
    </section>
  );
}
