import type { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Plain download link styled as a button (the browser handles the attachment). */
export function DownloadButton({
  href,
  disabled,
  icon: Icon,
  variant = "default",
  children,
}: {
  href: string;
  disabled?: boolean;
  icon: typeof Download;
  variant?: "default" | "outline";
  children: React.ReactNode;
}) {
  if (disabled) {
    return (
      <Button variant={variant} disabled>
        <Icon /> {children}
      </Button>
    );
  }
  return (
    <Button variant={variant} asChild>
      <a href={href} download>
        <Icon /> {children}
      </a>
    </Button>
  );
}
