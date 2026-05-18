<script lang="ts">
// apps/web/src/lib/components/ElasticFindingsCard.svelte
// SIO-785 follow-up (2026-05-18): minimal Elastic findings card. Surfaces
// synthetic monitor status — the deterministic signal the elastic sub-agent
// produces during the SOUL-mandated Confluent cross-check (SIO-717).
import type { ElasticFindings } from "@devops-agent/shared";

let { findings }: { findings: ElasticFindings } = $props();

const syntheticMonitors = $derived(findings.syntheticMonitors ?? []);
const hasContent = $derived(syntheticMonitors.length > 0);

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
</script>

{#if hasContent}
  <div class="mt-2 rounded-lg border border-purple-100 bg-purple-50/40 px-3 py-2.5">
    <div class="flex items-center gap-1.5 mb-2">
      <span class="text-[0.5625rem] font-medium text-purple-700 uppercase tracking-wider">Elastic findings</span>
    </div>

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
  </div>
{/if}
