import { AppShell } from "@/components/shell";
import { AccessGate } from "@/lib/server/page-gate";

// The gate reads the request's cookie: never prerender or cache it.
export const dynamic = "force-dynamic";

export default function HqLayout({ children }: { children: React.ReactNode }) {
  return (
    <AccessGate>
      <AppShell>{children}</AppShell>
    </AccessGate>
  );
}
