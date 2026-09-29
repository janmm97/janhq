"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AgentStations } from "@/components/agent-form";

function NewAgentInner() {
  const params = useSearchParams();
  const ws = params.get("workspace") === "Studio" ? "Studio" : "One";
  return <AgentStations key={ws} workspace={ws} />;
}

export default function NewAgentPage() {
  return (
    <Suspense fallback={null}>
      <NewAgentInner />
    </Suspense>
  );
}
