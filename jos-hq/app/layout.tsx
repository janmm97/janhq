import type { Metadata } from "next";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource-variable/jetbrains-mono/wght-italic.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "J/OS HQ",
  description: "Command center for the J/OS Orchestrator and its One and Studio executors.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-ground text-paper antialiased">{children}</body>
    </html>
  );
}
