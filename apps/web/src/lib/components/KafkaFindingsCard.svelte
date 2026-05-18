<script lang="ts">
// apps/web/src/lib/components/KafkaFindingsCard.svelte
// SIO-775: render typed kafka findings inline in chat.
import type { KafkaFindings } from "@devops-agent/shared";

let { findings }: { findings: KafkaFindings } = $props();

const consumerGroups = $derived(findings.consumerGroups ?? []);
const dlqTopics = $derived(findings.dlqTopics ?? []);
const cluster = $derived(findings.cluster);
const connectors = $derived(findings.connectors ?? []);
const ksqlQueries = $derived(findings.ksqlQueries ?? []);
const hasContent = $derived(
	consumerGroups.length > 0 ||
		dlqTopics.length > 0 ||
		!!cluster ||
		connectors.length > 0 ||
		ksqlQueries.length > 0,
);

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
	switch (state?.toUpperCase()) {
		case "STABLE":
			return "bg-green-500";
		case "PREPARING_REBALANCE":
		case "COMPLETING_REBALANCE":
			return "bg-amber-500";
		case "DEAD":
		case "EMPTY":
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

// SIO-785 follow-up: Connect connector state colours. Confluent Connect uses
// uppercase: RUNNING / PAUSED / FAILED / UNASSIGNED / RESTARTING.
function connectorStateClass(state: string): string {
	switch (state.toUpperCase()) {
		case "RUNNING":
			return "bg-green-500";
		case "PAUSED":
			return "bg-amber-500";
		case "RESTARTING":
			return "bg-amber-500";
		case "FAILED":
			return "bg-red-500";
		case "UNASSIGNED":
			return "bg-red-500";
		default:
			return "bg-slate-400";
	}
}

// SIO-785 follow-up: ksqlDB query state. Top-level query state is RUNNING / ERROR / TERMINATED.
// statusCount surfaces per-replica state distribution from the cluster.
function ksqlStateClass(state: string): string {
	switch (state.toUpperCase()) {
		case "RUNNING":
			return "bg-green-500";
		case "ERROR":
			return "bg-red-500";
		case "TERMINATED":
			return "bg-slate-400";
		default:
			return "bg-amber-500";
	}
}

// SIO-785 follow-up: compress statusCount object into a compact "1R 2U" badge.
function formatStatusCount(sc: Record<string, number> | undefined): string {
	if (!sc) return "";
	const parts: string[] = [];
	for (const [state, count] of Object.entries(sc)) {
		// Short codes: RUNNING -> R, UNRESPONSIVE -> U, ERROR -> E, etc.
		const code = state.charAt(0).toUpperCase();
		parts.push(`${count}${code}`);
	}
	return parts.join(" ");
}

// Derived aggregates for the connectors section header.
const connectorStateCounts = $derived.by(() => {
	const counts: Record<string, number> = {};
	for (const c of connectors) {
		const k = c.state.toUpperCase();
		counts[k] = (counts[k] ?? 0) + 1;
	}
	return counts;
});

const ksqlStateCounts = $derived.by(() => {
	const counts: Record<string, number> = {};
	for (const q of ksqlQueries) {
		const k = q.state.toUpperCase();
		counts[k] = (counts[k] ?? 0) + 1;
	}
	return counts;
});
</script>

{#if hasContent}
  <div class="mt-2 rounded-lg border border-blue-100 bg-blue-50/50 px-3 py-2.5">
    <div class="flex items-center gap-1.5 mb-2">
      <span class="text-[0.5625rem] font-medium text-blue-700 uppercase tracking-wider">Kafka findings</span>
    </div>

    {#if cluster}
      <div class="mb-2.5 flex items-center gap-3 text-[0.6875rem] text-gray-700">
        {#if cluster.provider}
          <span class="inline-flex items-center gap-1">
            <span class="text-[0.5625rem] uppercase tracking-wider text-gray-500">Provider</span>
            <span class="font-medium text-gray-800">{cluster.provider}</span>
          </span>
        {/if}
        {#if cluster.brokerCount !== undefined}
          <span class="inline-flex items-center gap-1">
            <span class="text-[0.5625rem] uppercase tracking-wider text-gray-500">Brokers</span>
            <span class="font-medium text-gray-800 tabular-nums">{cluster.brokerCount}</span>
          </span>
        {/if}
        {#if cluster.topicCount !== undefined}
          <span class="inline-flex items-center gap-1">
            <span class="text-[0.5625rem] uppercase tracking-wider text-gray-500">Topics</span>
            <span class="font-medium text-gray-800 tabular-nums">{cluster.topicCount.toLocaleString()}</span>
          </span>
        {/if}
        {#if cluster.controllerId !== undefined}
          <span class="inline-flex items-center gap-1">
            <span class="text-[0.5625rem] uppercase tracking-wider text-gray-500">Controller</span>
            <span class="font-medium text-gray-800 tabular-nums">{cluster.controllerId}</span>
          </span>
        {/if}
      </div>
    {/if}

    {#if connectors.length > 0}
      <div class="mb-2.5">
        <div class="flex items-center justify-between">
          <span class="text-[0.5625rem] font-medium text-gray-500 uppercase tracking-wider">Connect connectors</span>
          <span class="text-[0.5625rem] text-gray-500 tabular-nums">
            {#each Object.entries(connectorStateCounts) as [state, count], i}
              {#if i > 0}<span class="mx-1">·</span>{/if}<span class="text-gray-700">{count}</span> {state}
            {/each}
          </span>
        </div>
        <div class="mt-1 flex flex-col gap-1">
          {#each connectors as connector}
            <div class="flex items-center gap-2 text-[0.6875rem]">
              <div class="w-1.5 h-1.5 rounded-full shrink-0 {connectorStateClass(connector.state)}" title={connector.state}></div>
              <span class="font-medium text-gray-800 truncate" title={connector.name}>{connector.name}</span>
              {#if connector.type}
                <span class="text-[0.5625rem] uppercase tracking-wider text-gray-400">{connector.type}</span>
              {/if}
              {#if connector.taskFailures !== undefined && connector.taskFailures > 0}
                <span class="ml-auto text-[0.6875rem] text-red-600 tabular-nums shrink-0">{connector.taskFailures} task fail</span>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    {#if ksqlQueries.length > 0}
      <div class="mb-2.5">
        <div class="flex items-center justify-between">
          <span class="text-[0.5625rem] font-medium text-gray-500 uppercase tracking-wider">ksqlDB queries</span>
          <span class="text-[0.5625rem] text-gray-500 tabular-nums">
            {#each Object.entries(ksqlStateCounts) as [state, count], i}
              {#if i > 0}<span class="mx-1">·</span>{/if}<span class="text-gray-700">{count}</span> {state}
            {/each}
          </span>
        </div>
        <div class="mt-1 flex flex-col gap-1">
          {#each ksqlQueries as query}
            <div class="flex items-center gap-2 text-[0.6875rem]">
              <div class="w-1.5 h-1.5 rounded-full shrink-0 {ksqlStateClass(query.state)}" title={query.state}></div>
              <span class="font-medium text-gray-800 truncate max-w-[260px]" title={query.id}>{query.id}</span>
              {#if query.statusCount && Object.keys(query.statusCount).length > 1}
                <span class="ml-auto text-[0.5625rem] text-gray-500 tabular-nums shrink-0" title={Object.entries(query.statusCount).map(([s, c]) => `${c} ${s}`).join(', ')}>
                  {formatStatusCount(query.statusCount)}
                </span>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

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
