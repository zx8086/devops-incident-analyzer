<script lang="ts">
// apps/web/src/lib/components/KafkaFindingsCard.svelte
// SIO-775: render typed kafka findings inline in chat.
import type { KafkaFindings } from "@devops-agent/shared";

let { findings }: { findings: KafkaFindings } = $props();

const consumerGroups = $derived(findings.consumerGroups ?? []);
const dlqTopics = $derived(findings.dlqTopics ?? []);
const hasContent = $derived(consumerGroups.length > 0 || dlqTopics.length > 0);

const maxLag = $derived(Math.max(...consumerGroups.map((g) => g.totalLag ?? 0), 1));
const useLogScale = $derived(maxLag > 100_000);

function barWidthPct(lag: number | undefined): number {
	if (!lag || lag <= 0) return 0;
	if (useLogScale) {
		return Math.min(100, (Math.log10(lag + 1) / Math.log10(maxLag + 1)) * 100);
	}
	return Math.min(100, (lag / maxLag) * 100);
}

function stateDotClass(state: string | undefined): string {
	switch (state) {
		case "Stable":
			return "bg-green-500";
		case "Rebalancing":
			return "bg-amber-500";
		case "Dead":
			return "bg-red-500";
		default:
			return "bg-slate-400";
	}
}

function deltaClass(delta: number | null): string {
	if (delta === null) return "text-gray-400";
	if (delta > 0) return "text-red-600";
	if (delta < 0) return "text-green-600";
	return "text-gray-500";
}

function deltaGlyph(delta: number | null): string {
	if (delta === null) return "";
	if (delta > 0) return "▲";
	if (delta < 0) return "▼";
	return "•";
}

function formatLag(lag: number | undefined): string {
	if (lag === undefined) return "—";
	if (lag >= 1_000_000) return `${(lag / 1_000_000).toFixed(1)}M`;
	if (lag >= 1_000) return `${(lag / 1_000).toFixed(1)}k`;
	return String(lag);
}
</script>

{#if hasContent}
  <div class="mt-2 rounded-lg border border-blue-100 bg-blue-50/50 px-3 py-2.5">
    <div class="flex items-center gap-1.5 mb-2">
      <span class="text-[0.5625rem] font-medium text-blue-700 uppercase tracking-wider">Kafka findings</span>
    </div>

    {#if consumerGroups.length > 0}
      <div class="mb-2.5">
        <span class="text-[0.5625rem] font-medium text-gray-500 uppercase tracking-wider">Consumer groups</span>
        <div class="mt-1 flex flex-col gap-1">
          {#each consumerGroups as group}
            <div class="flex items-center gap-2 text-[0.6875rem]">
              <div class="w-1.5 h-1.5 rounded-full shrink-0 {stateDotClass(group.state)}" title={group.state ?? 'unknown'}></div>
              <span class="font-medium text-gray-800 truncate max-w-[180px]" title={group.id}>{group.id}</span>
              <div class="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div
                  class="h-full bg-blue-500 rounded-full transition-all"
                  style="width: {barWidthPct(group.totalLag)}%"
                ></div>
              </div>
              <span class="text-gray-500 tabular-nums shrink-0 w-12 text-right">{formatLag(group.totalLag)}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    {#if dlqTopics.length > 0}
      <div>
        <span class="text-[0.5625rem] font-medium text-gray-500 uppercase tracking-wider">DLQ topics</span>
        <div class="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {#each dlqTopics as topic}
            <div class="rounded-md bg-white border border-gray-200 px-2 py-1.5">
              <div class="text-[0.625rem] font-medium text-gray-800 truncate" title={topic.name}>{topic.name}</div>
              <div class="flex items-baseline gap-2 mt-0.5">
                <span class="text-sm font-semibold text-gray-900 tabular-nums">{topic.totalMessages.toLocaleString()}</span>
                <span class="text-[0.625rem] {deltaClass(topic.recentDelta)}">
                  {#if topic.recentDelta === null}
                    no baseline
                  {:else}
                    {deltaGlyph(topic.recentDelta)} {Math.abs(topic.recentDelta).toLocaleString()}
                  {/if}
                </span>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
{/if}
