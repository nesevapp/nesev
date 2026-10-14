import { useNavigate } from "@tanstack/react-router";
import { Download, ExternalLink, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { ChatUiAction } from "@/sdk";
import { isFilePath } from "./markdown";

// UI actions of the assistant-only tools (open_in_app, open_pdf, download_pdf). A live tool_result runs its
// action once (use-chat-session); in the history the tool card shows a button instead.

/** Opens a URL in a new tab; when the popup blocker stops it (no user gesture during a stream), offers a toast button. */
export function openTab(url: string, label = "Öffnen") {
  const w = window.open(url, "_blank");
  if (w) {
    w.opener = null;
    return;
  }
  toast("Der Browser hat den neuen Tab blockiert.", {
    action: { label, onClick: () => window.open(url, "_blank", "noopener") },
    duration: 10_000,
  });
}

/** Downloads a same-origin file (/api/…) through an anchor with a download attribute. */
export function downloadFile(url: string, fileName: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
}

/** In-app paths navigate with the router (no reload, the panel stays open); /api/… files open in a new tab. */
export function useOpenPath() {
  const navigate = useNavigate();
  return (path: string) => (isFilePath(path) ? openTab(path) : void navigate({ href: path }));
}

export function useRunUiAction() {
  const navigate = useNavigate();
  return (action: ChatUiAction) => {
    switch (action.kind) {
      case "navigate":
        void navigate({ href: action.path });
        return;
      case "download":
        downloadFile(action.url, action.fileName);
        return;
      case "open_tab":
        openTab(action.url, action.label || "Öffnen");
        return;
    }
  };
}

/** Button to repeat an action from the history ("Erneut öffnen" / "Herunterladen"). */
export function ActionButton({ action }: { action: ChatUiAction }) {
  const run = useRunUiAction();
  const download = action.kind === "download";
  const Icon = download ? Download : action.kind === "open_tab" ? ExternalLink : RotateCcw;
  return (
    <Button variant="outline" size="xs" onClick={() => run(action)} title={action.label}>
      <Icon />
      {download ? "Herunterladen" : "Erneut öffnen"}
    </Button>
  );
}
