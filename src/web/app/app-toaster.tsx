import { Toaster } from "@/components/ui/sonner";
import { useChatUi } from "@/features/chat/chat-store";

// Toasts sit bottom-right, but above the sticky save/action bars (~64px), so they never cover "Speichern", and left of
// the assistant panel (420px) while it is open, so they don't cover its composer or a confirm card.

const GAP = 16;
const BAR = 64;
const CHAT_PANEL = 420;

export function AppToaster() {
  const { open } = useChatUi();
  return <Toaster position="bottom-right" offset={{ bottom: BAR + GAP, right: (open ? CHAT_PANEL : 0) + GAP }} />;
}
