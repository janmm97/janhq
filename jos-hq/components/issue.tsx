"use client";

import { useState } from "react";
import { apiGet, apiSend, useApi } from "@/lib/client/api";
import { Button, ErrorNote, Modal } from "./ui";

/** Statuses that offer Submit issue; the server checks the same list (lib/server/issues.ts). */
export const ISSUE_STATUSES = ["failed", "blocked"];

interface FiledIssue {
  number: number | null;
  url: string | null;
}
interface IssueState {
  enabled: boolean;
  repo: string | null;
  eligible: boolean;
  issue: FiledIssue | null;
}
interface Draft {
  repo: string;
  title: string;
  body: string;
}

function IssueLink({ issue }: { issue: FiledIssue }) {
  const label = issue.number ? `Issue #${issue.number} filed` : "Issue filed";
  return issue.url ? (
    <a href={issue.url} target="_blank" rel="noreferrer" data-testid="issue-link" className="text-[12px] text-silver-hi underline hover:text-paper">
      {label} ↗
    </a>
  ) : (
    <span data-testid="issue-link" className="text-[12px] text-silver-hi">
      {label}
    </span>
  );
}

/**
 * Submit issue for a failed or blocked task. HQ drafts a scrubbed report, the operator reads and may
 * edit it, and only File issue sends it to the public repository.
 */
export function SubmitIssue({ taskId, status, className }: { taskId: string; status: string | null | undefined; className?: string }) {
  const offered = !!status && ISSUE_STATUSES.includes(status);
  const { data, reload } = useApi<IssueState>(offered ? `/api/tasks/${taskId}/issue` : null, ["task_updated"]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(false);
  const [filing, setFiling] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  if (data?.issue) return <IssueLink issue={data.issue} />;
  if (!offered || !data?.enabled || !data.eligible) return null;

  const start = async () => {
    setOpen(true);
    setError(null);
    setLoading(true);
    try {
      setDraft((await apiGet<{ draft: Draft }>(`/api/tasks/${taskId}/issue/draft`)).draft);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
  };
  const file = async () => {
    if (!draft) return;
    setFiling(true);
    setError(null);
    try {
      await apiSend("POST", `/api/tasks/${taskId}/issue`, { title: draft.title, body: draft.body });
      setOpen(false);
      await reload();
    } catch (e) {
      setError(e as Error);
    } finally {
      setFiling(false);
    }
  };

  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void start()} data-testid="issue-submit">
          Submit issue
        </Button>
        <span className="text-[12px] text-silver">Report this to {data.repo}</span>
      </div>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Submit issue"
        wide
        testId="issue-dialog"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void file()} disabled={!draft || filing || !draft.title.trim()} data-testid="issue-file">
              {filing ? "Filing…" : "File issue"}
            </Button>
          </>
        }
      >
        {loading && <p className="text-[13px] text-silver">Documenting the task…</p>}
        {draft && (
          <div className="space-y-3">
            <p className="text-[12.5px] leading-[1.55] text-silver">
              This goes to <b className="text-paper">{draft.repo}</b>, a public repository. HQ has replaced people, companies, email addresses, connection names, IDs and local paths
              with placeholders. Read the request and error once more for anything else. Nothing is sent until you click File issue.
            </p>
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.14em] text-silver">Title</span>
              <input
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                data-testid="issue-title"
                className="h-9 w-full rounded-[4px] border border-rim-strong bg-ground px-2.5 text-[13px] text-paper focus:border-safe focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold uppercase tracking-[0.14em] text-silver">Body (Markdown)</span>
              <textarea
                value={draft.body}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                rows={18}
                data-testid="issue-body"
                className="block w-full resize-y rounded-[4px] border border-rim-strong bg-ground px-2.5 py-2 text-[12.5px] leading-[1.5] text-silver-hi focus:border-safe focus:outline-none"
              />
            </label>
          </div>
        )}
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      </Modal>
    </div>
  );
}
