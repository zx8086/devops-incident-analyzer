<script lang="ts">
// apps/web/src/lib/components/LearningReviewPane.svelte
// SIO-1891: the human gate over learning candidates, beside the chat. Lists an
// agent's candidates (latest state per skill), lets the reviewer edit title and
// body, then approve (opens the promotion PR; merge is the only activation),
// reject, or supersede. Candidate text is agent-authored: rendered as text,
// never executed, never fed to a model from here.
import type { AgentId } from "$lib/agent-ids";
import {
	applyReviewResponse,
	canApprove,
	describeTaskSuccess,
	isTerminal,
	type ReviewResponse,
	type ReviewRowView,
} from "$lib/learning-review-pane";
import Icon from "./Icon.svelte";

let {
	agent,
	initialRows = null,
}: {
	agent: AgentId;
	// Test seam: rows to render without fetching (SSR shape checks).
	initialRows?: ReviewRowView[] | null;
} = $props();

// The initial value is all a test render supplies; live renders fetch in the effect below.
// svelte-ignore state_referenced_locally
let rows = $state<ReviewRowView[]>(initialRows ?? []);
let loading = $state(false);
let error = $state<string | null>(null);
let expanded = $state<string | null>(null);
let busy = $state<string | null>(null);
let editTitle = $state("");
let editBody = $state("");
let supersedeBy = $state("");
// Greptile PR #919: switching agents starts a new load; a slower earlier one
// must not replace the rows under the new heading.
let loadToken = 0;

async function load() {
	const token = ++loadToken;
	loading = true;
	error = null;
	try {
		const res = await fetch(`/api/agent/memory/candidates?agent=${encodeURIComponent(agent)}`);
		if (token !== loadToken) return;
		if (!res.ok) {
			error =
				res.status === 404 ? "Learning review is disabled in this deployment." : `Failed to load (${res.status}).`;
			rows = [];
			return;
		}
		const body = (await res.json()) as { candidates: ReviewRowView[] };
		if (token !== loadToken) return;
		rows = body.candidates;
	} catch {
		if (token === loadToken) error = "Failed to load candidates.";
	} finally {
		if (token === loadToken) loading = false;
	}
}

function toggle(row: ReviewRowView) {
	if (expanded === row.skillName) {
		expanded = null;
		return;
	}
	expanded = row.skillName;
	editTitle = row.title;
	editBody = row.body;
	supersedeBy = "";
}

