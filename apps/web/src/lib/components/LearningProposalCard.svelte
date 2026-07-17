<script lang="ts">
// apps/web/src/lib/components/LearningProposalCard.svelte
// SIO-1126: HIL learning review gate -- the distilled LearningProposal with
// per-item approve/reject toggles (defaulting to approve). Approved items are
// written to the knowledge graph and agent memory on Apply.
import type { HilLearningReviewPrompt } from "$lib/stores/agent-reducer.ts";

let {
	prompt,
	disabled = false,
	onApply,
}: {
	prompt: HilLearningReviewPrompt;
	disabled?: boolean;
	onApply: (decisions: Record<string, "approve" | "reject">, edits: Record<string, Record<string, string>>) => void;
} = $props();

const proposal = $derived(prompt.proposal);

// SIO-1127: all four classes are now applied (root cause, bindings, heuristics,
// memory facts), so every item gets a decision entry and counts toward the approved total.
const itemIds = $derived(
	[
		...(prompt.proposal.rootCause ? [prompt.proposal.rootCause.id] : []),
		...prompt.proposal.bindings.map((b) => b.id),
		...prompt.proposal.heuristics.map((h) => h.id),
		...prompt.proposal.memoryFacts.map((f) => f.id),
	].filter((id) => id.length > 0),
);

let rejected = $state<Set<string>>(new Set());

// SIO-1128: local per-item text edits, keyed by id -> field -> value. Seeded lazily
// from the distiller value; only fields that differ from the original are emitted.
let edits = $state<Record<string, Record<string, string>>>({});

function editValue(id: string, field: string, original: string): string {
	return edits[id]?.[field] ?? original;
}

function setEdit(id: string, field: string, value: string) {
	edits = { ...edits, [id]: { ...(edits[id] ?? {}), [field]: value } };
}

// Emit only edits that (a) belong to an APPROVED item and (b) differ from the original.
function emittedEdits(): Record<string, Record<string, string>> {
	const out: Record<string, Record<string, string>> = {};
	for (const [id, fields] of Object.entries(edits)) {
		if (rejected.has(id)) continue;
		const changed: Record<string, string> = {};
		for (const [field, value] of Object.entries(fields)) {
			if (value.trim().length > 0) changed[field] = value;
		}
		if (Object.keys(changed).length > 0) out[id] = changed;
	}
	return out;
}

function toggle(id: string) {
	const next = new Set(rejected);
	if (next.has(id)) {
		next.delete(id);
	} else {
		next.add(id);
	}
	rejected = next;
}

function decisions(rejectAll: boolean): Record<string, "approve" | "reject"> {
	const out: Record<string, "approve" | "reject"> = {};
	for (const id of itemIds) {
		out[id] = rejectAll || rejected.has(id) ? "reject" : "approve";
	}
	return out;
}

const approvedCount = $derived(itemIds.filter((id) => !rejected.has(id)).length);
</script>

{#snippet itemToggle(id: string)}
  <button
    type="button"
    onclick={() => toggle(id)}
    {disabled}
    class="shrink-0 px-2 py-0.5 text-xs font-medium rounded border transition-colors disabled:opacity-50 {rejected.has(id)
      ? 'bg-white text-gray-500 border-gray-300'
      : 'bg-tommy-navy text-white border-tommy-navy'}"
  >
    {rejected.has(id) ? "Rejected" : "Approved"}
  </button>
{/snippet}

