import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { setupStatusQuery } from "@/sdk";
import { SetupPage } from "./setup-page";

/**
 * Renders the app once nesev has a data folder, else the first-start setup. If the status can't be loaded (older
 * server, network hiccup) the app renders as before and shows its own errors.
 */
export function SetupGate({ children }: { children: ReactNode }) {
  const { data, isPending } = useQuery(setupStatusQuery);
  if (isPending) return null;
  if (data && !data.configured) return <SetupPage status={data} />;
  return children;
}
