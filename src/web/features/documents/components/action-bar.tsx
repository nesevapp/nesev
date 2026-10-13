import type { ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api";
import { type DeriveKind, type DocumentDTO, useDeriveDocument } from "../api";
import { docLink } from "../config";

/** Sticky bottom bar (same look as the settings page save bar). */
export function ActionBar({ left, children }: { left?: ReactNode; children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-8 mt-8 flex flex-wrap items-center gap-2 border-t bg-background/90 px-8 py-3 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2">{left}</div>
      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

const DERIVE_TOASTS: Record<DeriveKind, string> = {
  "convert-to-invoice": "Rechnungsentwurf aus Angebot erstellt",
  "credit-note": "Gutschriftentwurf erstellt",
  duplicate: "Kopie als Entwurf erstellt",
};

/** Create a derived draft (invoice from offer, credit note, duplicate) and open it. */
export function useDeriveAndOpen() {
  const derive = useDeriveDocument();
  const navigate = useNavigate();
  return {
    isPending: derive.isPending,
    run: (doc: Pick<DocumentDTO, "id">, kind: DeriveKind) =>
      derive.mutate(
        { id: doc.id, kind },
        {
          onSuccess: (created) => {
            toast.success(DERIVE_TOASTS[kind]);
            navigate(docLink(created.type, created.id));
          },
          onError: (err) => toast.error(apiErrorMessage(err)),
        },
      ),
  };
}
