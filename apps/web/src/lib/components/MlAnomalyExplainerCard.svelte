<script lang="ts">
// apps/web/src/lib/components/MlAnomalyExplainerCard.svelte
// SIO-1215: ML anomaly-record explainer. Overview mode (many records/jobs)
// leads with severity-band counts, an affected-entities list, and a per-job
// table; detail mode (a small, focused result set) leads with the top
// record's score/actual/typical/deviation. No chart library for v1 -- plain
// Tailwind badges/bars, unlike NetworkTopologyCard's ECharts dependency.
import type { MlAnomalyExplainer, MlAnomalyRecord } from "@devops-agent/shared";

let { explainer }: { explainer: MlAnomalyExplainer } = $props();

type Severity = "critical" | "major" | "minor" | "low";

function severityOf(score: number): Severity {
	if (score >= 75) return "critical";
	if (score >= 50) return "major";
	if (score >= 25) return "minor";
	return "low";
}

function severityBadgeClass(severity: Severity): string {
	switch (severity) {
		case "critical":
			return "bg-red-100 text-red-700";
		case "major":
			return "bg-amber-100 text-amber-700";
		case "minor":
			return "bg-yellow-100 text-yellow-700";
		default:
			return "bg-slate-100 text-slate-600";
	}
}

const severityCounts = $derived.by(() => {
	const counts: Record<Severity, number> = { critical: 0, major: 0, minor: 0, low: 0 };
	for (const r of explainer.records) counts[severityOf(r.recordScore)]++;
	return counts;
});

const MAX_ENTITIES = 8;
const affectedEntities = $derived.by(() => {
	const seen = new Set<string>();
	for (const r of explainer.records) {
		if (r.entity) seen.add(r.entity);
	}
	return Array.from(seen);
});

const topRecords = $derived([...explainer.records].sort((a, b) => b.recordScore - a.recordScore).slice(0, 5));

function formatDeviation(record: MlAnomalyRecord): string {
	if (record.deviationPercent === undefined) return "n/a";
	const sign = record.deviationPercent > 0 ? "+" : "";
	return `${sign}${record.deviationPercent.toFixed(0)}%`;
}

function formatNumber(n: number | undefined): string {
	if (n === undefined) return "n/a";
	return Intl.NumberFormat(undefined, { maximumFractionDigits: 1, notation: "compact" }).format(n);
}

function shortTimestamp(iso: string | undefined): string {
	if (!iso) return "";
	return iso.slice(0, 16).replace("T", " ");
}

// Records have no natural unique id -- compose one from the fields a
// duplicate record can never share, for {#each} keying.
function recordKey(record: MlAnomalyRecord): string {
	return `${record.jobId}|${record.timestamp ?? ""}|${record.fieldName ?? ""}|${record.entity ?? ""}`;
}

const minScoreLabel = $derived(
	explainer.minScoreApplied === undefined ? "no filter" : `>= ${explainer.minScoreApplied}`,
);
</script>

