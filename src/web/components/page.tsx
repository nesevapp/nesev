import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Standard page wrapper: header row (title, description, actions) + content. */
export function Page({
  title,
  description,
  actions,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-6xl px-8 py-8", className)}>
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export function PlaceholderPage({ title, milestone }: { title: string; milestone: string }) {
  return (
    <Page title={title}>
      <div className="rounded-lg border border-dashed p-12 text-center text-sm text-muted-foreground">
        Noch nicht implementiert ({milestone}).
      </div>
    </Page>
  );
}
