<script lang="ts">
// apps/web/src/lib/components/ConfidenceBadge.svelte
// Deep import, NOT the barrel: a value import of the shared index drags
// server-only modules into the client bundle (see AddCommentCard.svelte).
import { capReasonDetail, capReasonLabel } from "@devops-agent/shared/src/confidence.ts";

let {
	confidence,
	confidencePreCap,
	capReasons = [],
	lowConfidence = false,
}: {
	confidence?: number;
	confidencePreCap?: number;
	capReasons?: string[];
	lowConfidence?: boolean;
} = $props();

let expanded = $state(false);

const capped = $derived(capReasons.length > 0);
// Only claim a reduction when the evidence score actually exceeds the shown value.
const showEvidence = $derived(
	capped && confidencePreCap !== undefined && confidence !== undefined && confidencePreCap > confidence,
);
</script>

{#if confidence !== undefined}
  <div class="mt-2 text-xs">
    {#if capped}
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 font-medium text-amber-800 hover:bg-amber-100"
        onclick={() => (expanded = !expanded)}
        aria-expanded={expanded}
        title={capReasons.map(capReasonLabel).join(", ")}
      >
        <span>Confidence {confidence}</span>
        {#if showEvidence}
          <span class="font-normal text-amber-700">evidence {confidencePreCap}, capped</span>
        {:else}
          <span class="font-normal text-amber-700">capped</span>
        {/if}
        <span class="text-amber-500">{expanded ? "-" : "+"}</span>
      </button>
      {#if expanded}
        <ul class="mt-1.5 space-y-1 rounded-md border border-amber-200 bg-amber-50/60 px-3 py-2 text-amber-900">
          {#each capReasons as reason (reason)}
            <li>
              <span class="font-medium">{capReasonLabel(reason)}:</span>
              <span class="text-amber-800">{capReasonDetail(reason)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    {:else if lowConfidence}
      <span
        class="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 font-medium text-amber-800"
      >
        Confidence {confidence}
        <span class="font-normal text-amber-700">below review threshold</span>
      </span>
    {:else}
      <span
        class="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2.5 py-0.5 font-medium text-gray-600"
      >
        Confidence {confidence}
      </span>
    {/if}
  </div>
{/if}
