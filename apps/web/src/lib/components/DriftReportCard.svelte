<script lang="ts">
// apps/web/src/lib/components/DriftReportCard.svelte
import {
	formatLeafChange,
	type IacDriftReport,
	type IacReconcileResultRow,
	RECONCILE_DIRECTION_LABELS,
} from "$lib/stores/agent-reducer.ts";

let {
	report,
	results = [],
	onRecheck,
	recheckDisabled = false,
}: {
	report: IacDriftReport;
	results?: IacReconcileResultRow[];
	// SIO-887: re-run the drift audit for this deployment (the agent re-triggers per-stack checks).
	onRecheck?: () => void;
	recheckDisabled?: boolean;
} = $props();

const drifted = $derived(report.stacks.filter((s) => s.drifted));
const planErrored = $derived(report.stacks.filter((s) => s.planError));
// "In sync" excludes plan-error stacks: those were not assessed, not confirmed clean.
const clean = $derived(report.stacks.filter((s) => !s.drifted && !s.planError));
</script>

<div class="px-4 py-2 max-w-4xl mx-auto">
  <div class="rounded-lg border border-tommy-accent-blue/30 bg-blue-50/60 p-3">
    <div class="flex items-center justify-between gap-2">
      <h3 class="text-sm font-semibold text-tommy-navy">Content drift: {report.deployment}</h3>
      <div class="flex items-center gap-2">
        <span class="text-xs text-tommy-navy/70">
          {drifted.length} of {report.stacks.length} stack{report.stacks.length === 1 ? "" : "s"} drifted
        </span>
        {#if onRecheck}
          <button
            type="button"
            onclick={() => onRecheck?.()}
            disabled={recheckDisabled}
            class="text-xs px-2 py-0.5 rounded-md border border-tommy-navy text-tommy-navy hover:bg-tommy-cream disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Re-check
          </button>
        {/if}
      </div>
    </div>

    {#if drifted.length > 0}
      <ul class="mt-2 space-y-2">
        {#each drifted as s (s.stack)}
          <li class="text-xs">
            <div class="flex items-center gap-2">
              <span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-500"></span>
              <span class="font-medium text-tommy-navy">{s.stack}</span>
              <span class="px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-700">{s.kind}</span>
              <span class="font-mono text-tommy-navy/80">+{s.create} ~{s.update} -{s.delete}</span>
            </div>
            <!-- SIO-886: surface WHAT drifted (reason + changed keys per resource). -->
            {#if s.resources.length > 0}
              <ul class="mt-1 ml-3.5 space-y-0.5 border-l border-amber-300 pl-2">
                {#each s.resources as r (r.address)}
                  <li class="text-tommy-navy/80">
                    <span class="font-mono break-all">{r.address}</span>
                    {#if r.reason}
                      <span class="text-gray-600"> &mdash; {r.reason}</span>
                    {:else if r.changedKeys && r.changedKeys.length > 0}
                      <span class="text-gray-600"> &mdash; changed: {r.changedKeys.join(", ")}</span>
                    {/if}
                    <!-- SIO-900: expand the leaf-level changes[] so one resource line reveals which
                         nested leaves drifted (e.g. 20 monitors inside one `inputs` attribute). -->
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
            {/if}
          </li>
        {/each}
      </ul>
    {:else}
      <p class="mt-2 text-xs text-tommy-navy/70">No drift detected. All stacks match the declared configuration.</p>
    {/if}

    {#if planErrored.length > 0}
      <!-- SIO-887: show WHY each stack could not be assessed (state-lock, plan failure, ...). -->
      <div class="mt-2 text-xs text-yellow-800">
        <p class="font-medium">Plan unavailable (not assessed):</p>
        <ul class="mt-0.5 space-y-0.5">
          {#each planErrored as s (s.stack)}
            <li>
              <span class="font-medium">{s.stack}</span>{#if s.planErrorReason} &mdash; {s.planErrorReason}{/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if clean.length > 0}
      <p class="mt-2 text-xs text-gray-500">In sync: {clean.map((s) => s.stack).join(", ")}</p>
    {/if}

    {#if results.length > 0}
      <div class="mt-3 border-t border-tommy-accent-blue/20 pt-2">
        <p class="text-xs font-semibold text-tommy-navy">Reconcile results</p>
        <ul class="mt-1 space-y-0.5 text-xs">
          {#each results as r (r.stack + r.direction)}
            <li class="text-tommy-navy/80">
              <span class="font-medium">{r.stack}</span>
              <span class="text-gray-500"> &middot; {RECONCILE_DIRECTION_LABELS[r.direction]} &middot; {r.status}</span>
              {#if r.mrUrl}
                <a href={r.mrUrl} target="_blank" rel="noopener noreferrer" class="text-tommy-accent-blue underline">MR</a>
              {/if}
              {#if r.note}<span class="text-gray-500"> &mdash; {r.note}</span>{/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
</div>