{#if explainer.records.length > 0}
  <div class="mt-2 rounded-lg border border-indigo-100 bg-indigo-50/40 px-3 py-2.5">
    <div class="flex items-center justify-between mb-2">
      <span class="text-[0.5625rem] font-medium text-indigo-700 uppercase tracking-wider">ML anomaly records</span>
      <span class="text-[0.5625rem] text-gray-400 tabular-nums">{explainer.lookback} &middot; score {minScoreLabel}</span>
    </div>

    {#if explainer.mode === "overview"}
      <div class="flex items-center gap-1.5 flex-wrap">
        {#each ["critical", "major", "minor", "low"] as const as severity (severity)}
          {#if severityCounts[severity] > 0}
            <span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.625rem] font-medium tabular-nums {severityBadgeClass(severity)}">
              {severityCounts[severity]} {severity}
            </span>
          {/if}
        {/each}
      </div>

      {#if affectedEntities.length > 0}
        <div class="mt-2">
          <span class="text-[0.5625rem] font-medium text-gray-500 uppercase tracking-wider">Affected entities</span>
          <div class="mt-1 flex flex-wrap gap-1">
            {#each affectedEntities.slice(0, MAX_ENTITIES) as entity (entity)}
              <span class="text-[0.6875rem] text-gray-700 bg-white/70 border border-indigo-100 rounded px-1.5 py-0.5 truncate max-w-[160px]" title={entity}>{entity}</span>
            {/each}
            {#if affectedEntities.length > MAX_ENTITIES}
              <span class="text-[0.625rem] text-gray-400 self-center">+{affectedEntities.length - MAX_ENTITIES} more</span>
            {/if}
          </div>
        </div>
      {/if}

      {#if explainer.jobsSummary.length > 0}
        <div class="mt-2">
          <span class="text-[0.5625rem] font-medium text-gray-500 uppercase tracking-wider">By job</span>
          <div class="mt-1 flex flex-col gap-1">
            {#each explainer.jobsSummary as job (job.jobId)}
              <div class="flex items-center gap-2 text-[0.6875rem]">
                <span class="font-medium text-gray-800 truncate max-w-[220px]" title={job.jobId}>{job.jobId}</span>
                <span class="ml-auto inline-flex items-center justify-center min-w-[1.5rem] px-1 rounded bg-indigo-100 text-indigo-700 text-[0.5625rem] tabular-nums font-medium">{job.count}</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <div class="mt-2">
        <span class="text-[0.5625rem] font-medium text-gray-500 uppercase tracking-wider">Top by score</span>
        <div class="mt-1 flex flex-col gap-1">
          {#each topRecords as record (recordKey(record))}
            <div class="flex items-center gap-2 text-[0.6875rem]">
              <span class="inline-flex items-center justify-center min-w-[2rem] px-1 rounded {severityBadgeClass(severityOf(record.recordScore))} text-[0.5625rem] tabular-nums font-medium">{record.recordScore.toFixed(0)}</span>
              <span class="font-medium text-gray-800 truncate max-w-[140px]" title={record.entity}>{record.entity ?? "(no entity)"}</span>
              <span class="text-[0.5625rem] text-gray-500 truncate max-w-[100px]" title={record.functionName}>{record.functionName ?? ""}</span>
              <span class="ml-auto text-[0.625rem] tabular-nums text-gray-600" title="deviation from typical">{formatDeviation(record)}</span>
            </div>
          {/each}
        </div>
      </div>
    {:else}
      {#each topRecords as record, i (recordKey(record))}
        <div class={i > 0 ? "mt-3 pt-3 border-t border-indigo-100" : ""}>
        <div class="flex items-center gap-2 mb-2">
          <span class="inline-flex items-center justify-center min-w-[2.25rem] px-1.5 py-0.5 rounded {severityBadgeClass(severityOf(record.recordScore))} text-[0.6875rem] tabular-nums font-semibold">{record.recordScore.toFixed(0)}</span>
          <span class="font-medium text-gray-800 truncate" title={record.jobId}>{record.jobId}</span>
          {#if record.timestamp}
            <span class="ml-auto text-[0.5625rem] text-gray-500 tabular-nums shrink-0">{shortTimestamp(record.timestamp)}</span>
          {/if}
        </div>
        <div class="grid grid-cols-2 gap-2 text-[0.6875rem]">
          <div>
            <span class="text-[0.5625rem] text-gray-500 uppercase tracking-wider">Entity</span>
            <div class="text-gray-800 truncate" title={record.entity}>{record.entity ?? "(no entity)"}</div>
          </div>
          <div>
            <span class="text-[0.5625rem] text-gray-500 uppercase tracking-wider">Signal</span>
            <div class="text-gray-800 truncate">{record.functionName ?? ""}{record.fieldName ? ` (${record.fieldName})` : ""}</div>
          </div>
          <div>
            <span class="text-[0.5625rem] text-gray-500 uppercase tracking-wider">Actual</span>
            <div class="text-gray-800 tabular-nums">{formatNumber(record.actual?.[0])}</div>
          </div>
          <div>
            <span class="text-[0.5625rem] text-gray-500 uppercase tracking-wider">Typical</span>
            <div class="text-gray-800 tabular-nums">{formatNumber(record.typical?.[0])}</div>
          </div>
        </div>
        {#if record.actual?.[0] !== undefined && record.typical?.[0] !== undefined}
          {@const maxVal = Math.max(record.actual[0], record.typical[0]) || 1}
          <div class="mt-2 flex flex-col gap-1">
            <div class="flex items-center gap-2">
              <span class="text-[0.5625rem] text-gray-500 w-14 shrink-0">Typical</span>
              <div class="flex-1 h-1.5 bg-white/70 rounded overflow-hidden">
                <div class="h-full bg-slate-400 rounded" style="width: {Math.min(100, (record.typical[0] / maxVal) * 100)}%"></div>
              </div>
            </div>
            <div class="flex items-center gap-2">
              <span class="text-[0.5625rem] text-gray-500 w-14 shrink-0">Actual</span>
              <div class="flex-1 h-1.5 bg-white/70 rounded overflow-hidden">
                <div class="h-full bg-red-500 rounded" style="width: {Math.min(100, (record.actual[0] / maxVal) * 100)}%"></div>
              </div>
            </div>
          </div>
        {/if}
        </div>
      {/each}
    {/if}

    {#if explainer.investigationActions.length > 0}
      <div class="mt-2">
        <span class="text-[0.5625rem] font-medium text-gray-500 uppercase tracking-wider">Suggested follow-ups</span>
        <ul class="mt-1 list-disc list-inside text-[0.6875rem] text-gray-700">
          {#each explainer.investigationActions as action (action)}
            <li>{action}</li>
          {/each}
        </ul>
      </div>
    {/if}

    {#if explainer.truncated}
      <div class="mt-2 text-[0.5625rem] text-gray-400">Results truncated -- narrow the query for a complete list.</div>
    {/if}
  </div>
{/if}
