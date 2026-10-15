import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertCircle, FileCode2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { apiErrorMessage, finanzOnlineCheckQuery, taxXmlUrls } from "@/sdk";

/** "XML für FinanzOnline": checks the period first, then offers the upload file with a hint. */
export function FinanzOnlineButton({ kind, period, euIn021 = false }: { kind: "uva" | "zm"; period: string; euIn021?: boolean }) {
  const [open, setOpen] = useState(false);
  const check = useQuery({ ...finanzOnlineCheckQuery(kind, period, euIn021), enabled: open });
  const href = kind === "uva" ? taxXmlUrls.uva(period, euIn021) : taxXmlUrls.zm(period);
  const data = check.data;
  const label = kind === "uva" ? "UVA" : "ZM";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <FileCode2 /> XML für FinanzOnline
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 space-y-3 text-sm">
        <div className="font-medium">{label}-Datei für FinanzOnline</div>
        {check.isPending ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Wird geprüft …
          </p>
        ) : check.isError ? (
          <p className="text-destructive">{apiErrorMessage(check.error)}</p>
        ) : data && data.errors.length > 0 ? (
          <div className="space-y-2">
            <p className="text-muted-foreground">Die Datei kann so nicht erstellt werden:</p>
            <ul className="space-y-1.5">
              {data.errors.map((e) => (
                <li key={e} className="flex gap-2 text-red-700">
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                  <span>{e}</span>
                </li>
              ))}
            </ul>
            {(data.fastnr == null || data.errors.some((e) => e.includes("Einstellungen"))) && (
              <Link to="/settings" search={{ tab: "unternehmen" }} className="inline-block text-xs underline underline-offset-2">
                Einstellungen öffnen
              </Link>
            )}
          </div>
        ) : (
          data && (
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                In FinanzOnline unter <span className="text-foreground">Eingaben → Übermittlungen → Datei-Upload</span> selbst
                hochladen (Steuernummer {data.fastnr}). Vor dem Absenden die Werte im Protokoll mit dieser Seite vergleichen — die
                Datei ist eine Hilfe, keine Steuerberatung.
                {kind === "uva" && " Die Steuer je Kennzahl und die Zahllast berechnet FinanzOnline selbst."}
                {kind === "zm" && " Beträge in ganzen Euro (kaufmännisch gerundet)."}
              </p>
              {data.warnings.length > 0 && (
                <ul className="space-y-1 text-xs text-amber-800">
                  {data.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              <Button size="sm" asChild>
                <a href={href} download={data.fileName} onClick={() => setOpen(false)}>
                  <FileCode2 /> {data.fileName}
                </a>
              </Button>
            </div>
          )
        )}
      </PopoverContent>
    </Popover>
  );
}
