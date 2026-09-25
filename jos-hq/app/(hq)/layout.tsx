import { AppShell } from "@/components/shell";

export default function HqLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
