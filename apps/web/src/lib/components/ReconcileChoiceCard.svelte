<script lang="ts">
// apps/web/src/lib/components/ReconcileChoiceCard.svelte
import type { IacReconcileChoice, ReconcileDirection } from "$lib/stores/agent-reducer.ts";

let {
	prompt,
	disabled = false,
	onChoose,
}: {
	prompt: IacReconcileChoice;
	disabled?: boolean;
	onChoose: (direction: ReconcileDirection) => void;
} = $props();

const LABELS: Record<ReconcileDirection, string> = {
	"reconcile-to-live": "Reconcile to live",
	"reconcile-to-json": "Reconcile to declared (open MR)",
	skip: "Skip",
};
</script>

<div class="border-t border-tommy-accent-blue/40 bg-blue-50 px-4 py-3" role="dialog" aria-labelledby="iac-reconcile-heading">
  <div class="max-w-4xl mx-auto">
    <div class="flex items-center justify-between gap-2">
      <h3 id="iac-reconcile-heading" class="text-sm font-semibold text-tommy-navy">Reconcile stack: {prompt.stack}</h3>
      <span class="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-700">{prompt.kind}</span>
    </div>
    <p class="text-sm text-tommy-navy/80 mt-1">{prompt.message}</p>
    <p class="mt-1 text-xs font-mono text-tommy-navy/70">Drift: {prompt.summary}</p>

    <div class="mt-3 flex flex-wrap gap-2">
      {#each prompt.directions as direction (direction)}
        <button
          type="button"
          onclick={() => onChoose(direction)}
          {disabled}
          class="px-3 py-1.5 text-sm font-medium rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors {direction === 'skip' ? 'bg-white text-tommy-navy border border-tommy-navy hover:bg-tommy-cream' : 'bg-tommy-navy text-white hover:bg-tommy-navy/90'}"
        >
          {LABELS[direction]}
        </button>
      {/each}
    </div>
    <p class="mt-2 text-xs text-gray-500">
      Reconcile to declared opens an MR; CI computes the plan showing the revert. I never merge or apply.
    </p>
  </div>
</div>
