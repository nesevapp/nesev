import type { UseNavigateResult } from "@tanstack/react-router";
import { toast } from "sonner";
import { SELLER_MISSING_PREFIX } from "@shared/seller";

/** Error toast for a refused finalize; missing seller details (shared/seller.ts) get a link to Einstellungen. */
export function toastFinalizeError(message: string, navigate: UseNavigateResult<string>) {
  toast.error(
    message,
    message.startsWith(SELLER_MISSING_PREFIX)
      ? { action: { label: "Einstellungen öffnen", onClick: () => void navigate({ to: "/settings" }) }, duration: 10_000 }
      : undefined,
  );
}
