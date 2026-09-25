"use client";

import { use } from "react";
import { useApi } from "@/lib/client/api";
import { PageHeader } from "@/components/shell";
import { AgentStations, type AgentAnswersView } from "@/components/agent-form";
import { ButtonLink, EmptyState, ErrorNote } from "@/components/ui";

type EditState = { hash: string } & ({ editable: true; answers: AgentAnswersView } | { editable: false; reason: string });

export default function EditAgentPage({ params }: { params: Promise<{ workspace: string; agent: string }> }) {
  const { workspace, agent } = use(params);
  const ws = workspace === "Studio" ? "Studio" : "One";
  const key = decodeURIComponent(agent);
  // Read once: the answers and hash are the file as it was when the page opened, so a save is never stale.
  const { data, error } = useApi<{ edit: EditState }>(`/api/agents/${ws}/${encodeURIComponent(key)}`);
  if (!data) {
    return (
      <>
        <PageHeader code="J2" title={`Edit ${key}`} />
        {error ? <ErrorNote error={error} /> : <p className="text-[13px] text-silver">Reading {key}…</p>}
      </>
    );
  }
  if (!data.edit.editable) {
    return (
      <>
        <PageHeader code="J2" title={`Edit ${key}`} />
        <EmptyState title="HQ only reads this agent." body={data.edit.reason} action={<ButtonLink href={`/agents?ws=${ws}&agent=${encodeURIComponent(key)}`}>Back to the agent</ButtonLink>} />
      </>
    );
  }
  return <AgentStations workspace={ws} edit={{ key, answers: data.edit.answers, hash: data.edit.hash }} />;
}
