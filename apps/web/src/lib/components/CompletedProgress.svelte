<script lang="ts">
// apps/web/src/lib/components/CompletedProgress.svelte
import type { DataSourceFindings } from "$lib/stores/agent-reducer";
import Icon from "./Icon.svelte";

// SIO-934: incident-graph + elastic-iac node labels. IaC completed-labels mirror
// StreamingProgress's IAC_MAKER_NODES/IAC_DRIFT_NODES completeLabels so the live and historical
// panels read identically. Unmapped ids fall back to the raw id (NODE_LABELS[id] ?? id).
const NODE_LABELS: Record<string, string> = {
	// incident pipeline
	classify: "Classified",
	entityExtractor: "Extracted",
	queryDataSource: "Queried",
	align: "Aligned",
	aggregate: "Analyzed",
	extractFindings: "Findings",
	validate: "Validated",
	// elastic-iac maker graph
	bootstrap: "Bootstrapped",
	parseIntent: "Parsed",
	readClusterState: "Read state",
	guard: "Checked",
	draftChange: "Drafted",
	reviewPlan: "Prepared",
	reviewGate: "Reviewed",
	openMr: "MR opened",
	watchPipeline: "Pipeline", // SIO-984: the post-MR poll-to-terminal watch phase
	teardown: "Finished",
	// elastic-iac drift sub-flow
	detectDrift: "Drift detected",
	reconcileGate: "Reviewed",
	reconcileStack: "Reconciled",
	advanceDrift: "Advanced",
	// elastic-iac synthetics drift sub-flow
	detectSyntheticsDrift: "Synthetics checked",
	syntheticsPushGate: "Reviewed",
	pushSynthetics: "Pushed",
	// elastic-iac fleet upgrade sub-flow
	detectFleetUpgrade: "Upgrade checked",
	fleetUpgradeGate: "Reviewed",
	applyFleetUpgrade: "Upgrade applied",
};

interface DataSourceStatus {
	status: string;
	message?: string;
}

let {
	responseTime,
	toolsUsed = [],
	completedNodes = new Map(),
	dataSourceResults,
	dataSourceFindings,
	outcome = "completed",
}: {
	responseTime?: number;
	toolsUsed?: string[];
	completedNodes?: Map<string, { duration: number }>;
	dataSourceResults?: Map<string, DataSourceStatus>;
	dataSourceFindings?: Map<string, DataSourceFindings>;
	outcome?: "completed" | "rejected" | "declined" | "no-op" | "blocked" | "unsupported" | "pipeline-failed" | "error";
} = $props();

let expanded = $state(false);

// SIO-785 follow-up: union keys from progress map + findings map so the Data
// Sources section renders whenever EITHER signal exists. Previously gated on
// dataSourceResults alone, which left findings cards homeless when the pump
// emitted datasource_result without datasource_progress.
const dataSources = $derived.by(() => {
	const ids = new Set<string>();
	if (dataSourceResults) for (const k of dataSourceResults.keys()) ids.add(k);
	if (dataSourceFindings) for (const k of dataSourceFindings.keys()) ids.add(k);
	const out: Array<[string, DataSourceStatus]> = [];
	for (const id of ids) {
		const fromResults = dataSourceResults?.get(id);
		if (fromResults) {
			out.push([id, fromResults]);
			continue;
		}
		const f = dataSourceFindings?.get(id);
		// Infer status from findings entry when no progress tick arrived.
		out.push([id, { status: f?.status ?? "success", message: f?.error }]);
	}
	return out;
});
const findings = $derived(dataSourceFindings ? [...dataSourceFindings.entries()] : []);

// SIO-1110: an error outcome counts as content -- a client-side fetch failure
// produces no nodes/metadata, and the Failed chip must still render.
const hasContent = $derived(
	outcome === "error" ||
		responseTime !== undefined ||
		toolsUsed.length > 0 ||
		completedNodes.size > 0 ||
		dataSources.length > 0 ||
		findings.length > 0,
);

const formattedTime = $derived(responseTime !== undefined ? `${(responseTime / 1000).toFixed(1)}s` : undefined);

