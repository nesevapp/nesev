import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { modKey } from "@/features/search/kbd";
import { useDocumentTitle } from "./document-title";

/** Fallback for unknown paths (rootRoute.notFoundComponent). */
export function NotFoundPage() {
  useDocumentTitle("Seite nicht gefunden");
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-start px-4 py-16 sm:px-8">
      <p className="text-sm font-medium text-muted-foreground tabular">404</p>
      <h1 className="mt-1 text-xl font-semibold tracking-tight">Seite nicht gefunden</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Diese Adresse gibt es in nesev nicht, oder der Eintrag wurde gelöscht. Über die Navigation oder die Suche ({modKey} K)
        findest du zurück.
      </p>
      <Button asChild className="mt-6" size="sm">
        <Link to="/">
          <ArrowLeft />
          Zum Dashboard
        </Link>
      </Button>
    </div>
  );
}
