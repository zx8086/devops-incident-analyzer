<script lang="ts">
// apps/web/src/lib/components/DriftReportCard.svelte
import type { IacDriftReport, IacReconcileResultRow } from "$lib/stores/agent-reducer.ts";

let {
	report,
	results = [],
}: {
	report: IacDriftReport;
	results?: IacReconcileResultRow[];
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
      <span class="text-xs text-tommy-navy/70">
        {drifted.length} of {report.stacks.length} stack{report.stacks.length === 1 ? "" : "s"} drifted
      </span>
    </div>

    {#if drifted.length > 0}
      <ul class="mt-2 space-y-1">
        {#each drifted as s (s.stack)}
          <li class="flex items-center gap-2 text-xs">
            <span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-500"></span>
            <span class="font-medium text-tommy-navy">{s.stack}</span>
            <span class="px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-700">{s.kind}</span>
            <span class="font-mono text-tommy-navy/80">+{s.create} ~{s.update} -{s.delete}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="mt-2 text-xs text-tommy-navy/70">No drift detected. All stacks match the declared configuration.</p>
    {/if}

    {#if planErrored.length > 0}
      <p class="mt-2 text-xs text-yellow-800">
        Plan unavailable (not assessed): {planErrored.map((s) => s.stack).join(", ")}
      </p>
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
              <span class="text-gray-500"> &middot; {r.direction} &middot; {r.status}</span>
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
