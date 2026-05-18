<script lang="ts">
// apps/web/src/lib/components/ElasticFindingsCard.svelte
// SIO-785 follow-up (2026-05-18): minimal Elastic findings card. Surfaces
// synthetic monitor status — the deterministic signal the elastic sub-agent
// produces during the SOUL-mandated Confluent cross-check (SIO-717).
import type { ElasticApmService, ElasticFindings } from "@devops-agent/shared";

let { findings }: { findings: ElasticFindings } = $props();

const syntheticMonitors = $derived(findings.syntheticMonitors ?? []);
// SIO-787: cap at 10 rows sorted by errorRate desc; null/missing errorRate sinks last.
const apmServices = $derived.by(() => {
	const all = findings.apmServices ?? [];
	const sorted = [...all].sort((a, b) => {
		const ra = a.errorRate ?? -1;
		const rb = b.errorRate ?? -1;
		return rb - ra;
	});
	return sorted.slice(0, 10);
});
const hasContent = $derived(syntheticMonitors.length > 0 || apmServices.length > 0);

function statusDotClass(status: string): string {
	switch (status.toLowerCase()) {
		case "up":
			return "bg-green-500";
		case "down":
			return "bg-red-500";
		case "degraded":
			return "bg-amber-500";
		default:
			return "bg-slate-400";
	}
}

function shortTimestamp(iso: string | undefined): string {
	if (!iso) return "";
	// "2026-05-18T07:23:18.000Z" → "2026-05-18 07:23"
	return iso.slice(0, 16).replace("T", " ");
}

function formatErrorRate(rate: number | undefined): string {
	if (rate === undefined) return "";
	return `${(rate * 100).toFixed(1)}%`;
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "";
	if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.round(ms)}ms`;
}

function errorRateClass(rate: number | undefined): string {
	if (rate === undefined) return "text-gray-400";
	if (rate >= 0.05) return "text-red-600 font-semibold";
	if (rate >= 0.01) return "text-amber-600";
	return "text-gray-500";
}
</script>

{#if hasContent}
  <div class="mt-2 rounded-lg border border-purple-100 bg-purple-50/40 px-3 py-2.5">
    <div class="flex items-center gap-1.5 mb-2">
      <span class="text-[0.5625rem] font-medium text-purple-700 uppercase tracking-wider">Elastic findings</span>
    </div>

    {#if syntheticMonitors.length > 0}
      <div>
        <span class="text-[0.5625rem] font-medium text-gray-500 uppercase tracking-wider">Synthetic monitors</span>
        <div class="mt-1 flex flex-col gap-1">
          {#each syntheticMonitors as monitor}
            <div class="flex items-center gap-2 text-[0.6875rem]">
              <div class="w-1.5 h-1.5 rounded-full shrink-0 {statusDotClass(monitor.status)}" title={monitor.status}></div>
              <span class="font-medium text-gray-800 truncate max-w-[200px]" title={monitor.name}>{monitor.name}</span>
              <span class="text-[0.5625rem] uppercase tracking-wider text-gray-400">{monitor.status}</span>
              {#if monitor.geo}
                <span class="text-[0.5625rem] text-gray-400">{monitor.geo}</span>
              {/if}
              {#if monitor.observedAt}
                <span class="ml-auto text-[0.5625rem] text-gray-500 tabular-nums shrink-0" title={monitor.observedAt}>{shortTimestamp(monitor.observedAt)}</span>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    {#if apmServices.length > 0}
      <div class={syntheticMonitors.length > 0 ? "mt-2" : ""}>
        <span class="text-[0.5625rem] font-medium text-gray-500 uppercase tracking-wider">APM services</span>
        <div class="mt-1 flex flex-col gap-1">
          {#each apmServices as service}
            <div class="flex items-center gap-2 text-[0.6875rem]">
              <span class="font-medium text-gray-800 truncate max-w-[200px]" title={service.serviceName}>{service.serviceName}</span>
              {#if service.errorRate !== undefined}
                <span class="text-[0.625rem] tabular-nums {errorRateClass(service.errorRate)}" title="error rate">{formatErrorRate(service.errorRate)}</span>
              {/if}
              {#if service.avgDurationMs !== undefined}
                <span class="text-[0.5625rem] text-gray-500 tabular-nums" title="avg duration">{formatDuration(service.avgDurationMs)}</span>
              {/if}
              {#if service.observedAt}
                <span class="ml-auto text-[0.5625rem] text-gray-500 tabular-nums shrink-0" title={service.observedAt}>{shortTimestamp(service.observedAt)}</span>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
{/if}
