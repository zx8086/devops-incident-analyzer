<script lang="ts">
// apps/web/src/lib/components/ReconcileChoiceCard.svelte
import {
	formatLeafChange,
	type IacReconcileChoice,
	RECONCILE_DIRECTION_LABELS,
	type ReconcileDirection,
} from "$lib/stores/agent-reducer.ts";

let {
	prompt,
	disabled = false,
	onChoose,
}: {
	prompt: IacReconcileChoice;
	disabled?: boolean;
	onChoose: (direction: ReconcileDirection) => void;
} = $props();

const LABELS = RECONCILE_DIRECTION_LABELS;
</script>

<div class="border-t border-tommy-accent-blue/40 bg-blue-50 px-4 py-3" role="dialog" aria-labelledby="iac-reconcile-heading">
  <div class="max-w-4xl mx-auto">
    <div class="flex items-center justify-between gap-2">
      <h3 id="iac-reconcile-heading" class="text-sm font-semibold text-tommy-navy">Reconcile stack: {prompt.stack}</h3>
      <span class="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-700">{prompt.kind}</span>
    </div>
    <p class="text-sm text-tommy-navy/80 mt-1">{prompt.message}</p>
    <p class="mt-1 text-xs font-mono text-tommy-navy/70">Drift: {prompt.summary}</p>

    <!-- SIO-886: show WHAT drifted so the human can decide MR-vs-skip with the facts. -->
    {#if prompt.resources && prompt.resources.length > 0}
      <div class="mt-2 rounded-md bg-white/70 border border-tommy-accent-blue/20 p-2">
        <p class="text-xs font-semibold text-tommy-navy">What changed</p>
        <ul class="mt-1 space-y-0.5 text-xs">
          {#each prompt.resources as r (r.address)}
            <li class="text-tommy-navy/80">
              <span class="font-mono break-all">{r.address}</span>
              {#if r.reason}
                <span class="text-gray-600"> &mdash; {r.reason}</span>
              {:else if r.changedKeys && r.changedKeys.length > 0}
                <span class="text-gray-600"> &mdash; changed: {r.changedKeys.join(", ")}</span>
              {/if}
              <!-- SIO-900: expand the precise leaf-level changes so the human sees exactly which
                   nested leaves drifted before choosing reconcile-to-live / to-GitLab / skip. -->
              {#if r.changes && r.changes.length > 0}
                <details class="mt-0.5 ml-2">
                  <summary class="cursor-pointer text-tommy-accent-blue">
                    {r.changeCount ?? r.changes.length} change{(r.changeCount ?? r.changes.length) === 1 ? "" : "s"}{r.truncated ? ` (showing ${r.changes.length})` : ""}
                  </summary>
                  <ul class="mt-0.5 space-y-0.5">
                    {#each r.changes as c (c.path)}
                      <li class="font-mono break-all text-gray-600">{formatLeafChange(c)}</li>
                    {/each}
                    {#if r.changeCount && r.changeCount > r.changes.length}
                      <li class="text-gray-400">&hellip;and {r.changeCount - r.changes.length} more</li>
                    {/if}
                  </ul>
                </details>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}

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
      {#if prompt.directions.includes("reconcile-to-live")}
        Reconcile to Live Deployment writes the live values into the config file; Reconcile to GitLab re-asserts the repo so CI's plan shows the revert. Both open an MR &mdash; I never merge or apply.
      {:else}
        Reconcile to GitLab opens an MR; CI computes the plan showing the revert. I never merge or apply.
      {/if}
    </p>
  </div>
</div>
