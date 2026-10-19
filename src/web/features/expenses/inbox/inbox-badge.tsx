import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { inboxCountQuery } from "@/sdk";

/** Count of new inbox items next to "Ausgaben" in the sidebar (nothing when empty). */
export function InboxNavBadge() {
  const { data } = useQuery(inboxCountQuery);
  if (!data?.count) return null;
  return (
    <span
      className="ml-auto rounded-full bg-primary px-1.5 text-[11px] font-medium leading-[18px] text-primary-foreground tabular"
      title={`${data.count} im Belege-Eingang`}
    >
      {data.count}
    </span>
  );
}

/** "Belege-Eingang (n)" button for the expenses page header. */
export function InboxButton() {
  const { data } = useQuery(inboxCountQuery);
  const count = data?.count ?? 0;
  return (
    <Button asChild variant="outline" size="sm">
      <Link to="/expenses/inbox">
        <Inbox />
        Belege-Eingang
        {count > 0 && (
          <span className="rounded-full bg-primary px-1.5 text-[11px] font-medium leading-[18px] text-primary-foreground tabular">
            {count}
          </span>
        )}
      </Link>
    </Button>
  );
}
