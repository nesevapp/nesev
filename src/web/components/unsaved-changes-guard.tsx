import { type ShouldBlockFn, useBlocker } from "@tanstack/react-router";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * Asks before leaving a page with unsaved edits: in-app navigation shows a styled dialog ("Verwerfen" / "Weiter
 * bearbeiten"), closing or reloading the tab gets the browser's own prompt. `shouldBlock` decides per navigation
 * (e.g. tab switches that stay on the page, or a save that navigates away on purpose).
 */
export function UnsavedChangesGuard({ when, shouldBlock }: { when: boolean; shouldBlock?: ShouldBlockFn }) {
  const blocker = useBlocker({
    shouldBlockFn: (args) => when && (shouldBlock ? shouldBlock(args) : true),
    enableBeforeUnload: () => when,
    withResolver: true,
  });
  const open = blocker.status === "blocked";
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && blocker.reset?.()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Ungespeicherte Änderungen verwerfen?</AlertDialogTitle>
          <AlertDialogDescription>
            Ihre Änderungen auf dieser Seite sind noch nicht gespeichert und gehen beim Verlassen verloren.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Weiter bearbeiten</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => blocker.proceed?.()}>
            Verwerfen
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