// SIO-930: the completion chip reflects the real per-turn outcome. Only "completed" stays green +
// shows timing/data-source counts; rejections/declines/blocks are amber, a failed pipeline is red,
// and an unsupported request is neutral. Icon names are validated against Icon.svelte's union.
const outcomeView = $derived.by(() => {
	switch (outcome) {
		case "rejected":
			return {
				label: "Plan rejected",
				icon: "x" as const,
				text: "text-amber-700",
				bgFrom: "#fffbeb",
				bgTo: "#fef3c7",
				border: "#fde68a",
			};
		case "declined":
			return {
				label: "Declined",
				icon: "x" as const,
				text: "text-amber-700",
				bgFrom: "#fffbeb",
				bgTo: "#fef3c7",
				border: "#fde68a",
			};
		case "blocked":
			return {
				label: "Blocked",
				icon: "x" as const,
				text: "text-amber-700",
				bgFrom: "#fffbeb",
				bgTo: "#fef3c7",
				border: "#fde68a",
			};
		case "no-op":
			// SIO-1020: a no-op (requested config already matches current state) is informational, not
			// a failure. Neutral styling distinct from amber "Blocked"; no MR was opened.
			return {
				label: "No change needed",
				icon: "message-square" as const,
				text: "text-gray-600",
				bgFrom: "#f9fafb",
				bgTo: "#f3f4f6",
				border: "#e5e7eb",
			};
		case "unsupported":
			return {
				label: "Not supported yet",
				icon: "message-square" as const,
				text: "text-gray-600",
				bgFrom: "#f9fafb",
				bgTo: "#f3f4f6",
				border: "#e5e7eb",
			};
		case "pipeline-failed":
			return {
				label: "Pipeline failed",
				icon: "error" as const,
				text: "text-red-700",
				bgFrom: "#fef2f2",
				bgTo: "#fee2e2",
				border: "#fecaca",
			};
		case "error":
			// SIO-1110: a turn whose stream ended in an error event (e.g. graph
			// timeout abort) must not render the green "Completed" chip.
			return {
				label: "Failed",
				icon: "error" as const,
				text: "text-red-700",
				bgFrom: "#fef2f2",
				bgTo: "#fee2e2",
				border: "#fecaca",
			};
		default:
			return {
				label: "Completed",
				icon: "check" as const,
				text: "text-green-700",
				bgFrom: "#f0fdf4",
				bgTo: "#dcfce7",
				border: "#bbf7d0",
			};
	}
});
const isCompleted = $derived(outcome === "completed");

const successCount = $derived(dataSources.filter(([, d]) => d.status === "success").length);
const errorCount = $derived(dataSources.filter(([, d]) => d.status === "error").length);

function statusDotClass(status: string): string {
	switch (status) {
		case "success":
			return "bg-green-500";
		case "error":
			return "bg-red-500";
		case "running":
			return "bg-yellow-500";
		default:
			return "bg-gray-400";
	}
}
</script>

{#if hasContent}
  <div class="mt-2 animate-fade-in">
    <button
      onclick={() => expanded = !expanded}
      class="w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-left"
      style="background: linear-gradient(135deg, {outcomeView.bgFrom}, {outcomeView.bgTo}); border: 1px solid {outcomeView.border};"
    >
      <Icon name={outcomeView.icon} class="w-3.5 h-3.5 {outcomeView.text}" />
      <span class="text-xs font-medium {outcomeView.text}">
        {outcomeView.label}{#if isCompleted && formattedTime} in {formattedTime}{/if}
        {#if isCompleted && dataSources.length > 0}
          <span class="text-green-500 font-normal">
            -- {dataSources.length} data source{dataSources.length !== 1 ? "s" : ""}
            {#if errorCount > 0}
              ({successCount} ok, {errorCount} failed)
            {/if}
          </span>
        {/if}
      </span>
      <Icon
        name="chevron-down"
        class="w-3 h-3 {outcomeView.text} opacity-70 ml-auto shrink-0 transition-transform {expanded ? 'rotate-180' : ''}"
      />
    </button>

    {#if expanded}
      <div class="mt-1 bg-green-50 border border-green-100 rounded-lg px-3 py-2.5 animate-slide-up-fade">
        {#if completedNodes.size > 0}
          <div class="mb-2.5">
            <span class="text-[0.5625rem] font-medium text-gray-500 uppercase tracking-wider">Pipeline</span>
            <div class="flex flex-wrap gap-1.5 mt-1">
              {#each [...completedNodes.entries()] as [nodeId, data]}
                <span class="inline-flex items-center gap-1 py-0.5 px-2 rounded-full bg-green-100 text-green-700 text-[0.625rem] font-medium">
                  <Icon name="check" class="w-2.5 h-2.5" />
                  {NODE_LABELS[nodeId] ?? nodeId}
                  <span class="text-green-500 text-[0.5rem]">{(data.duration / 1000).toFixed(1)}s</span>
                </span>
              {/each}
            </div>
          </div>
        {/if}

        {#if dataSources.length > 0}
          <div class="mb-2.5">
            <span class="text-[0.5625rem] font-medium text-gray-500 uppercase tracking-wider">Data Sources</span>
            <div class="flex flex-col gap-1 mt-1">
              {#each dataSources as [id, ds]}
                <div class="flex items-center gap-2 py-1">
                  <div class="w-1.5 h-1.5 rounded-full shrink-0 {statusDotClass(ds.status)}"></div>
                  <span class="text-[0.6875rem] font-medium text-gray-800">{id}</span>
                  <span class="text-[0.625rem] text-gray-500 capitalize">{ds.status}</span>
                  {#if ds.message}
                    <span class="text-[0.625rem] text-red-600 ml-auto truncate max-w-[200px]">{ds.message}</span>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}

        {#if toolsUsed.length > 0}
          <div>
            <span class="text-[0.5625rem] font-medium text-gray-500 uppercase tracking-wider">Tools</span>
            <div class="flex flex-wrap gap-1 mt-1">
              {#each toolsUsed as tool}
                <span class="inline-flex items-center py-0.5 px-1.5 rounded-full bg-amber-100 text-amber-700 text-[0.5625rem] font-medium">
                  <Icon name="tool" class="w-2 h-2 mr-0.5" />
                  {tool}
                </span>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}
