<script lang="ts">
// apps/web/src/lib/components/RenovateTriggerChoiceCard.svelte
import type { RenovateTriggerChoice } from "$lib/stores/agent-reducer.ts";

let {
	prompt,
	disabled = false,
	onApprove,
	onDecline,
}: {
	prompt: RenovateTriggerChoice;
	disabled?: boolean;
	onApprove: () => void;
	onDecline: () => void;
} = $props();
</script>

<div
  class="border-t border-tommy-accent-blue/40 bg-blue-50 px-4 py-3"
  role="dialog"
  aria-labelledby="renovate-trigger-heading"
>
  <div class="max-w-4xl mx-auto">
    <h3 id="renovate-trigger-heading" class="text-sm font-semibold text-tommy-navy">
      Trigger Renovate update
    </h3>
    <p class="text-sm text-tommy-navy/80 mt-1">{prompt.message}</p>

    {#if prompt.marker}
      <code class="mt-2 block break-all rounded bg-white/70 border border-tommy-accent-blue/20 px-2 py-1 text-xs font-mono text-tommy-navy/80">
        {prompt.marker}
      </code>
    {/if}

    {#if prompt.line}
      <p class="mt-1 text-xs text-tommy-navy/60 break-all">{prompt.line}</p>
    {/if}

    <div class="mt-3 flex flex-wrap gap-2">
      <button
        type="button"
        onclick={() => onApprove()}
        {disabled}
        class="px-3 py-1.5 text-sm font-medium rounded-md bg-tommy-navy text-white hover:bg-tommy-navy/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Trigger update
      </button>
      <button
        type="button"
        onclick={() => onDecline()}
        {disabled}
        class="px-3 py-1.5 text-sm font-medium rounded-md bg-white text-tommy-navy border border-tommy-navy hover:bg-tommy-cream disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        Decline
      </button>
    </div>
    <p class="mt-2 text-xs text-gray-500">
      Runs via the schedule-triggered Renovate job (branches/MRs only); apply stays manual.
    </p>
  </div>
</div>
