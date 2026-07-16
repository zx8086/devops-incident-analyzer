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
	onApply: (decisions: Record<string, "approve" | "reject">) => void;
} = $props();

const proposal = $derived(prompt.proposal);

// Only the classes applyLearnings actually writes in Phase 1 (root cause +
// memory facts) get decision entries; binding/heuristic items are display-only
// until SIO-1127 and must not inflate the approved count (CodeRabbit, PR #392).
const itemIds = $derived(
	[
		...(prompt.proposal.rootCause ? [prompt.proposal.rootCause.id] : []),
		...prompt.proposal.memoryFacts.map((f) => f.id),
	].filter((id) => id.length > 0),
);

let rejected = $state<Set<string>>(new Set());

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
    {#if prompt.alreadyLearned}
      <p class="mt-1 text-xs text-yellow-900 bg-yellow-50 border border-yellow-400/50 rounded px-2 py-1">
        This ticket was learned from before. Re-applying updates the knowledge graph (idempotent) but skips
        duplicate memory facts.
      </p>
    {/if}

    {#if proposal.rootCause}
      <div class="mt-2 rounded border border-tommy-accent-blue/30 bg-white px-2 py-1.5">
        <div class="flex items-start justify-between gap-2">
          <div class="text-xs text-tommy-navy">
            <p class="font-semibold">Corrected root cause: {proposal.rootCause.causeClass}</p>
            <p class="mt-0.5">{proposal.rootCause.description}</p>
            <p class="mt-0.5"><span class="font-semibold">Resolution:</span> {proposal.rootCause.resolution}</p>
            {#if proposal.rootCause.invalidatedHypotheses.length > 0}
              <p class="mt-0.5 font-semibold">Ruled out:</p>
              <ul class="list-disc list-inside">
                {#each proposal.rootCause.invalidatedHypotheses as hyp}
                  <li>{hyp.hypothesis} -- {hyp.reason}</li>
                {/each}
              </ul>
            {/if}
            {#if proposal.rootCause.runbookFilename}
              <p class="mt-0.5 text-gray-600">Links resolution to runbook {proposal.rootCause.runbookFilename}</p>
            {/if}
          </div>
          {@render itemToggle(proposal.rootCause.id)}
        </div>
        {@render evidence(proposal.rootCause.evidence)}
      </div>
    {/if}

    {#if proposal.memoryFacts.length > 0}
      <p class="mt-2 text-xs font-semibold text-tommy-navy">Durable memory facts</p>
      <div class="mt-1 space-y-1">
        {#each proposal.memoryFacts as fact (fact.id)}
          <div class="rounded border border-tommy-accent-blue/30 bg-white px-2 py-1.5">
            <div class="flex items-start justify-between gap-2">
              <p class="text-xs text-tommy-navy">{fact.text}</p>
              {@render itemToggle(fact.id)}
            </div>
            {@render evidence(fact.evidence)}
          </div>
        {/each}
      </div>
    {/if}

    {#if proposal.bindings.length > 0 || proposal.heuristics.length > 0}
      <p class="mt-2 text-xs text-gray-500">
        Binding and heuristic learnings are not applied yet (SIO-1127); they are shown for reference only.
      </p>
    {/if}

    <div class="mt-3 flex gap-2 items-center">
      <button
        type="button"
        onclick={() => onApply(decisions(false))}
        disabled={disabled || approvedCount === 0}
        class="px-3 py-1.5 text-sm font-medium bg-tommy-navy text-white rounded-md hover:bg-tommy-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Apply {approvedCount} approved item{approvedCount === 1 ? "" : "s"}
      </button>
      <button
        type="button"
        onclick={() => onApply(decisions(true))}
        {disabled}
        class="px-3 py-1.5 text-sm font-medium bg-white text-tommy-navy border border-tommy-navy rounded-md hover:bg-tommy-cream disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Reject all
      </button>
    </div>
  </div>
</div>
