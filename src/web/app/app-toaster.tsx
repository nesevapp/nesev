import { Toaster } from "@/components/ui/sonner";
import { FAB_BOTTOM, FAB_SIZE, useChatFabShown } from "@/features/chat/chat-fab";
import { useChatUi } from "@/features/chat/chat-store";
import { useTheme } from "./theme";

// Toasts sit bottom-right, but above the sticky save/action bars (~64px), so they never cover "Speichern", above the
// floating assistant button while it shows, and left of the assistant panel (420px) while it is open, so they don't
// cover its composer or a confirm card.

const GAP = 16;
const BAR = 64;
const CHAT_PANEL = 420;

export function AppToaster() {
  const { open } = useChatUi();
  const fab = useChatFabShown();
  const { resolved } = useTheme();
  const bottom = fab ? FAB_BOTTOM + FAB_SIZE + 12 : BAR + GAP;
  return <Toaster theme={resolved} position="bottom-right" offset={{ bottom, right: (open ? CHAT_PANEL : 0) + GAP }} />;
}
