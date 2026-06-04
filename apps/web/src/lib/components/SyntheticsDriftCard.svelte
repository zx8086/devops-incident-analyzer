<script lang="ts">
// apps/web/src/lib/components/SyntheticsDriftCard.svelte
import type { SyntheticsDriftReport, SyntheticsPushResultRow } from "$lib/stores/agent-reducer.ts";

let {
	report,
	result = null,
	onRecheck,
	recheckDisabled = false,
}: {
	report: SyntheticsDriftReport;
	// SIO-902: the push outcome, once the operator approved + the push pipeline finished.
	result?: SyntheticsPushResultRow | null;
	// Re-run the synthetics drift audit for this deployment.
	onRecheck?: () => void;
	recheckDisabled?: boolean;
} = $props();

const changed = $derived(report.drift.filter((m) => m.category === "changed"));
const missing = $derived(report.drift.filter((m) => m.category === "missing_in_kibana"));
const extra = $derived(report.drift.filter((m) => m.category === "extra_in_kibana"));
const driftedCount = $derived(report.totals.changed + report.totals.missingInKibana + report.totals.extraInKibana);

function fmtVal(v: unknown): string {
	const s = typeof v === "string" ? v : JSON.stringify(v);
	return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}
</script>

<div class="px-4 py-2 max-w-4xl mx-auto">
  <div class="rounded-lg border border-tommy-accent-blue/30 bg-blue-50/60 p-3">
    <div class="flex items-center justify-between gap-2">
      <h3 class="text-sm font-semibold text-tommy-navy">Synthetics drift: {report.deployment}</h3>
      <div class="flex items-center gap-2">
        {#if report.kibanaSpace}
          <span class="text-xs px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-700">space: {report.kibanaSpace}</span>
        {/if}
        {#if report.kibanaUrl}
          <a
            href={report.kibanaUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="text-xs text-tommy-accent-blue hover:underline"
          >
            Kibana
          </a>
        {/if}
        <span class="text-xs text-tommy-navy/70">
          {driftedCount} of {report.totals.monitorsInSource} monitor{report.totals.monitorsInSource === 1 ? "" : "s"} drifted
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

    {#if report.planError}
      <!-- The drift-check could not be read: NOT assessed (never imply "in sync"). -->
      <div class="mt-2 text-xs text-yellow-800">
        <p class="font-medium">Drift-check unavailable (not assessed):</p>
        <p class="mt-0.5">{report.planErrorReason ?? "unknown error"}</p>
      </div>
    {:else if !report.hasActionableDrift}
      <p class="mt-2 text-xs text-tommy-navy/70">
        All lightweight monitors are in sync with Kibana ({report.totals.monitorsInSource} checked across
        {report.totals.projectsChecked} project{report.totals.projectsChecked === 1 ? "" : "s"}).
      </p>
    {:else}
      <!-- Totals strip. -->
      <div class="mt-2 flex flex-wrap gap-2 text-xs">
        <span class="text-tommy-navy/70">{report.totals.projectsChecked} projects</span>
        <span class="text-tommy-navy/70">{report.totals.monitorsInSource} in source</span>
        <span class="text-tommy-navy/70">{report.totals.monitorsInKibana} in Kibana</span>
        {#if report.totals.changed > 0}
          <span class="px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800">changed: {report.totals.changed}</span>
        {/if}
        {#if report.totals.missingInKibana > 0}
          <span class="px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-800">missing: {report.totals.missingInKibana}</span>
        {/if}
        {#if report.totals.extraInKibana > 0}
          <span class="px-1.5 py-0.5 rounded-full bg-gray-200 text-gray-700">extra: {report.totals.extraInKibana}</span>
        {/if}
      </div>

      {#if changed.length > 0}
        <div class="mt-2">
          <p class="text-xs font-semibold text-amber-800">Changed &mdash; source differs from Kibana ({changed.length})</p>
          <ul class="mt-1 ml-1 space-y-0.5 border-l border-amber-300 pl-2 text-xs">
            {#each changed as m (m.monitorId)}
              <li class="text-tommy-navy/80">
                <span class="font-medium">{m.project}</span> / {m.monitorName}
                {#if m.fields && m.fields.length > 0}
                  <details class="mt-0.5 ml-2">
                    <summary class="cursor-pointer text-tommy-accent-blue">
                      {m.fields.length} field{m.fields.length === 1 ? "" : "s"}
                    </summary>
                    <ul class="mt-0.5 space-y-0.5">
                      {#each m.fields as f (f.field)}
                        <li class="font-mono break-all text-gray-600">
                          {f.field}: {fmtVal(f.live)} &rarr; {fmtVal(f.source)}
                        </li>
                      {/each}
                    </ul>
                  </details>
                {/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if missing.length > 0}
        <div class="mt-2">
          <p class="text-xs font-semibold text-blue-800">Missing in Kibana &mdash; push will create ({missing.length})</p>
          <ul class="mt-1 ml-1 space-y-0.5 border-l border-blue-300 pl-2 text-xs">
            {#each missing as m (m.monitorId)}
              <li class="text-tommy-navy/80"><span class="font-medium">{m.project}</span> / {m.monitorName}</li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if extra.length > 0}
        <div class="mt-2">
          <p class="text-xs font-semibold text-gray-600">
            Extra in Kibana &mdash; surface-only, never pushed ({extra.length})
          </p>
          <ul class="mt-1 ml-1 space-y-0.5 border-l border-gray-300 pl-2 text-xs">
            {#each extra as m (m.monitorId)}
              <li class="text-tommy-navy/70"><span class="font-medium">{m.project}</span> / {m.monitorName}</li>
            {/each}
          </ul>
          {#if report.reconcilePlan.addToSource.action}
            <p class="mt-1 text-xs text-gray-500">{report.reconcilePlan.addToSource.action}</p>
          {/if}
        </div>
      {/if}

      {#if report.reconcilePlan.pushToKibana.command}
        <div class="mt-2">
          <p class="text-xs font-semibold text-tommy-navy">Push command (what CI runs)</p>
          <code class="mt-0.5 block break-all rounded bg-white/70 border border-tommy-accent-blue/20 px-2 py-1 text-xs font-mono text-tommy-navy/80">
            {report.reconcilePlan.pushToKibana.command}
          </code>
        </div>
      {/if}
    {/if}

    {#if result}
      <div class="mt-2 text-xs">
        {#if result.status === "pushed"}
          <p class="text-green-700">
            Pushed {result.pushedCount} monitor{result.pushedCount === 1 ? "" : "s"} to Kibana
            ({result.project ? `project '${result.project}'` : "fleet-wide"}){#if result.pipelineId}, pipeline #{result.pipelineId}: {result.pipelineStatus ?? "success"}{/if}.
          </p>
        {:else if result.status === "skipped"}
          <p class="text-gray-600">Push declined. No monitors were pushed.</p>
        {:else}
          <p class="text-red-700">Push {result.status}: {result.note ?? "see logs"}.</p>
        {/if}
      </div>
    {/if}

    <p class="mt-2 text-xs text-gray-400">Browser (journey) monitors are not covered by this check.</p>
  </div>
</div>