async function act(row: ReviewRowView, action: "approve" | "reject" | "supersede") {
	busy = row.skillName;
	try {
		// kind disambiguates a skill and a runbook of one name; expectedStatus is the
		// status this row showed, so a decision stored since is refused, not stacked.
		const payload: Record<string, unknown> = {
			agent,
			skillName: row.skillName,
			kind: row.kind === "runbook" ? "runbook" : "skill",
			expectedStatus: row.status,
			action,
		};
		if (action === "approve") payload.edits = { title: editTitle, body: editBody };
		if (action === "supersede") payload.supersedes = supersedeBy.trim();
		const res = await fetch("/api/agent/memory/candidates", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
		const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		const reply: ReviewResponse = res.ok
			? (data as Extract<ReviewResponse, { ok: true }>)
			: { ok: false, httpStatus: res.status, error: String(data.error ?? res.statusText) };
		rows = applyReviewResponse(rows, row.skillName, reply);
	} catch {
		rows = applyReviewResponse(rows, row.skillName, { ok: false, httpStatus: 0, error: "request failed" });
	} finally {
		busy = null;
	}
}

// Refetch when the agent changes; a test render supplies rows and never fetches.
$effect(() => {
	void agent;
	if (initialRows === null) void load();
});

const STATUS_CLASS: Record<ReviewRowView["status"], string> = {
	candidate: "bg-amber-100 text-amber-800",
	approved: "bg-green-100 text-green-800",
	rejected: "bg-gray-200 text-gray-700",
	superseded: "bg-gray-200 text-gray-700",
};
</script>

<section class="flex h-full flex-col" aria-label="Learning review">
  <header class="flex items-center justify-between border-b border-gray-200 px-4 py-3">
    <div>
      <h2 class="text-sm font-semibold text-gray-900">Learning review</h2>
      <p class="text-xs text-gray-500">{agent}: candidates awaiting a human decision</p>
    </div>
    <button
      type="button"
      onclick={() => load()}
      disabled={loading}
      class="rounded-lg p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-900 disabled:opacity-50"
      aria-label="Reload candidates"
      title="Reload"
    >
      <Icon name="refresh" class="h-4 w-4" />
    </button>
  </header>

  <div class="flex-1 overflow-y-auto px-4 py-3">
    {#if error}
      <p class="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>
    {:else if loading && rows.length === 0}
      <p class="text-sm text-gray-500">Loading candidates...</p>
    {:else if rows.length === 0}
      <p class="text-sm text-gray-500">No learning candidates for this agent yet.</p>
    {:else}
      <ul class="space-y-2">
        {#each rows as row (`${row.kind}:${row.skillName}`)}
          <li class="rounded-lg border border-gray-200">
            <button
              type="button"
              onclick={() => toggle(row)}
              aria-expanded={expanded === row.skillName}
              class="flex w-full items-start justify-between gap-3 px-3 py-2 text-left hover:bg-gray-50"
            >
              <span class="min-w-0">
                <span class="block truncate text-sm font-medium text-gray-900">{row.skillName}</span>
                <span class="block truncate text-xs text-gray-600">{row.title}</span>
                <span class="mt-1 flex flex-wrap gap-1 text-[11px]">
                  <span class="rounded px-1.5 py-0.5 {STATUS_CLASS[row.status]}">{row.status}</span>
                  <span class="rounded bg-gray-100 px-1.5 py-0.5 text-gray-700">{row.kind} / {row.source}</span>
                  <span class="rounded px-1.5 py-0.5 {row.taskSuccess === '1' ? 'bg-green-50 text-green-800' : row.taskSuccess === '0' ? 'bg-red-50 text-red-800' : 'bg-gray-100 text-gray-600'}">
                    {describeTaskSuccess(row)}
                  </span>
                  <span class="rounded bg-gray-100 px-1.5 py-0.5 text-gray-700">{row.evidence.length} evidence</span>
                </span>
              </span>
              <Icon name={expanded === row.skillName ? "collapse" : "expand"} class="mt-1 h-4 w-4 shrink-0 text-gray-400" />
            </button>

            {#if expanded === row.skillName}
              <div class="space-y-3 border-t border-gray-100 px-3 py-3">
                <p class="text-xs text-gray-500">learned {row.learnedAt} from {row.learnedFrom}; confidence {row.confidence || "n/a"}</p>
                <label class="block text-xs font-medium text-gray-700">
                  Title
                  <input
                    type="text"
                    bind:value={editTitle}
                    disabled={isTerminal(row) || row.status === "approved"}
                    class="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-50"
                  />
                </label>
                {#if row.whenToUse}
                  <p class="text-xs text-gray-700"><span class="font-medium">When to use:</span> {row.whenToUse}</p>
                {/if}
                <label class="block text-xs font-medium text-gray-700">
                  Body
                  <textarea
                    bind:value={editBody}
                    rows="5"
                    disabled={isTerminal(row) || row.status === "approved"}
                    class="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm disabled:bg-gray-50"
                  ></textarea>
                </label>
                {#if row.evidence.length > 0}
                  <div>
                    <p class="text-xs font-medium text-gray-700">Evidence (verbatim from the session)</p>
                    <ul class="mt-1 list-disc space-y-0.5 pl-5 text-xs text-gray-700">
                      {#each row.evidence as quote, i (i)}
                        <li>{quote}</li>
                      {/each}
                    </ul>
                  </div>
                {/if}
                {#if row.message}
                  <p class="rounded bg-blue-50 px-2 py-1 text-xs text-blue-900">{row.message}</p>
                {/if}
                {#if !isTerminal(row)}
                  <div class="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onclick={() => act(row, "approve")}
                      disabled={busy === row.skillName || !canApprove(row)}
                      title={canApprove(row) ? "Approve and open the promotion PR" : "Needs a confirmed task_success (thumbs-up or a completed outcome)"}
                      class="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Approve
                    </button>
                    {#if row.status !== "approved"}
                      <button
                        type="button"
                        onclick={() => act(row, "reject")}
                        disabled={busy === row.skillName}
                        class="rounded bg-gray-700 px-3 py-1 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-40"
                      >
                        Reject
                      </button>
                    {/if}
                    <input
                      type="text"
                      bind:value={supersedeBy}
                      placeholder="superseded by (skill name)"
                      class="w-44 rounded border border-gray-300 px-2 py-1 text-xs"
                      aria-label="Superseding candidate"
                    />
                    <button
                      type="button"
                      onclick={() => act(row, "supersede")}
                      disabled={busy === row.skillName || supersedeBy.trim() === ""}
                      class="rounded border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-40"
                    >
                      Supersede
                    </button>
                  </div>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>
