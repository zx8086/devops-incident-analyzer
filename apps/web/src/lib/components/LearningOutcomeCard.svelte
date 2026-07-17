<!-- apps/web/src/lib/components/LearningOutcomeCard.svelte -->
<!-- SIO-1146: terminal outcome card for the HIL learning lane. Renders after
     applyLearnings with per-item Applied/Rejected/Skipped statuses from the
     structured report; Done dismisses it client-side (the thread already
     completed server-side when this card appears). -->
<script lang="ts">
import type { HilApplyReport } from "@devops-agent/shared";

let { outcome, onDone }: { outcome: HilApplyReport; onDone: () => void } = $props();

const anyApplied = $derived(outcome.items.some((i) => i.status === "applied"));
const appliedCount = $derived(outcome.items.filter((i) => i.status === "applied").length);
// Report-level skip entries (curation/graph/facts) whose id matches no item
// render as footnotes; per-item reasons already travel on the rows.
const footnotes = $derived(outcome.skipped.filter((s) => !outcome.items.some((i) => i.id === s.id)));

const statusChipClass: Record<string, string> = {
	applied: "bg-green-50 text-green-800 border-green-200",
	rejected: "bg-white text-gray-500 border-gray-300",
	skipped: "bg-yellow-50 text-yellow-900 border-yellow-400/50",
};
const statusLabel: Record<string, string> = {
	applied: "Applied",
	rejected: "Rejected",
	skipped: "Skipped",
};
</script>

<div class="border-t border-tommy-accent-blue/40 bg-blue-50 px-4 py-3" role="status" aria-labelledby="hil-outcome-heading">
  <div class="max-w-4xl mx-auto">
    <div class="rounded-lg border px-3 py-2 {anyApplied ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-gray-50'}">
      <h3 id="hil-outcome-heading" class="text-sm font-semibold {anyApplied ? 'text-green-800' : 'text-gray-700'}">
        {#if anyApplied}
          Learnings from {outcome.ticketKey} -- {appliedCount} item{appliedCount === 1 ? "" : "s"} applied
        {:else}
          <!-- Neutral copy: items may be rejected OR skipped (KG/live memory off,
               write failures); the row chips carry the exact statuses. -->
          No learnings applied from {outcome.ticketKey}
        {/if}
      </h3>
      <p class="mt-0.5 text-xs {anyApplied ? 'text-green-700' : 'text-gray-600'}">
        {#if outcome.incidentCreated}
          Created incident record {outcome.incidentId}
        {:else}
          Linked to incident {outcome.incidentId}
        {/if}
        {#if outcome.runbookLinked}
          &middot; resolved by runbook {outcome.runbookLinked}
        {/if}
      </p>
    </div>

    {#if outcome.items.length > 0}
      <ul class="mt-2 space-y-1">
        {#each outcome.items as item (item.id)}
          <li class="flex items-start gap-2 rounded border border-tommy-accent-blue/30 bg-white px-2 py-1.5 text-xs text-tommy-navy">
            <span class="shrink-0 px-2 py-0.5 rounded border font-medium {statusChipClass[item.status]}">
              {statusLabel[item.status]}
            </span>
            <span class="min-w-0 pt-0.5">
              {item.label}{#if item.reason}<span class="text-gray-500"> -- {item.reason}</span>{/if}
            </span>
          </li>
        {/each}
      </ul>
    {/if}

    {#if outcome.draftRunbookUrl}
      <p class="mt-1 text-xs">
        <a href={outcome.draftRunbookUrl} target="_blank" rel="noopener noreferrer" class="text-tommy-navy underline">
          DRAFT runbook PR opened for review
        </a>
      </p>
    {/if}

    {#each footnotes as note (note.id)}
      <p class="mt-1 text-xs text-gray-500">{note.id}: {note.reason}</p>
    {/each}

    <div class="mt-3">
      <button
        type="button"
        onclick={onDone}
        class="px-3 py-1.5 text-sm font-medium bg-tommy-navy text-white rounded-md hover:bg-tommy-navy/90 transition-colors"
      >
        Done
      </button>
    </div>
  </div>
</div>