{#snippet evidence(quotes: string[])}
  <details class="mt-1">
    <summary class="text-xs text-gray-500 cursor-pointer">Evidence ({quotes.length})</summary>
    <ul class="mt-1 space-y-1">
      {#each quotes as quote}
        <li class="text-xs text-gray-600 italic border-l-2 border-tommy-accent-blue/40 pl-2">"{quote}"</li>
      {/each}
    </ul>
  </details>
{/snippet}

<div
  class="border-t border-tommy-accent-blue/40 bg-blue-50 px-4 py-3"
  role="dialog"
  aria-labelledby="hil-review-heading"
>
  <div class="max-w-4xl mx-auto">
    <h3 id="hil-review-heading" class="text-sm font-semibold text-tommy-navy">
      Learnings from {prompt.ticketKey}
    </h3>
    <p class="text-sm text-tommy-navy/80 mt-1">{prompt.message}</p>

    <!-- SIO-1130: the linkage is shown here even when the match gate auto-confirmed
         (single ticket-mention pin) or auto-created, so the human always sees which
         investigation the learnings attach to before applying. -->
    {#if prompt.matchCreated}
      <p class="mt-1 text-xs text-gray-600">
        <span class="font-semibold">Matched investigation:</span> none found -- a new incident record will be
        created from the ticket on apply.
      </p>
    {:else if prompt.matchedIncidentSummary}
      <p class="mt-1 text-xs text-gray-600">
        <span class="font-semibold">Matched investigation{prompt.autoMatched ? " (auto, via ticket reference)" : ""}:</span>
        {prompt.matchedIncidentSummary}
      </p>
    {/if}

    {#if prompt.alreadyLearned}
      <p class="mt-1 text-xs text-yellow-900 bg-yellow-50 border border-yellow-400/50 rounded px-2 py-1">
        This ticket was learned from before. Re-applying updates the knowledge graph (idempotent) but skips
        duplicate memory facts.
      </p>
    {/if}

    {#if proposal.rootCause}
      {@const rootCause = proposal.rootCause}
      <div class="mt-2 rounded border border-tommy-accent-blue/30 bg-white px-2 py-1.5">
        <div class="flex items-start justify-between gap-2">
          <div class="text-xs text-tommy-navy">
            <p class="font-semibold">Corrected root cause: {rootCause.causeClass}</p>
            <textarea
              class="mt-0.5 w-full rounded border border-tommy-accent-blue/30 bg-white px-2 py-1 text-xs text-tommy-navy"
              rows="2"
              {disabled}
              value={editValue(rootCause.id, "description", rootCause.description)}
              oninput={(e) => setEdit(rootCause.id, "description", e.currentTarget.value)}
            ></textarea>
            <p class="mt-0.5 font-semibold">Resolution:</p>
            <textarea
              class="mt-0.5 w-full rounded border border-tommy-accent-blue/30 bg-white px-2 py-1 text-xs text-tommy-navy"
              rows="2"
              {disabled}
              value={editValue(rootCause.id, "resolution", rootCause.resolution)}
              oninput={(e) => setEdit(rootCause.id, "resolution", e.currentTarget.value)}
            ></textarea>
            {#if rootCause.invalidatedHypotheses.length > 0}
              <p class="mt-0.5 font-semibold">Ruled out:</p>
              <ul class="list-disc list-inside">
                {#each rootCause.invalidatedHypotheses as hyp}
                  <li>{hyp.hypothesis} -- {hyp.reason}</li>
                {/each}
              </ul>
            {/if}
            {#if rootCause.runbookFilename}
              <p class="mt-0.5 text-gray-600">Links resolution to runbook {rootCause.runbookFilename}</p>
            {/if}
          </div>
          {@render itemToggle(rootCause.id)}
        </div>
        {@render evidence(rootCause.evidence)}
      </div>
    {/if}

    {#if proposal.memoryFacts.length > 0}
      <p class="mt-2 text-xs font-semibold text-tommy-navy">Durable memory facts</p>
      <div class="mt-1 space-y-1">
        {#each proposal.memoryFacts as fact (fact.id)}
          <div class="rounded border border-tommy-accent-blue/30 bg-white px-2 py-1.5">
            <div class="flex items-start justify-between gap-2">
              <textarea
                class="w-full rounded border border-tommy-accent-blue/30 bg-white px-2 py-1 text-xs text-tommy-navy"
                rows="2"
                {disabled}
                value={editValue(fact.id, "text", fact.text)}
                oninput={(e) => setEdit(fact.id, "text", e.currentTarget.value)}
              ></textarea>
              {@render itemToggle(fact.id)}
            </div>
            {@render evidence(fact.evidence)}
          </div>
        {/each}
      </div>
    {/if}

    {#if proposal.bindings.length > 0}
      <p class="mt-2 text-xs font-semibold text-tommy-navy">Telemetry binding corrections</p>
      <div class="mt-1 space-y-1">
        {#each proposal.bindings as binding (binding.id)}
          <div class="rounded border border-tommy-accent-blue/30 bg-white px-2 py-1.5">
            <div class="flex items-start justify-between gap-2">
              <div class="text-xs text-tommy-navy">
                <p>
                  <span class="font-semibold uppercase">{binding.action}</span>
                  {binding.service}
                  {binding.action === "invalidate" ? "!->" : "->"}
                  {binding.datasource}
                  {binding.bindingKind}=<span class="font-mono">{binding.resourceId}</span>
                </p>
                <textarea
                  class="mt-0.5 w-full rounded border border-tommy-accent-blue/30 bg-white px-2 py-1 text-xs text-tommy-navy"
                  rows="2"
                  {disabled}
                  value={editValue(binding.id, "reason", binding.reason)}
                  oninput={(e) => setEdit(binding.id, "reason", e.currentTarget.value)}
                ></textarea>
              </div>
              {@render itemToggle(binding.id)}
            </div>
            {@render evidence(binding.evidence)}
          </div>
        {/each}
      </div>
    {/if}

    {#if proposal.heuristics.length > 0}
      <p class="mt-2 text-xs font-semibold text-tommy-navy">Diagnostic heuristics (skill proposals)</p>
      <div class="mt-1 space-y-1">
        {#each proposal.heuristics as heuristic (heuristic.id)}
          <div class="rounded border border-tommy-accent-blue/30 bg-white px-2 py-1.5">
            <div class="flex items-start justify-between gap-2">
              <div class="text-xs text-tommy-navy">
                <p class="font-semibold">{heuristic.name}</p>
                <textarea
                  class="mt-0.5 w-full rounded border border-tommy-accent-blue/30 bg-white px-2 py-1 text-xs text-tommy-navy"
                  rows="2"
                  {disabled}
                  value={editValue(heuristic.id, "description", heuristic.description)}
                  oninput={(e) => setEdit(heuristic.id, "description", e.currentTarget.value)}
                ></textarea>
                <p class="mt-0.5 font-semibold">When to use:</p>
                <textarea
                  class="w-full rounded border border-tommy-accent-blue/30 bg-white px-2 py-1 text-xs text-tommy-navy"
                  rows="2"
                  {disabled}
                  value={editValue(heuristic.id, "whenToUse", heuristic.whenToUse)}
                  oninput={(e) => setEdit(heuristic.id, "whenToUse", e.currentTarget.value)}
                ></textarea>
                <p class="mt-0.5 font-semibold">Procedure:</p>
                <textarea
                  class="w-full rounded border border-tommy-accent-blue/30 bg-white px-2 py-1 text-xs text-tommy-navy"
                  rows="2"
                  {disabled}
                  value={editValue(heuristic.id, "procedure", heuristic.procedure)}
                  oninput={(e) => setEdit(heuristic.id, "procedure", e.currentTarget.value)}
                ></textarea>
              </div>
              {@render itemToggle(heuristic.id)}
            </div>
            {@render evidence(heuristic.evidence)}
          </div>
        {/each}
      </div>
    {/if}

    <div class="mt-3 flex gap-2 items-center">
      <button
        type="button"
        onclick={() => onApply(decisions(false), emittedEdits())}
        disabled={disabled || approvedCount === 0}
        class="px-3 py-1.5 text-sm font-medium bg-tommy-navy text-white rounded-md hover:bg-tommy-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Apply {approvedCount} approved item{approvedCount === 1 ? "" : "s"}
      </button>
      <button
        type="button"
        onclick={() => onApply(decisions(true), {})}
        {disabled}
        class="px-3 py-1.5 text-sm font-medium bg-white text-tommy-navy border border-tommy-navy rounded-md hover:bg-tommy-cream disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Reject all
      </button>
    </div>
  </div>
</div>
