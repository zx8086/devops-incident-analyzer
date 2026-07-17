<script lang="ts">
// apps/web/src/lib/components/LearningMatchCard.svelte
// SIO-1126: HIL learning match gate -- pick which stored investigation the
// ticket corresponds to, or create a new incident record ("none of these").
import type { HilLearningMatchPrompt } from "$lib/stores/agent-reducer.ts";

let {
	prompt,
	disabled = false,
	onPick,
}: {
	prompt: HilLearningMatchPrompt;
	disabled?: boolean;
	onPick: (incidentId: string | null) => void;
} = $props();

// null = "none of these" (create a new incident record from the ticket);
// undefined = no explicit pick yet (defaults to the top candidate).
let picked = $state<string | null | undefined>(undefined);
const selected = $derived(picked === undefined ? (prompt.candidates[0]?.id ?? null) : picked);
</script>

<div
  class="border-t border-tommy-accent-blue/40 bg-blue-50 px-4 py-3"
  role="dialog"
  aria-labelledby="hil-match-heading"
>
  <div class="max-w-4xl mx-auto">
    <h3 id="hil-match-heading" class="text-sm font-semibold text-tommy-navy">
      Learn from {prompt.ticketKey}
    </h3>
    <p class="text-sm text-tommy-navy/80 mt-1">{prompt.message}</p>
    {#if prompt.ticketSummary}
      <p class="mt-1 text-xs text-gray-600"><span class="font-semibold">Ticket:</span> {prompt.ticketSummary}</p>
    {/if}

    <div class="mt-2 space-y-1">
      {#each prompt.candidates as candidate (candidate.id)}
        <label
          class="flex items-start gap-2 rounded border border-tommy-accent-blue/30 bg-white px-2 py-1.5 text-xs text-tommy-navy cursor-pointer"
        >
          <input
            type="radio"
            name="hil-match-candidate"
            value={candidate.id}
            checked={selected === candidate.id}
            onchange={() => {
              picked = candidate.id;
            }}
            {disabled}
            class="mt-0.5"
          />
          <span>
            <span class="font-medium">{candidate.summary || candidate.id}</span>
            <span class="text-gray-500">
              {#if candidate.severity}({candidate.severity}){/if}
              {candidate.via === "ticket-link"
                ? "linked to this ticket (curated)"
                : candidate.via === "request-id"
                  ? "report Request-Id found in ticket"
                  : candidate.via === "ticket-mention"
                    ? "mentions this ticket"
                    : `similarity ${candidate.distance.toFixed(3)}`}
              {#if candidate.hasRootCause}-- has a recorded root cause (a correction will replace it){/if}
            </span>
          </span>
        </label>
      {/each}
      <label
        class="flex items-start gap-2 rounded border border-tommy-accent-blue/30 bg-white px-2 py-1.5 text-xs text-tommy-navy cursor-pointer"
      >
        <input
          type="radio"
          name="hil-match-candidate"
          value=""
          checked={selected === null}
          onchange={() => {
            picked = null;
          }}
          {disabled}
          class="mt-0.5"
        />
        <span>
          <span class="font-medium">None of these</span>
          <span class="text-gray-500">-- create a new incident record from the ticket</span>
        </span>
      </label>
    </div>

    <div class="mt-3 flex gap-2">
      <button
        type="button"
        onclick={() => onPick(selected)}
        {disabled}
        class="px-3 py-1.5 text-sm font-medium bg-tommy-navy text-white rounded-md hover:bg-tommy-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Continue
      </button>
    </div>
  </div>
</div>
